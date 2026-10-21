/**
 * Unit tests for dsh-skill state persistence and managed-library file helpers.
 * Run: node --test test/state.test.js
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  StateStore,
  customSourceId,
  defaultState,
  expandHome,
  normalizeState,
  resolveDshHome,
  resolveUserPath,
} from '../lib/state.js'
import {
  collectSkillDirectories,
  createManagedSkill,
  importSkills,
  readSkillFile,
  removeManagedSkill,
} from '../lib/skillfiles.js'

/** @returns {Promise<string>} fresh temp directory */
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-skill-test-'))
}

/** Write one fixture skill directory. */
async function writeSkill(root, name, frontmatter, body = 'Do the thing.') {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
  return dir
}

test('expandHome and resolveUserPath expand ~ and reject relative paths', () => {
  assert.equal(expandHome('~'), homedir())
  assert.match(expandHome('~/skills'), /skills$/)
  assert.equal(expandHome('/absolute/path'), '/absolute/path')
  assert.throws(() => resolveUserPath('relative/path'), /absolute/)
  assert.equal(resolveUserPath('/tmp/x'), '/tmp/x')
})

test('resolveDshHome prefers explicit, then DSH_HOME, then ~/.dsh', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-home-env'
    assert.equal(resolveDshHome(), '/tmp/dsh-home-env')
    assert.equal(resolveDshHome('/tmp/explicit'), '/tmp/explicit')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('normalizeState tolerates malformed documents and unknown fields', () => {
  assert.deepEqual(normalizeState(null), defaultState())
  assert.deepEqual(normalizeState([1, 2]), defaultState())
  const normalized = normalizeState({
    version: 99,
    sources: {
      'custom-abc': { path: '/tmp/skills', label: 'Mine', enabled: false },
      broken: { path: 42 },
    },
    autoSources: { 'claude-user': { enabled: false }, junk: 'nope' },
    disabledSkills: ['alpha', 'alpha', 7, ''],
    // Legacy v1 session-selection table: dropped in v2 (explicit invocation).
    sessions: {
      s1: { selected: ['alpha', 'alpha', 5], updatedAt: '2026-01-01T00:00:00.000Z' },
      s2: { selected: null },
      s3: 'not-an-entry',
    },
  })
  assert.equal(normalized.version, 2)
  assert.deepEqual(normalized.sources, {
    'custom-abc': { path: '/tmp/skills', label: 'Mine', enabled: false },
  })
  assert.deepEqual(normalized.autoSources, { 'claude-user': { enabled: false } })
  assert.deepEqual(normalized.disabledSkills, ['alpha'])
  assert.equal(normalized.sessions, undefined, 'legacy session selections are ignored')
})

test('StateStore round-trips state and recovers from a corrupt file', async () => {
  const home = await tempDir()
  const store = new StateStore({ home })
  await store.load()
  assert.deepEqual(store.state, defaultState())
  store.state.disabledSkills.push('demo')
  store.state.sources['custom-1'] = { path: '/tmp/demo', label: 'Demo', enabled: true }
  await store.save()

  const reloaded = new StateStore({ home })
  await reloaded.load()
  assert.deepEqual(reloaded.state.disabledSkills, ['demo'])
  assert.equal(reloaded.state.sources['custom-1'].path, '/tmp/demo')

  await writeFile(reloaded.statePath, '{not json', 'utf8')
  const recovered = new StateStore({ home })
  await recovered.load()
  assert.deepEqual(recovered.state, defaultState())
  await rm(home, { recursive: true, force: true })
})

test('customSourceId is stable and path-derived', () => {
  assert.equal(customSourceId('/tmp/a'), customSourceId('/tmp/a'))
  assert.match(customSourceId('/tmp/a'), /^custom-[0-9a-f]{8}$/)
  assert.notEqual(customSourceId('/tmp/a'), customSourceId('/tmp/b'))
})

test('collectSkillDirectories handles one skill, a parent of skills, and a SKILL.md file', async () => {
  const root = await tempDir()
  const single = await writeSkill(root, 'single-skill', 'name: single-skill\ndescription: A single skill')
  const parent = join(root, 'parent')
  await writeSkill(parent, 'one', 'name: one\ndescription: first')
  await writeSkill(parent, 'two', 'name: two\ndescription: second')

  assert.deepEqual(await collectSkillDirectories(single), [single])
  assert.deepEqual(await collectSkillDirectories(join(single, 'SKILL.md')), [single])
  const fromParent = await collectSkillDirectories(parent)
  assert.deepEqual(fromParent, [join(parent, 'one'), join(parent, 'two')])
  await assert.rejects(collectSkillDirectories(join(root, 'missing')), /does not exist/)
  await rm(root, { recursive: true, force: true })
})

test('importSkills copies a skill directory into the managed library', async () => {
  const root = await tempDir()
  const source = await writeSkill(root, 'superpower-ish', 'name: superpower-ish\ndescription: Imported skill', '# Steps\n\n1. Do it.')
  const libraryDir = join(root, 'library')
  const result = await importSkills({ sourcePath: source, libraryDir })
  assert.equal(result.imported.length, 1)
  assert.equal(result.imported[0].name, 'superpower-ish')
  const copied = await readFile(join(libraryDir, 'superpower-ish', 'SKILL.md'), 'utf8')
  assert.match(copied, /Imported skill/)
  assert.match(copied, /# Steps/)
  await assert.rejects(
    importSkills({ sourcePath: source, libraryDir }),
    /nothing was imported/,
  )
  const overwritten = await importSkills({ sourcePath: source, libraryDir, overwrite: true })
  assert.equal(overwritten.imported.length, 1)
  await rm(root, { recursive: true, force: true })
})

test('createManagedSkill writes valid frontmatter and removeManagedSkill stays inside the library', async () => {
  const root = await tempDir()
  const libraryDir = join(root, 'library')
  const created = await createManagedSkill({
    libraryDir,
    name: 'My New Skill',
    description: 'Explains   things.\nwith newline',
    instructions: '# Do it\n\nStep one.',
    whenToUse: 'When the user asks',
  })
  assert.equal(created.name, 'my-new-skill')
  const parsed = await readSkillFile(created.path)
  assert.equal(parsed.data.name, 'my-new-skill')
  assert.equal(parsed.data.description, 'Explains things. with newline')
  assert.equal(parsed.data.whenToUse, 'When the user asks')
  assert.match(parsed.body, /# Do it/)
  await assert.rejects(
    createManagedSkill({ libraryDir, name: 'my-new-skill', description: 'x', instructions: 'y' }),
    /already exists/,
  )
  await removeManagedSkill({ libraryDir, name: 'my-new-skill' })
  await assert.rejects(readSkillFile(created.path), /not found/)
  await assert.rejects(removeManagedSkill({ libraryDir, name: '../..' }), /invalid/i)
  await rm(root, { recursive: true, force: true })
})
