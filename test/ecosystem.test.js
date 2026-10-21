/**
 * Unit tests for the ecosystem modules: YAML-subset frontmatter parsing and
 * normalization, Claude/Codex/agent source discovery and scanning, and the
 * model-facing compatibility preambles.
 *
 * The suite is hermetic: static fixtures live under `test/fixtures/`, and anything
 * that needs a `.git` marker or an unusual tree is created under `os.tmpdir()`.
 *
 * @module dsh-skill/test/ecosystem
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { composeSkillContent } from '../lib/compat.js'
import { candidateSources, scanSource, scanSources } from '../lib/discovery.js'
import { normalizeSkillFrontmatter, parseFrontmatter, slugifySkillName } from '../lib/frontmatter.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const homeFixture = join(fixtures, 'home')
const skillsFixture = join(fixtures, 'skills')
const importedFixture = join(fixtures, 'imported')

/**
 * @param {...string} parts - path segments under `test/fixtures`.
 * @returns {Promise<string>} fixture file text.
 */
async function readFixture(...parts) {
  return await readFile(join(fixtures, ...parts), 'utf8')
}

/**
 * @param {import('node:test').TestContext} context - running test context.
 * @param {string} [prefix] - temp directory prefix.
 * @returns {Promise<string>} created temp directory (cleaned up after the test).
 */
