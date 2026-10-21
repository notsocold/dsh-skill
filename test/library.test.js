/**
 * Integration tests for the library over the real discovery/frontmatter/compat
 * modules, using a hermetic temporary home and temporary skill directories.
 * Run: node --test test/library.test.js
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SkillLibrary } from '../lib/library.js'
import { StateStore } from '../lib/state.js'

/** @returns {Promise<string>} */
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-skill-library-'))
}

/** Write one skill directory below `root`. */
async function writeSkill(root, name, frontmatter, body = 'Do the thing.') {
  const dir = join(root, name)
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
  await writeFile(join(dir, 'scripts', 'helper.sh'), 'echo helper\n', 'utf8')
  return dir
}

/** Build a library whose discovery is isolated from the real home directory. */
async function hermeticLibrary() {
  const root = await tempDir()
  const home = join(root, 'home')
  const dshHome = join(root, 'dsh-home')
  const empty = join(root, 'empty')
  await mkdir(home, { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await mkdir(empty, { recursive: true })
  const previous = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    DSH_HOME: process.env.DSH_HOME,
  }
  process.env.CLAUDE_CONFIG_DIR = empty
  process.env.CODEX_HOME = empty
  process.env.DSH_HOME = dshHome
  const store = new StateStore({ home: dshHome })
  const library = new SkillLibrary({ store, home })
  await library.load()
  return {
    root,
    home,
    library,
    async dispose() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('library discovers a custom source, infers Claude ecosystem and composes the preamble', async () => {
  const env = await hermeticLibrary()
  try {
    const source = join(env.root, '.claude', 'skills')
    await writeSkill(source, 'demo-skill', 'name: demo-skill\ndescription: Says hello.\nallowed-tools: Read, Bash', '# Hello\n\nUse ${CLAUDE_PLUGIN_ROOT}/scripts/helper.sh')
    await env.library.addSource({ path: source })
    const snapshot = await env.library.snapshot({})
    const skill = snapshot.skills.find(entry => entry.name === 'demo-skill')
    assert.ok(skill, 'skill discovered')
    assert.equal(skill.ecosystem, 'claude')
    assert.equal(skill.enabled, true)
    assert.equal(snapshot.stats.total, 1)
    const content = await env.library.skillContent('demo-skill')
    assert.match(content.content, /<skill_compatibility source="claude-code">/)
    assert.match(content.content, /Bash→bash/)
    // This source is not a Claude plugin, so the placeholder cannot be resolved;
    // the preamble says so and the body keeps it verbatim.
    assert.match(content.content, /refers to the root directory of the plugin/)
    assert.match(content.content, /scripts\/helper\.sh/)
  } finally {
    await env.dispose()
  }
})

test('import copies a skill into the managed library, keeps its origin and supports removal', async () => {
  const env = await hermeticLibrary()
  try {
    const source = join(env.root, 'claude-plugins', 'superpowers', 'skills')
    const skillDir = await writeSkill(source, 'brainstorming', 'name: brainstorming\ndescription: Brainstorms ideas.')
    const imported = await env.library.importSkills({ path: skillDir })
    assert.equal(imported.action.imported.length, 1)
    const snapshot = await env.library.snapshot({})
    const skill = snapshot.skills.find(entry => entry.name === 'brainstorming')
    assert.ok(skill)
    assert.equal(skill.sourceId, 'imported')
    assert.equal(skill.ecosystem, 'claude', 'origin sidecar restores the Claude ecosystem')
    await env.library.removeSkill({ name: 'brainstorming' })
    const after = await env.library.snapshot({})
    assert.equal(after.skills.some(entry => entry.name === 'brainstorming'), false)
  } finally {
    await env.dispose()
  }
})

test('every enabled skill is available globally, and global disable hides it', async () => {
  const env = await hermeticLibrary()
  try {
    const source = join(env.root, 'skills')
    await writeSkill(source, 'alpha', 'name: alpha\ndescription: Alpha skill')
    await writeSkill(source, 'beta', 'name: beta\ndescription: Beta skill')
    await env.library.addSource({ path: source })
    const one = env.library
    assert.deepEqual((await one.visibleSkills({})).map(skill => skill.name), ['alpha', 'beta'])
    await one.setSkillEnabled({ name: 'alpha', enabled: false })
    assert.deepEqual((await one.visibleSkills({})).map(skill => skill.name), ['beta'])
    const snapshot = await one.snapshot({})
    assert.deepEqual(snapshot.stats, { total: 2, enabled: 1 })
    assert.equal(snapshot.session, null)
    assert.equal(snapshot.skills.find(skill => skill.name === 'alpha')?.enabled, false)
    await one.setSkillEnabled({ name: 'alpha', enabled: true })
    assert.deepEqual((await one.visibleSkills({})).map(skill => skill.name), ['alpha', 'beta'])
  } finally {
    await env.dispose()
  }
})

test('imported skills win duplicate names and shadowed copies stay visible to management', async () => {
  const env = await hermeticLibrary()
  try {
    const source = join(env.root, 'skills')
    const skillDir = await writeSkill(source, 'duplicate', 'name: duplicate\ndescription: From a source')
    await env.library.addSource({ path: source })
    await env.library.importSkills({ path: skillDir })
    const snapshot = await env.library.snapshot({})
    const rows = snapshot.skills.filter(entry => entry.name === 'duplicate')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].sourceId, 'imported')
    assert.equal(rows[1].shadowedBy, 'imported')
    const visible = await env.library.visibleSkills({})
    assert.equal(visible.filter(entry => entry.name === 'duplicate').length, 1)
    assert.equal(visible[0].sourceId, 'imported')
  } finally {
    await env.dispose()
  }
})

test('source toggles, invalid paths and rescan errors behave', async () => {
  const env = await hermeticLibrary()
  try {
    await assert.rejects(env.library.addSource({ path: 'relative/dir' }), /absolute/)
    await assert.rejects(env.library.addSource({ path: join(env.root, 'missing') }), /does not exist/)
    const source = join(env.root, 'skills')
    await writeSkill(source, 'gamma', 'name: gamma\ndescription: Gamma')
    const added = await env.library.addSource({ path: source })
    const sourceId = added.action.sourceId
    assert.deepEqual((await env.library.visibleSkills({})).map(s => s.name), ['gamma'])
    await env.library.setSourceEnabled({ sourceId, enabled: false })
    assert.deepEqual(await env.library.visibleSkills({}), [])
    const snapshot = await env.library.snapshot({})
    assert.equal(snapshot.sources.find(row => row.id === sourceId)?.enabled, false)
    await env.library.setSourceEnabled({ sourceId, enabled: true })
    assert.deepEqual((await env.library.visibleSkills({})).map(s => s.name), ['gamma'])
    await assert.rejects(env.library.setSkillEnabled({ name: 'nope', enabled: false }), /unknown skill/)
    await assert.rejects(env.library.removeSource({ sourceId: 'imported' }), /no removable source/)
  } finally {
    await env.dispose()
  }
})

test('malformed skills are reported as diagnostics rather than taking the scan down', async () => {
  const env = await hermeticLibrary()
  try {
    const source = join(env.root, 'skills')
    await writeSkill(source, 'good', 'name: good\ndescription: Works')
    const badDir = join(source, 'bad')
    await mkdir(badDir, { recursive: true })
    await writeFile(join(badDir, 'SKILL.md'), 'no frontmatter here', 'utf8')
    await env.library.addSource({ path: source })
    const snapshot = await env.library.snapshot({})
    // The malformed copy is salvaged from its body with a diagnostic instead of
    // disappearing, so management can still see and remove it.
    assert.equal(snapshot.stats.total, 2)
    const bad = snapshot.skills.find(entry => entry.name === 'bad')
    assert.ok(bad)
    assert.ok(bad.diagnostics.length > 0)
    assert.ok(snapshot.skills.some(entry => entry.name === 'good'))
  } finally {
    await env.dispose()
  }
})