async function tempDir(context, prefix = 'dsh-skill-eco-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/**
 * Write a map of relative path -> content under `root`.
 *
 * @param {string} root - destination directory.
 * @param {Record<string, string>} files - relative paths and contents.
 * @returns {Promise<void>}
 */
async function makeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

/**
 * @param {string} name - skill name.
 * @param {string} description - skill description.
 * @param {string} [body] - Markdown body.
 * @returns {string} SKILL.md content.
 */
function skillMd(name, description, body = 'Body.') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

/**
 * @param {Array<Record<string, any>>} candidates - discovered candidates.
 * @returns {Map<string, Record<string, any>>} candidates keyed by id.
 */
function byId(candidates) {
  return new Map(candidates.map(candidate => [candidate.id, candidate]))
}

describe('parseFrontmatter', () => {
  it('parses quoted scalars, booleans, numbers, inline arrays and comments', async () => {
    const parsed = parseFrontmatter(await readFixture('frontmatter', 'quoted.md'))
    assert.ok(parsed !== undefined)
    assert.equal(parsed.data.name, 'quoted-name')
    assert.equal(parsed.data.description, "It's a quoted description")
    assert.equal(parsed.data.enabled, true)
    assert.equal(parsed.data.disabled, false)
    assert.equal(parsed.data.count, 42)
    assert.equal(parsed.data.ratio, 1.5)
    assert.deepEqual(parsed.data.tags, ['alpha', 'beta gamma', 3])
    assert.equal(parsed.data.url, 'https://example.com/path#fragment')
    assert.equal(parsed.data['comment-value'], 'kept')
    assert.equal(parsed.body, 'Body line.\n')
  })

  it('parses literal and folded block scalars including chomping', async () => {
    const parsed = parseFrontmatter(await readFixture('frontmatter', 'block.md'))
    assert.ok(parsed !== undefined)
    assert.equal(parsed.data.literal, 'line one\nline two\n')
    assert.equal(parsed.data.folded, 'folded one folded two\n')
    assert.equal(parsed.data.strip, 'no newline')
    assert.equal(parsed.data.keep, 'keep newline\n')
    assert.equal(parsed.data.single, 'only line\n')
    assert.equal(parsed.body, 'Block body.\n')
  })

  it('parses simple lists and one level of nested maps', async () => {
    const parsed = parseFrontmatter(await readFixture('frontmatter', 'list.md'))
    assert.ok(parsed !== undefined)
    assert.equal(parsed.data.name, 'list-skill')
    assert.deepEqual(parsed.data['allowed-tools'], ['Bash', 'Read'])
    assert.deepEqual(parsed.data.metadata, { author: 'Test Author', version: 2 })
    assert.equal(parsed.data['argument-hint'], '[path]')
    assert.equal(parsed.body, '# List skill\n\nBody.\n')
  })

  it('tolerates trailing commas in inline arrays', () => {
    const parsed = parseFrontmatter('---\ntags: [a, b,]\n---\n')
    assert.deepEqual(parsed.data.tags, ['a', 'b'])
  })

  it('parses indentless block sequences', () => {
    const parsed = parseFrontmatter(
      '---\nname: indentless\nallowed-tools:\n- Read\n- Grep\ndescription: d\n---\nBody',
    )
    assert.deepEqual(parsed, {
      data: { name: 'indentless', 'allowed-tools': ['Read', 'Grep'], description: 'd' },
      body: 'Body',
    })
  })

  it('returns undefined without frontmatter and for malformed YAML', async () => {
    assert.equal(parseFrontmatter(await readFixture('frontmatter', 'no-frontmatter.md')), undefined)
    assert.equal(parseFrontmatter(await readFixture('frontmatter', 'malformed.md')), undefined)
    assert.equal(parseFrontmatter('---\nname: x\n'), undefined)
  })

  it('accepts empty frontmatter, BOM and CRLF variants', async () => {
    const empty = parseFrontmatter(await readFixture('frontmatter', 'empty.md'))
    assert.deepEqual(empty, { data: {}, body: 'Empty frontmatter body.\n' })
    const crlf = parseFrontmatter('---\r\nname: crlf\r\n---\r\nBody')
    assert.deepEqual(crlf, { data: { name: 'crlf' }, body: 'Body' })
    const bom = parseFrontmatter('\uFEFF---\nname: bom\n---\nBody')
    assert.deepEqual(bom, { data: { name: 'bom' }, body: 'Body' })
  })

  it('ignores unknown lines and unterminated quotes without throwing', () => {
    const parsed = parseFrontmatter('---\nname: x\nrandom garbage\n: :\n---\nBody')
    assert.deepEqual(parsed, { data: { name: 'x' }, body: 'Body' })
    const quoted = parseFrontmatter('---\ndescription: "oops\n---\nBody')
    assert.ok(quoted !== undefined)
    assert.match(String(quoted.data.description), /oops/u)
  })

  it('never throws for pathological input', () => {
    const inputs = [
      undefined,
      null,
      42,
      '',
      '---',
      '---\n',
      '---\n\tname: tab\n---\nBody',
      '---\n"a": [\n---\nB',
      '---\nkey: {a: [1, 2}, b: "x}\n---\n',
      `---\nname: ${'x'.repeat(5000)}\n---\n`,
    ]
    for (const input of inputs) {
      assert.doesNotThrow(() => parseFrontmatter(input), `input: ${String(input).slice(0, 40)}`)
    }
  })
})

describe('slugifySkillName', () => {
  it('normalizes names to lowercase kebab case', () => {
    assert.equal(slugifySkillName('  My Cool_Skill!! '), 'my-cool-skill')
    assert.equal(slugifySkillName('already-kebab'), 'already-kebab')
    assert.equal(slugifySkillName('a__b--c'), 'a-b-c')
    assert.equal(slugifySkillName('Über Café'), 'uber-cafe')
    assert.equal(slugifySkillName(42), '42')
  })

  it('returns an empty string when nothing usable remains', () => {
    assert.equal(slugifySkillName(''), '')
    assert.equal(slugifySkillName('技能'), '')
    assert.equal(slugifySkillName('!!!'), '')
    assert.equal(slugifySkillName(null), '')
    assert.equal(slugifySkillName(true), '')
  })

  it('caps names at 64 characters without a trailing dash', () => {
    const long = slugifySkillName(`${'a'.repeat(60)}-${'b'.repeat(20)}`)
    assert.ok(long.length <= 64)
    assert.ok(!long.endsWith('-'))
    assert.equal(slugifySkillName('x'.repeat(100)).length, 64)
  })
})

describe('normalizeSkillFrontmatter', () => {
  it('normalizes a specification-compliant record without diagnostics', () => {
    const normalized = normalizeSkillFrontmatter({
      data: { name: 'demo-skill', description: 'Demo skill.', whenToUse: 'Use for demos.', license: 'MIT' },
      dirName: 'demo-dir',
      filePath: '/tmp/demo-skill/SKILL.md',
      body: 'Body',
    })
    assert.equal(normalized.name, 'demo-skill')
    assert.equal(normalized.originalName, 'demo-skill')
    assert.equal(normalized.description, 'Demo skill.')
    assert.equal(normalized.whenToUse, 'Use for demos.')
    assert.deepEqual(normalized.invocation, { modelInvocable: true, userInvocable: true })
    assert.deepEqual(normalized.metadata, { license: 'MIT' })
    assert.deepEqual(normalized.diagnostics, [])
  })

  it('accepts whenToUse and when_to_use keys', () => {
    const snake = normalizeSkillFrontmatter({
      data: { name: 'snake', description: 'd', when_to_use: 'snake guidance' },
      dirName: 'snake',
      filePath: '/tmp/snake/SKILL.md',
      body: '',
    })
    assert.equal(snake.whenToUse, 'snake guidance')
    const both = normalizeSkillFrontmatter({
      data: { name: 'both', description: 'd', whenToUse: 'camel', when_to_use: 'snake' },
      dirName: 'both',
      filePath: '/tmp/both/SKILL.md',
      body: '',
    })
    assert.equal(both.whenToUse, 'camel')
    assert.ok(both.diagnostics.some(message => message.includes('both')))
  })

  it('maps legacy Claude invocation aliases with diagnostics', () => {
    const normalized = normalizeSkillFrontmatter({
      data: {
        name: 'legacy',
        description: 'Legacy.',
        disableModelInvocation: true,
        userInvocable: false,
      },
      dirName: 'legacy',
      filePath: '/tmp/legacy/SKILL.md',
      body: '',
    })
    assert.deepEqual(normalized.invocation, { modelInvocable: false, userInvocable: false })
    assert.equal(normalized.diagnostics.length, 2)
    assert.ok(normalized.diagnostics.some(message => message.includes('disableModelInvocation')))
    assert.ok(normalized.diagnostics.some(message => message.includes('userInvocable')))

    const inverted = normalizeSkillFrontmatter({
      data: { name: 'model', description: 'd', modelInvocable: false },
      dirName: 'model',
      filePath: '/tmp/model/SKILL.md',
      body: '',
    })
    assert.equal(inverted.invocation.modelInvocable, false)
    assert.ok(inverted.diagnostics[0].includes('inverted'))
  })

  it('prefers canonical invocation keys over legacy aliases', () => {
    const normalized = normalizeSkillFrontmatter({
      data: {
        name: 'mixed',
        description: 'd',
        'disable-model-invocation': false,
        disableModelInvocation: true,
      },
      dirName: 'mixed',
      filePath: '/tmp/mixed/SKILL.md',
      body: '',
    })
    assert.deepEqual(normalized.invocation, { modelInvocable: true, userInvocable: true })
    assert.ok(normalized.diagnostics.some(message => message.includes('ignoring legacy')))
  })

  it('accepts documented boolean spellings and diagnoses invalid ones', () => {
    const strings = normalizeSkillFrontmatter({
      data: {
        name: 'bools',
        description: 'd',
        'disable-model-invocation': 'yes',
        'user-invocable': 'OFF',
      },
      dirName: 'bools',
      filePath: '/tmp/bools/SKILL.md',
      body: '',
    })
    assert.deepEqual(strings.invocation, { modelInvocable: false, userInvocable: false })
    assert.deepEqual(strings.diagnostics, [])

    const numbers = normalizeSkillFrontmatter({
      data: { name: 'numbers', description: 'd', 'disable-model-invocation': 0, 'user-invocable': 1 },
      dirName: 'numbers',
      filePath: '/tmp/numbers/SKILL.md',
      body: '',
    })
    assert.deepEqual(numbers.invocation, { modelInvocable: true, userInvocable: true })

    const invalid = normalizeSkillFrontmatter({
      data: { name: 'invalid', description: 'd', 'disable-model-invocation': 'maybe' },
      dirName: 'invalid',
      filePath: '/tmp/invalid/SKILL.md',
      body: '',
    })
    assert.equal(invalid.invocation.modelInvocable, true)
    assert.ok(invalid.diagnostics.some(message => message.includes('invalid boolean')))
  })

  it('falls back to the directory name for a missing name', () => {
    const normalized = normalizeSkillFrontmatter({
      data: { description: 'Only a description.' },
      dirName: 'My Skill Dir',
      filePath: '/tmp/My Skill Dir/SKILL.md',
      body: '',
    })
    assert.equal(normalized.name, 'my-skill-dir')
    assert.equal(normalized.originalName, 'My Skill Dir')
    assert.ok(normalized.diagnostics.some(message => message.includes('missing frontmatter name')))
  })

  it('slugifies an invalid name with a diagnostic', () => {
    const normalized = normalizeSkillFrontmatter({
      data: { name: 'Foo Bar!!', description: 'd' },
      dirName: 'foo-bar',
      filePath: '/tmp/foo-bar/SKILL.md',
      body: '',
    })
    assert.equal(normalized.name, 'foo-bar')
    assert.equal(normalized.originalName, 'Foo Bar!!')
    assert.ok(normalized.diagnostics.some(message => message.includes('normalized to')))
  })

  it('derives a missing description from the first body line, truncated to 200 chars', () => {
    const heading = normalizeSkillFrontmatter({
      data: { name: 'derived' },
      dirName: 'derived',
      filePath: '/tmp/derived/SKILL.md',
      body: '\n\n# Heading\nMore text.',
    })
    assert.equal(heading.description, '# Heading')
    assert.ok(heading.diagnostics.some(message => message.includes('derived from the first body line')))

    const long = normalizeSkillFrontmatter({
      data: { name: 'long' },
      dirName: 'long',
      filePath: '/tmp/long/SKILL.md',
      body: 'y'.repeat(250),
    })
    assert.equal(long.description.length, 200)
    assert.equal(long.description, 'y'.repeat(200))
  })

  it('generates a deterministic fallback name when nothing slugifiable exists', () => {
    const input = {
      data: { name: '技能', description: 'd' },
      dirName: '',
      filePath: '/tmp/技能/SKILL.md',
      body: '',
    }
    const first = normalizeSkillFrontmatter(input)
    const second = normalizeSkillFrontmatter(input)
    assert.match(first.name, /^skill-[0-9a-f]{8}$/u)
    assert.equal(first.name, second.name)
    assert.ok(first.diagnostics.some(message => message.includes('fallback name')))
  })

  it('keeps remaining frontmatter keys as JSON-safe metadata', () => {
    const normalized = normalizeSkillFrontmatter({
      data: {
        name: 'meta',
        description: 'd',
        license: 'Apache-2.0',
        'allowed-tools': ['Read', 'Grep'],
        'argument-hint': '[path]',
        metadata: { author: 'test', tags: ['a', 'b'] },
        count: 2,
        flag: true,
      },
      dirName: 'meta',
      filePath: '/tmp/meta/SKILL.md',
      body: '',
    })
    assert.deepEqual(normalized.metadata, {
      license: 'Apache-2.0',
      'allowed-tools': ['Read', 'Grep'],
      'argument-hint': '[path]',
      metadata: { author: 'test', tags: ['a', 'b'] },
      count: 2,
      flag: true,
    })
    assert.deepEqual(JSON.parse(JSON.stringify(normalized.metadata)), normalized.metadata)
  })

  it('refuses prototype-polluting keys and unsupported value types', () => {
    const data = JSON.parse('{"name":"safe","description":"d","__proto__":{"polluted":true}}')
    const normalized = normalizeSkillFrontmatter({ data, dirName: 'safe', filePath: '/tmp/safe/SKILL.md', body: '' })
    assert.equal(Object.hasOwn(normalized.metadata, '__proto__'), false)
    assert.deepEqual(Object.keys(normalized.metadata), [])
    assert.equal({}.polluted, undefined)

    const weird = normalizeSkillFrontmatter({
      data: { name: 'weird', description: { nested: true }, whenToUse: 42 },
      dirName: 'weird',
      filePath: '/tmp/weird/SKILL.md',
      body: 'Fallback body line.',
    })
    assert.equal(weird.description, 'Fallback body line.')
    assert.equal(weird.whenToUse, undefined)
    assert.ok(weird.diagnostics.some(message => message.includes('unsupported type')))
  })

  it('tolerates missing or non-object input', () => {
    assert.doesNotThrow(() => normalizeSkillFrontmatter())
    assert.doesNotThrow(() => normalizeSkillFrontmatter(null))
    const normalized = normalizeSkillFrontmatter({})
    assert.match(normalized.name, /^skill-[0-9a-f]{8}$/u)
    assert.equal(normalized.description, '')
  })
})

describe('candidateSources', () => {
  it('enumerates the existing Claude, Codex, agent and DSH roots', async () => {
    const candidates = await candidateSources({ home: homeFixture, env: {} })
    assert.deepEqual(candidates.map(candidate => candidate.id), [
      'claude-user',
      'claude-plugins:superpowers',
      'codex-user',
      'codex-prompts',
      'codex-plugins:sample-plugin',
      'agents-user',
      'dsh-user',
    ])
    const index = byId(candidates)
    assert.equal(index.get('claude-user').kind, 'claude')
    assert.equal(index.get('claude-user').label, 'Claude Code skills')
    assert.equal(index.get('claude-user').path, join(homeFixture, '.claude', 'skills'))
    assert.equal(index.get('claude-user').skillCount, 1)
    assert.equal(index.get('claude-user').auto, true)
    assert.equal(index.get('claude-user').exists, true)

    assert.equal(index.get('codex-prompts').kind, 'codex')
    assert.equal(index.get('codex-prompts').promptFiles, true)
    assert.equal(index.get('codex-prompts').skillCount, 2)
    assert.equal(index.get('codex-plugins:sample-plugin').skillCount, 1)
    assert.equal(index.get('agents-user').kind, 'agents')
    assert.equal(index.get('dsh-user').kind, 'dsh')
    assert.equal(index.has('claude-desktop'), false)
    assert.equal(index.has('claude-project'), false)
  })

  it('labels plugin-cache sources with the plugin name and root', async () => {
    const candidates = await candidateSources({ home: homeFixture, env: {} })
    const plugin = byId(candidates).get('claude-plugins:superpowers')
    const pluginRoot = join(homeFixture, '.claude', 'plugins', 'cache', 'demo-marketplace', 'superpowers', '1.2.3')
    assert.equal(plugin.label, 'Superpowers (plugin)')
    assert.equal(plugin.plugin, 'Superpowers')
    assert.equal(plugin.path, pluginRoot)
    assert.equal(plugin.pluginRoot, pluginRoot)
    assert.equal(plugin.kind, 'claude')
  })

  it('omits missing roots by default and includes them with includeMissing', async context => {
    const emptyHome = await tempDir(context)
    assert.deepEqual(await candidateSources({ home: emptyHome, env: {} }), [])
    const candidates = await candidateSources({ home: emptyHome, env: {}, includeMissing: true })
    const ids = candidates.map(candidate => candidate.id)
    for (const expected of ['claude-user', 'claude-desktop', 'codex-user', 'codex-prompts', 'agents-user', 'dsh-user']) {
      assert.ok(ids.includes(expected), `missing candidate ${expected}`)
    }
    for (const candidate of candidates) {
      assert.equal(candidate.exists, false)
      assert.equal(candidate.skillCount, 0)
    }
  })

  it('honors CLAUDE_CONFIG_DIR, CODEX_HOME and DSH_HOME', async context => {
    const root = await tempDir(context)
    const claudeDir = join(root, 'claude-config')
    const codexHome = join(root, 'codex-home')
    const dshHome = join(root, 'dsh-home')
    await makeTree(claudeDir, { 'skills/env-skill/SKILL.md': skillMd('env-skill', 'Env skill.') })
    await makeTree(codexHome, { 'skills/env-codex/SKILL.md': skillMd('env-codex', 'Env codex.') })
    await makeTree(dshHome, { 'skills/env-dsh/SKILL.md': skillMd('env-dsh', 'Env dsh.') })
    const candidates = await candidateSources({
      home: join(root, 'home'),
      env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome, DSH_HOME: dshHome },
    })
    const index = byId(candidates)
    assert.equal(index.get('claude-user').path, join(claudeDir, 'skills'))
    assert.equal(index.get('codex-user').path, join(codexHome, 'skills'))
    assert.equal(index.get('dsh-user').path, join(dshHome, 'skills'))
    assert.equal(index.get('claude-user').skillCount, 1)
  })

  it('maps caller-provided custom sources, including the imported library', async context => {
    const root = await tempDir(context)
    const custom = await candidateSources({
      home: join(root, 'home'),
      env: {},
      customSources: [
        { id: 'custom-abc12345', path: importedFixture, label: 'Imported folder', enabled: true },
        { id: 'imported', path: importedFixture },
        { id: 'custom-missing', path: join(root, 'nope') },
      ],
    })
    const index = byId(custom)
    assert.equal(index.get('custom-abc12345').kind, 'custom')
    assert.equal(index.get('custom-abc12345').label, 'Imported folder')
    assert.equal(index.get('custom-abc12345').auto, false)
    assert.equal(index.get('custom-abc12345').skillCount, 1)
    assert.equal(index.get('imported').kind, 'imported')
    assert.equal(index.get('imported').label, 'Imported skills')
    assert.equal(index.get('custom-missing').exists, false)
    assert.equal(index.get('custom-missing').skillCount, 0)
  })

  it('expands ~/ in custom source paths against the supplied home', async context => {
    const home = join(await tempDir(context), 'home')
    await makeTree(home, { 'custom-skills/tilde-skill/SKILL.md': skillMd('tilde-skill', 'Tilde skill.') })
    const candidates = await candidateSources({
      home,
      env: {},
      customSources: [{ id: 'custom-tilde01', path: '~/custom-skills' }],
    })
    const candidate = byId(candidates).get('custom-tilde01')
    assert.equal(candidate.path, join(home, 'custom-skills'))
    assert.equal(candidate.skillCount, 1)
  })

  it('resolves the nearest ancestor containing .git for project sources', async context => {
    const root = await tempDir(context)
    const project = join(root, 'project')
    const cwd = join(project, 'src', 'deep')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await makeTree(project, {
      '.claude/skills/proj-claude/SKILL.md': skillMd('proj-claude', 'Project Claude skill.'),
      '.codex/skills/proj-codex/SKILL.md': skillMd('proj-codex', 'Project Codex skill.'),
      '.agents/skills/proj-agents/SKILL.md': skillMd('proj-agents', 'Project agent skill.'),
      '.dsh/skills/proj-dsh/SKILL.md': skillMd('proj-dsh', 'Project DSH skill.'),
    })
    const candidates = await candidateSources({ cwd, home: join(root, 'home'), env: {} })
    const index = byId(candidates)
    assert.equal(index.get('claude-project').path, join(project, '.claude', 'skills'))
    assert.equal(index.get('codex-project').path, join(project, '.codex', 'skills'))
    assert.equal(index.get('agents-project').path, join(project, '.agents', 'skills'))
    assert.equal(index.get('dsh-project').path, join(project, '.dsh', 'skills'))
    for (const id of ['claude-project', 'codex-project', 'agents-project', 'dsh-project']) {
      assert.equal(index.get(id).skillCount, 1)
    }
    const scanned = await scanSources(candidates)
    const names = scanned.skills.map(skill => skill.name).sort()
    assert.deepEqual(names, ['proj-agents', 'proj-claude', 'proj-codex', 'proj-dsh'])
  })

  it('uses cwd itself as the project root when no ancestor has .git', async context => {
    const root = await tempDir(context)
    const cwd = join(root, 'plain-workspace')
    await makeTree(cwd, { '.claude/skills/plain-skill/SKILL.md': skillMd('plain-skill', 'Plain skill.') })
    const candidates = await candidateSources({ cwd, home: join(root, 'home'), env: {} })
    assert.equal(byId(candidates).get('claude-project').path, join(cwd, '.claude', 'skills'))
  })

  it('omits project sources when cwd is not known', async () => {
    const candidates = await candidateSources({ home: homeFixture, env: {} })
    assert.ok(candidates.every(candidate => !candidate.id.endsWith('-project')))
  })

  it('produces deterministic output across calls', async () => {
    const first = await candidateSources({ home: homeFixture, env: {} })
    const second = await candidateSources({ home: homeFixture, env: {} })
    assert.deepEqual(second, first)
  })
})

describe('scanSource', () => {
  it('scans a directory root deterministically and skips hidden/node_modules dirs', async () => {
    const source = {
      id: 'test-root',
      path: skillsFixture,
      kind: 'custom',
      label: 'Test root',
      auto: false,
      exists: true,
      skillCount: 0,
    }
    const result = await scanSource(source)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.skills.map(skill => skill.name), [
      'alpha',
      'beta-skill',
      'delta',
      'legacy-dir',
      'malformed',
    ])
    const alpha = result.skills[0]
    assert.equal(alpha.originalName, 'alpha')
    assert.equal(alpha.description, 'Alpha skill for testing discovery.')
    assert.equal(alpha.whenToUse, 'When alpha behavior is needed.')
    assert.deepEqual(alpha.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(alpha.sourceId, 'test-root')
    assert.equal(alpha.kind, 'custom')
    assert.equal(alpha.ecosystem, 'custom')
    assert.equal(alpha.path, join(skillsFixture, 'alpha', 'SKILL.md'))
    assert.equal(alpha.dir, join(skillsFixture, 'alpha'))
    assert.equal(alpha.content, '# Alpha\n\nBody of alpha.')
    assert.deepEqual(alpha.metadata, {
      'allowed-tools': ['Read', 'Grep'],
      license: 'MIT',
      metadata: { author: 'test' },
    })
    assert.deepEqual(alpha.diagnostics, [])

    const beta = result.skills[1]
    assert.equal(beta.name, 'beta-skill')
    assert.deepEqual(beta.invocation, { modelInvocable: false, userInvocable: false })
    assert.deepEqual(beta.metadata, { 'argument-hint': '[file]' })
    assert.ok(beta.diagnostics.length >= 2)

    const legacy = result.skills[3]
    assert.equal(legacy.name, 'legacy-dir')
    assert.equal(legacy.description, '# Legacy')
    assert.ok(legacy.diagnostics.some(message => message.includes('missing frontmatter description')))

    const malformed = result.skills[4]
    assert.equal(malformed.name, 'malformed')
    assert.equal(malformed.content, 'Malformed frontmatter body.')
    assert.match(malformed.diagnostics[0], /could not be parsed/u)
  })

  it('scans Codex prompt files, one skill per top-level markdown file', async () => {
    const source = {
      id: 'codex-prompts',
      path: join(homeFixture, '.codex', 'prompts'),
      kind: 'codex',
      label: 'Codex custom prompts',
      auto: true,
      exists: true,
      skillCount: 2,
    }
    const result = await scanSource(source)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.skills.map(skill => skill.name), ['review', 'summarize'])
    const review = result.skills[0]
    assert.equal(review.ecosystem, 'codex')
    assert.equal(review.dir, join(homeFixture, '.codex', 'prompts'))
    assert.equal(review.description, 'Review local changes.')
    assert.deepEqual(review.metadata, { 'argument-hint': '[path]' })
    assert.equal(review.content, 'Review the changes in $ARGUMENTS.')
    assert.ok(review.diagnostics.some(message => message.includes('missing frontmatter name')))

    const summarize = result.skills[1]
    assert.equal(summarize.name, 'summarize')
    assert.equal(summarize.description, 'Summarize $1 in three bullets.')
    assert.equal(summarize.content, 'Summarize $1 in three bullets.')
  })

  it('sets pluginRoot for plugin-cache skills discovered through candidateSources', async () => {
    const candidates = await candidateSources({ home: homeFixture, env: {} })
    const scanned = await scanSources(candidates)
    assert.deepEqual(scanned.errors, [])
    const plugin = scanned.skills.find(skill => skill.name === 'plugin-skill')
    assert.ok(plugin !== undefined)
    const pluginRoot = join(homeFixture, '.claude', 'plugins', 'cache', 'demo-marketplace', 'superpowers', '1.2.3')
    assert.equal(plugin.sourceId, 'claude-plugins:superpowers')
    assert.equal(plugin.ecosystem, 'claude')
    assert.equal(plugin.pluginRoot, pluginRoot)
    assert.equal(plugin.dir, join(pluginRoot, 'skills', 'plugin-skill'))
    const codexPlugin = scanned.skills.find(skill => skill.name === 'codex-plugin-skill')
    assert.equal(codexPlugin.pluginRoot, join(homeFixture, '.codex', 'plugins', 'sample-plugin'))
    assert.deepEqual(scanned.skills.map(skill => skill.name).sort(), [
      'agent-skill',
      'codex-plugin-skill',
      'codex-skill',
      'dsh-skill',
      'plugin-skill',
      'review',
      'summarize',
      'user-skill',
    ])
  })

  it('returns no skills and no errors for a missing root', async () => {
    const result = await scanSource({
      id: 'missing-source',
      path: join(tmpdir(), `dsh-skill-missing-${process.pid}-${Date.now()}`),
      kind: 'custom',
      label: 'Missing',
      auto: false,
      exists: false,
      skillCount: 0,
    })
    assert.deepEqual(result, { skills: [], errors: [] })
  })

  it('reports invalid entries as errors instead of throwing', async context => {
    const root = await tempDir(context)
    await mkdir(join(root, 'broken', 'SKILL.md'), { recursive: true })
    await makeTree(root, { 'ok/SKILL.md': skillMd('ok', 'Okay.') })
    const result = await scanSource({
      id: 'broken-source',
      path: root,
      kind: 'custom',
      label: 'Broken',
      auto: false,
      exists: true,
      skillCount: 0,
    })
    assert.deepEqual(result.skills.map(skill => skill.name), ['ok'])
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].sourceId, 'broken-source')
    assert.ok(result.errors[0].path.endsWith(join('broken', 'SKILL.md')))
    assert.match(result.errors[0].message, /not a regular file/u)
  })

  it('reports a file source path as an error', async context => {
    const root = await tempDir(context)
    const file = join(root, 'skills.md')
    await writeFile(file, '# Not a source directory\n', 'utf8')
    const result = await scanSource({ id: 'file-source', path: file, kind: 'custom', label: 'File', auto: false, exists: true, skillCount: 0 })
    assert.equal(result.skills.length, 0)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0].message, /not a directory/u)
  })

  it('bounds recursive discovery to the configured depth', async context => {
    const root = await tempDir(context)
    const chain = ['a', 'b', 'c', 'd', 'e']
    await makeTree(root, {
      [`${chain.join('/')}/skill-ok/SKILL.md`]: skillMd('skill-ok', 'Depth six.'),
      [`${chain.join('/')}/f/skill-too-deep/SKILL.md`]: skillMd('skill-too-deep', 'Depth seven.'),
    })
    const result = await scanSource({
      id: 'depth-source',
      path: root,
      kind: 'custom',
      label: 'Depth',
      auto: false,
      exists: true,
      skillCount: 0,
    })
    assert.deepEqual(result.skills.map(skill => skill.name), ['skill-ok'])
  })
})

describe('scanSources', () => {
  it('merges sources in input order and combines errors', async context => {
    const root = await tempDir(context)
    await makeTree(root, {
      'first/zeta/SKILL.md': skillMd('zeta', 'Zeta skill.'),
      'second/alpha/SKILL.md': skillMd('alpha', 'Alpha skill.'),
      'second/broken/SKILL.md/placeholder.txt': 'not a file',
    })
    const sources = [
      { id: 'first-source', path: join(root, 'first'), kind: 'custom', label: 'First', auto: false, exists: true, skillCount: 1 },
      { id: 'second-source', path: join(root, 'second'), kind: 'custom', label: 'Second', auto: false, exists: true, skillCount: 2 },
    ]
    const result = await scanSources(sources)
    assert.deepEqual(result.skills.map(skill => skill.name), ['zeta', 'alpha'])
    assert.deepEqual(result.skills.map(skill => skill.sourceId), ['first-source', 'second-source'])
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].sourceId, 'second-source')
  })

  it('never throws for empty, malformed or missing source lists', async () => {
    assert.deepEqual(await scanSources([]), { skills: [], errors: [] })
    assert.deepEqual(await scanSources(undefined), { skills: [], errors: [] })
    assert.doesNotThrow(() => scanSources([null, 42, {}]))
    const result = await scanSources([null, { id: 'no-path', kind: 'custom' }])
    assert.equal(result.skills.length, 0)
    assert.ok(result.errors.length >= 1)
  })
})

describe('composeSkillContent', () => {
  it('prepends the Claude Code tool mapping and substitutes the plugin root in the body', () => {
    const composed = composeSkillContent({
      name: 'claude-demo',
      ecosystem: 'claude',
      pluginRoot: '/plugin/root',
      content: 'Run ${CLAUDE_PLUGIN_ROOT}/scripts/a.sh with $ARGUMENTS.',
    })
    const marker = '</skill_compatibility>'
    const preamble = composed.slice(0, composed.indexOf(marker) + marker.length)
    assert.ok(composed.startsWith('<skill_compatibility source="claude-code">'))
    assert.ok(preamble.split('\n').length <= 12)
    for (const mapping of [
      'Bash→bash',
      'Read→read',
      'Edit→edit',
      'Write→write',
      'Glob→glob',
      'Grep→grep',
      'WebFetch→web_fetch',
      'WebSearch→web_search',
      'Task→subagent',
      'TodoWrite→todo_write',
      'AskUserQuestion→ask_user_question',
      'ExitPlanMode→exit_plan_mode',
      'Skill→skill',
    ]) {
      assert.ok(preamble.includes(mapping), `missing mapping ${mapping}`)
    }
    assert.ok(preamble.includes('$ARGUMENTS'))
    assert.ok(preamble.includes('${CLAUDE_PLUGIN_ROOT}'))
    assert.ok(preamble.includes('/plugin/root'))
    assert.ok(preamble.includes('not installed'))
    assert.equal(composed.slice(preamble.length), '\n\nRun /plugin/root/scripts/a.sh with $ARGUMENTS.')
  })

  it('keeps the placeholder when the plugin root is unknown', () => {
    const composed = composeSkillContent({
      ecosystem: 'claude',
      content: 'Use ${CLAUDE_PLUGIN_ROOT}/refs/x.md.',
    })
    assert.ok(composed.endsWith('Use ${CLAUDE_PLUGIN_ROOT}/refs/x.md.'))
    assert.ok(composed.includes('root directory of the plugin'))
    assert.ok(!composed.includes('undefined'))
  })

  it('never substitutes $ARGUMENTS and leaves empty bodies as a bare preamble', () => {
    const composed = composeSkillContent({ ecosystem: 'claude', content: '' })
    assert.ok(composed.startsWith('<skill_compatibility source="claude-code">'))
    assert.ok(composed.endsWith('</skill_compatibility>'))
  })

  it('adds the Codex prompt preamble and keeps the body unchanged', () => {
    const composed = composeSkillContent({ ecosystem: 'codex', content: 'Handle $ARGUMENTS and $1.' })
    assert.ok(composed.startsWith('<skill_compatibility source="codex">'))
    assert.ok(composed.includes('`$ARGUMENTS`'))
    const marker = '</skill_compatibility>'
    const preamble = composed.slice(0, composed.indexOf(marker) + marker.length)
    assert.ok(preamble.split('\n').length <= 12)
    assert.equal(composed.slice(preamble.length), '\n\nHandle $ARGUMENTS and $1.')
  })

  it('leaves native ecosystems completely unchanged', () => {
    for (const ecosystem of ['agents', 'custom', 'imported', 'dsh']) {
      const content = `# ${ecosystem}\n\nBody with $ARGUMENTS.`
      assert.equal(composeSkillContent({ name: 'native', ecosystem, content }), content)
    }
  })

  it('falls back to kind for records without an ecosystem field', () => {
    const composed = composeSkillContent({ kind: 'claude', content: 'Body.' })
    assert.ok(composed.startsWith('<skill_compatibility source="claude-code">'))
  })

  it('tolerates malformed skill records', () => {
    assert.equal(composeSkillContent(undefined), '')
    assert.equal(composeSkillContent(null), '')
    assert.equal(composeSkillContent({}), '')
    assert.equal(composeSkillContent({ ecosystem: 'agents' }), '')
    assert.equal(composeSkillContent({ ecosystem: 'codex', content: 42 }), composeSkillContent({ ecosystem: 'codex', content: '' }))
  })
})
