/**
 * Claude / Codex / Agent-Skills ecosystem source discovery and scanning.
 *
 * Discovery is filesystem-only: it never shells out, never touches the network and
 * never throws for unreadable or missing paths. The host library first calls
 * {@link candidateSources} to enumerate the roots present on this machine, then
 * {@link scanSources} to read the skills inside them.
 *
 * Walks are deterministic (entries are always name-sorted) and bounded
 * ({@link MAX_WALK_DEPTH} levels / {@link MAX_WALK_ENTRIES} entries per source), so
 * a pathological plugin cache cannot stall a scan.
 *
 * @module dsh-skill/lib/discovery
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { normalizeSkillFrontmatter, parseFrontmatter, slugifySkillName } from './frontmatter.js'

const SKILL_FILE = 'SKILL.md'
const MAX_WALK_DEPTH = 6
const MAX_WALK_ENTRIES = 2000
const MAX_PLUGIN_ROOT_DEPTH = 8
const SKIP_DIRECTORY_NAMES = new Set(['node_modules', '.git'])
const SEMVER_DIRECTORY = /^v?\d+\.\d+\.\d+(?:[-+].*)?$/u
const FENCE_LINE = /^---[ \t]*$/u
const VALID_KINDS = new Set(['claude', 'codex', 'agents', 'dsh', 'custom', 'imported'])

/**
 * @typedef {'claude' | 'codex' | 'agents' | 'dsh' | 'custom' | 'imported'} EcosystemKind
 */

/**
 * One directory that may contain skills.
 *
 * @typedef {object} SourceCandidate
 * @property {string} id - stable source id (never contains a path).
 * @property {string} path - absolute directory.
 * @property {EcosystemKind} kind - ecosystem bucket.
 * @property {string} label - human label.
 * @property {boolean} auto - true for auto-detected roots.
 * @property {boolean} exists - whether the directory exists.
 * @property {number} skillCount - number of skills found (0 when missing).
 * @property {string} [plugin] - plugin name for plugin-cache sources.
 * @property {string} [pluginRoot] - absolute plugin root for `${CLAUDE_PLUGIN_ROOT}`.
 * @property {boolean} [promptFiles] - source scans top-level `*.md` prompt files.
 */

/**
 * One discovered skill before the library attaches selection state.
 *
 * @typedef {object} RawSkill
 * @property {string} name - normalized kebab-case name.
 * @property {string} originalName - name as authored (or the directory/file name).
 * @property {string} description - routing description.
 * @property {string} [whenToUse] - optional extra routing guidance.
 * @property {{ modelInvocable: boolean, userInvocable: boolean }} invocation - policy.
 * @property {string} sourceId - owning source id.
 * @property {EcosystemKind} kind - ecosystem bucket (source kind).
 * @property {EcosystemKind} ecosystem - ecosystem bucket (source kind).
 * @property {string} path - absolute `SKILL.md` / prompt file path.
 * @property {string} dir - absolute skill directory (prompt dir for prompt files).
 * @property {string} [pluginRoot] - absolute plugin root, when known.
 * @property {Record<string, unknown>} metadata - remaining JSON-safe frontmatter keys.
 * @property {string[]} diagnostics - tolerated deviations.
 * @property {string} content - body without frontmatter, trimmed.
 */

/**
 * @typedef {{ path: string, message: string, sourceId: string }} ScanError
 */

/**
 * Enumerate auto-detected and custom sources for the current machine/session.
 *
 * Auto candidates that do not exist are omitted unless `includeMissing` is true;
 * caller-provided (`customSources`) candidates are always returned so a broken
 * user source can still be displayed and removed. Results are deterministic.
 *
 * Never throws: unreadable roots are skipped.
 *
 * @param {{
 *   cwd?: string,
 *   customSources?: Array<{ id?: string, path: string, label?: string, enabled?: boolean, kind?: string,
 *                           auto?: boolean, promptFiles?: boolean }>,
 *   home?: string,
 *   env?: Record<string, string | undefined>,
 *   includeMissing?: boolean,
 * }} [options] - discovery context. `env` is a test/embedding override for
 *   `process.env`; `home` overrides `os.homedir()`.
 * @returns {Promise<SourceCandidate[]>} candidate sources in deterministic order.
 */
export async function candidateSources(options = {}) {
  const input = isRecord(options) ? options : {}
  const env = isRecord(input.env) ? input.env : process.env
  const defaultHome = homedir()
  const home = typeof input.home === 'string' && input.home.trim() !== ''
    ? resolveUserPath(input.home, defaultHome)
    : defaultHome
  const includeMissing = input.includeMissing === true
  /** @type {SourceCandidate[]} */
  const candidates = []

  try {
    const claudeRoot = envPath(env, 'CLAUDE_CONFIG_DIR', defaultHome) ?? join(home, '.claude')
    const codexHome = envPath(env, 'CODEX_HOME', defaultHome) ?? join(home, '.codex')
    const dshHome = envPath(env, 'DSH_HOME', defaultHome) ?? join(home, '.dsh')
    const appData = envPath(env, 'APPDATA', defaultHome) ?? join(home, 'AppData', 'Roaming')
    const cwdKnown = typeof input.cwd === 'string' && input.cwd.trim() !== ''
    const projectRoot = cwdKnown ? await findProjectRoot(input.cwd) : undefined

    /** @type {Array<Record<string, unknown> & { id: string, path: string, kind: EcosystemKind, label: string, auto: boolean }>} */
    const specs = []
    specs.push(sourceSpec('claude-user', join(claudeRoot, 'skills'), 'claude', 'Claude Code skills'))
    const desktop = await findClaudeDesktopCandidate(home, appData, includeMissing)
    if (desktop !== undefined) specs.push(desktop)
    specs.push(...await findClaudePluginSpecs(claudeRoot))
    if (projectRoot !== undefined) {
      specs.push(sourceSpec('claude-project', join(projectRoot, '.claude', 'skills'), 'claude', 'Project Claude skills'))
    }
    specs.push(sourceSpec('codex-user', join(codexHome, 'skills'), 'codex', 'Codex skills'))
    specs.push({
      ...sourceSpec('codex-prompts', join(codexHome, 'prompts'), 'codex', 'Codex custom prompts'),
      promptFiles: true,
    })
    specs.push(...await findCodexPluginSpecs(codexHome))
    if (projectRoot !== undefined) {
      specs.push(sourceSpec('codex-project', join(projectRoot, '.codex', 'skills'), 'codex', 'Project Codex skills'))
    }
    specs.push(sourceSpec('agents-user', join(home, '.agents', 'skills'), 'agents', 'Agent skills'))
    if (projectRoot !== undefined) {
      specs.push(sourceSpec('agents-project', join(projectRoot, '.agents', 'skills'), 'agents', 'Project agent skills'))
    }
    specs.push(sourceSpec('dsh-user', join(dshHome, 'skills'), 'dsh', 'DSH skills'))
    if (projectRoot !== undefined) {
      specs.push(sourceSpec('dsh-project', join(projectRoot, '.dsh', 'skills'), 'dsh', 'Project DSH skills'))
    }

    for (const spec of specs) {
      try {
        const candidate = await describeCandidate(spec, includeMissing)
        if (candidate !== undefined) candidates.push(candidate)
      } catch {
        // A single broken root must not hide the rest of the discovered sources.
      }
    }
  } catch {
    // Never throw: partial discovery is better than no sources.
  }

  const customSources = Array.isArray(input.customSources) ? input.customSources : []
  for (const custom of customSources) {
    try {
      const candidate = await describeCustomCandidate(custom, home)
      if (candidate !== undefined) candidates.push(candidate)
    } catch {
      // Skip malformed custom source entries; the state file remains authoritative.
    }
  }
  return dedupeCandidates(candidates)
}

/**
 * Scan one source for skills.
 *
 * Directory sources contribute each child (at any depth within the walk bound)
 * that contains a `SKILL.md`. Codex prompt sources contribute top-level `*.md`
 * files, one skill per file. Missing roots return no skills and no errors (the
 * candidate already carries `exists: false`); other per-entry failures are
 * collected in `errors` instead of throwing.
 *
 * @param {SourceCandidate} source - source to scan.
 * @returns {Promise<{ skills: RawSkill[], errors: ScanError[] }>} discovered skills
 *   sorted by name then path, plus collected errors.
 */
export async function scanSource(source) {
  /** @type {RawSkill[]} */
  const skills = []
  /** @type {ScanError[]} */
  const errors = []
  if (!isRecord(source)) return { skills, errors }
  const sourceId = typeof source.id === 'string' ? source.id : ''
  if (typeof source.path !== 'string' || source.path === '') {
    errors.push({ path: '', message: 'source has no path', sourceId })
    return { skills, errors }
  }
  const root = resolve(source.path)
  const rootInfo = await statPath(root)
  if (!rootInfo.exists) return { skills, errors }
  if (!rootInfo.isDirectory) {
    errors.push({ path: root, message: 'source path is not a directory', sourceId })
    return { skills, errors }
  }

  const kind = sourceKind(source)
  const promptMode = source.promptFiles === true || sourceId === 'codex-prompts'
  const pluginRoot = await resolveSourcePluginRoot(source)
  const context = /** @type {const} */ ({ sourceId, kind, promptRoot: root, pluginRoot })

  if (promptMode) {
    await scanPromptFiles(context, skills, errors)
  } else {
    const collected = await collectSkillDirectories(root, sourceId)
    errors.push(...collected.errors)
    for (const directory of collected.directories) {
      const filePath = join(directory, SKILL_FILE)
      const read = await readText(filePath)
      if (read.error !== undefined) {
        errors.push({ path: filePath, message: errorMessage(read.error), sourceId })
        continue
      }
      skills.push(buildRawSkill(read.text, {
        sourceId,
        kind,
        filePath,
        dir: directory,
        dirName: basename(directory),
        pluginRoot,
      }))
    }
  }

  skills.sort(compareSkills)
  errors.sort(compareErrors)
  return { skills, errors }
}

/**
 * Scan many sources sequentially, merging in input order.
 *
 * @param {SourceCandidate[]} sources - candidates to scan.
 * @returns {Promise<{ skills: RawSkill[], errors: ScanError[] }>} merged results;
 *   this function never throws.
 */
export async function scanSources(sources) {
  /** @type {RawSkill[]} */
  const skills = []
  /** @type {ScanError[]} */
  const errors = []
  if (!Array.isArray(sources)) return { skills, errors }
  for (const source of sources) {
    try {
      const result = await scanSource(source)
      skills.push(...result.skills)
      errors.push(...result.errors)
    } catch (error) {
      errors.push({
        path: isRecord(source) && typeof source.path === 'string' ? source.path : '',
        message: errorMessage(error),
        sourceId: isRecord(source) && typeof source.id === 'string' ? source.id : '',
      })
    }
  }
  return { skills, errors }
}

// ---------------------------------------------------------------------------
// Candidate enumeration
// ---------------------------------------------------------------------------

/**
 * @param {string} id - source id.
 * @param {string} sourcePath - absolute directory.
 * @param {EcosystemKind} kind - ecosystem.
 * @param {string} label - human label.
 * @returns {{ id: string, path: string, kind: EcosystemKind, label: string, auto: boolean }} spec.
 */
function sourceSpec(id, sourcePath, kind, label) {
  return { id, path: sourcePath, kind, label, auto: true }
}

/**
 * Turn one candidate spec into a full SourceCandidate, probing the filesystem.
 *
 * @param {Record<string, any>} spec - candidate spec from candidateSources.
 * @param {boolean} includeMissing - whether to keep non-existing roots.
 * @returns {Promise<SourceCandidate | undefined>} candidate, or `undefined` when the
 *   root is absent and missing roots are omitted.
 */
async function describeCandidate(spec, includeMissing) {
  const sourcePath = resolve(spec.path)
  const exists = await isDirectory(sourcePath)
  if (!exists && !includeMissing) return undefined
  let skillCount = 0
  if (exists) {
    skillCount = spec.promptFiles === true
      ? await countPromptFiles(sourcePath)
      : (await collectSkillDirectories(sourcePath, spec.id)).directories.length
  }
  /** @type {SourceCandidate} */
  const candidate = {
    id: spec.id,
    path: sourcePath,
    kind: spec.kind,
    label: spec.label,
    auto: spec.auto !== false,
    exists,
    skillCount,
  }
  if (typeof spec.plugin === 'string') candidate.plugin = spec.plugin
  if (typeof spec.pluginRoot === 'string') candidate.pluginRoot = spec.pluginRoot
  if (spec.promptFiles === true) candidate.promptFiles = true
  return candidate
}

/**
 * First existing Claude Desktop skill root (platform candidates, contract order).
 *
 * @param {string} home - user home directory.
 * @param {string} appData - Windows roaming AppData directory.
 * @param {boolean} includeMissing - whether to emit a placeholder when nothing exists.
 * @returns {Promise<Record<string, any> | undefined>} candidate spec.
 */
async function findClaudeDesktopCandidate(home, appData, includeMissing) {
  const paths = [
    join(home, 'Documents', 'Claude', 'Skills'),
    join(home, 'Library', 'Application Support', 'Claude', 'skills'),
    join(home, 'Library', 'Application Support', 'Claude', 'Skills'),
    join(home, '.config', 'Claude', 'skills'),
    join(home, '.config', 'Claude', 'Skills'),
    join(appData, 'Claude', 'skills'),
    join(appData, 'Claude', 'Skills'),
  ]
  for (const candidatePath of paths) {
    if (await isDirectory(candidatePath)) {
      return sourceSpec('claude-desktop', candidatePath, 'claude', 'Claude Desktop skills')
    }
  }
  if (!includeMissing) return undefined
  const platformPath = process.platform === 'win32'
    ? join(appData, 'Claude', 'skills')
    : process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Claude', 'skills')
      : join(home, '.config', 'Claude', 'skills')
  return sourceSpec('claude-desktop', platformPath, 'claude', 'Claude Desktop skills')
}

/**
 * Find plugin-cache skill sources under a Claude `plugins/` directory.
 *
 * @param {string} claudeRoot - Claude configuration directory (`~/.claude`).
 * @returns {Promise<Array<Record<string, any>>>} one spec per plugin root.
 */
async function findClaudePluginSpecs(claudeRoot) {
  const pluginsRoot = join(claudeRoot, 'plugins')
  if (!(await isDirectory(pluginsRoot))) return []
  const pluginRoots = await findPluginRoots(pluginsRoot, dir => resolveClaudePluginRoot(dir, pluginsRoot))
  /** @type {Array<Record<string, any>>} */
  const specs = []
  for (const pluginRoot of pluginRoots) {
    const name = await readClaudePluginName(pluginRoot)
    specs.push({
      id: `claude-plugins:${slugifySkillName(name) || hash8(pluginRoot)}`,
      path: pluginRoot,
      kind: 'claude',
      label: `${name} (plugin)`,
      auto: true,
      plugin: name,
      pluginRoot,
    })
  }
  specs.sort((left, right) => compareStrings(left.id, right.id) || compareStrings(left.path, right.path))
  return dedupeById(specs)
}

/**
 * Find plugin skill sources under a Codex `plugins/` directory.
 *
 * @param {string} codexHome - Codex home directory (`~/.codex`).
 * @returns {Promise<Array<Record<string, any>>>} one spec per plugin folder.
 */
async function findCodexPluginSpecs(codexHome) {
  const pluginsRoot = join(codexHome, 'plugins')
  if (!(await isDirectory(pluginsRoot))) return []
  const pluginRoots = await findPluginRoots(pluginsRoot, skillsDir => dirname(skillsDir))
  /** @type {Array<Record<string, any>>} */
  const specs = []
  for (const pluginRoot of pluginRoots) {
    const name = await readPluginFolderName(pluginRoot)
    specs.push({
      id: `codex-plugins:${slugifySkillName(name) || hash8(pluginRoot)}`,
      path: pluginRoot,
      kind: 'codex',
      label: `${name} (Codex plugin)`,
      auto: true,
      plugin: name,
      pluginRoot,
    })
  }
  specs.sort((left, right) => compareStrings(left.id, right.id) || compareStrings(left.path, right.path))
  return dedupeById(specs)
}

/**
 * Deep bounded search for directories named `skills` that actually contain skills.
 *
 * @param {string} pluginsRoot - root of the plugin cache tree.
 * @param {(skillsDir: string) => Promise<string>} resolveRoot - maps a `skills`
 *   directory to its plugin root.
 * @returns {Promise<string[]>} distinct plugin roots, path-sorted.
 */
async function findPluginRoots(pluginsRoot, resolveRoot) {
  /** @type {Set<string>} */
  const pluginRoots = new Set()
  /** @type {Array<{ dir: string, depth: number }>} */
  const queue = [{ dir: pluginsRoot, depth: 0 }]
  const seen = new Set()
  let examined = 0
  while (queue.length > 0) {
    const current = queue.shift()
    if (seen.has(current.dir) || current.depth > MAX_WALK_DEPTH) continue
    seen.add(current.dir)
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((left, right) => compareStrings(left.name, right.name))
    for (const entry of entries) {
      if (examined >= MAX_WALK_ENTRIES) {
        queue.length = 0
        break
      }
      examined += 1
      if (SKIP_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith('.')) continue
      const child = join(current.dir, entry.name)
      if (!(await isDirectoryEntry(entry, child))) continue
      if (entry.name === 'skills') {
        const contained = await collectSkillDirectories(child, '', { maxDepth: 3 })
        if (contained.directories.length > 0) pluginRoots.add(await resolveRoot(child))
        continue
      }
      queue.push({ dir: child, depth: current.depth + 1 })
    }
  }
  return [...pluginRoots].sort(compareStrings)
}

/**
 * Walk up from a `skills/` directory to the nearest `.claude-plugin/plugin.json`.
 *
 * @param {string} skillsDir - absolute plugin `skills/` directory.
 * @param {string} stopAt - do not walk above this directory.
 * @returns {Promise<string>} plugin root (falls back to the skills directory's parent).
 */
async function resolveClaudePluginRoot(skillsDir, stopAt) {
  let current = dirname(skillsDir)
  for (let depth = 0; depth < MAX_PLUGIN_ROOT_DEPTH; depth += 1) {
    if (await isFile(join(current, '.claude-plugin', 'plugin.json'))) return current
    if (current === stopAt) break
    const parent = dirname(current)
    if (parent === current || !isInside(stopAt, parent)) break
    current = parent
  }
  return dirname(skillsDir)
}

/**
 * @param {string} pluginRoot - plugin root directory.
 * @returns {Promise<string>} plugin display name (manifest name, then folder name).
 */
async function readClaudePluginName(pluginRoot) {
  const manifest = await readText(join(pluginRoot, '.claude-plugin', 'plugin.json'))
  if (manifest.error === undefined) {
    try {
      const data = JSON.parse(manifest.text)
      if (isRecord(data) && typeof data.name === 'string' && data.name.trim() !== '') {
        return data.name.trim()
      }
    } catch {
      // A malformed plugin manifest only costs us a nicer label.
    }
  }
  return readPluginFolderName(pluginRoot)
}

/**
 * @param {string} pluginRoot - plugin folder.
 * @returns {string} folder-derived name, unwrapping a trailing semver version folder.
 */
function readPluginFolderName(pluginRoot) {
  const base = basename(pluginRoot)
  if (SEMVER_DIRECTORY.test(base)) {
    const parent = basename(dirname(pluginRoot))
    if (parent !== '' && parent !== base) return parent
  }
  return base
}

/**
 * @param {unknown} custom - caller-provided custom source descriptor.
 * @param {string} home - user home directory for `~/` expansion.
 * @returns {Promise<SourceCandidate | undefined>} candidate (even when missing).
 */
async function describeCustomCandidate(custom, home) {
  if (!isRecord(custom) || typeof custom.path !== 'string' || custom.path.trim() === '') return undefined
  const sourcePath = resolveUserPath(custom.path, home)
  const id = typeof custom.id === 'string' && custom.id !== ''
    ? custom.id
    : `custom-${hash8(sourcePath)}`
  const kind = typeof custom.kind === 'string' && VALID_KINDS.has(custom.kind)
    ? custom.kind
    : id === 'imported' ? 'imported' : 'custom'
  const label = typeof custom.label === 'string' && custom.label.trim() !== ''
    ? custom.label.trim()
    : kind === 'imported' ? 'Imported skills' : `Custom skills (${basename(sourcePath) || sourcePath})`
  const exists = await isDirectory(sourcePath)
  let skillCount = 0
  if (exists) {
    skillCount = custom.promptFiles === true
      ? await countPromptFiles(sourcePath)
      : (await collectSkillDirectories(sourcePath, id)).directories.length
  }
  /** @type {SourceCandidate} */
  const candidate = { id, path: sourcePath, kind, label, auto: custom.auto === true, exists, skillCount }
  if (custom.promptFiles === true) candidate.promptFiles = true
  return candidate
}

/**
 * @param {SourceCandidate[]} candidates - candidates in insertion order.
 * @returns {SourceCandidate[]} candidates with duplicate ids removed (first wins).
 */
function dedupeCandidates(candidates) {
  /** @type {Map<string, SourceCandidate>} */
  const byId = new Map()
  for (const candidate of candidates) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate)
  }
  return [...byId.values()]
}

/**
 * @param {Array<Record<string, any>>} specs - plugin specs.
 * @returns {Array<Record<string, any>>} specs with duplicate ids removed (first wins).
 */
function dedupeById(specs) {
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map()
  for (const spec of specs) {
    if (!byId.has(spec.id)) byId.set(spec.id, spec)
  }
  return [...byId.values()]
}

/**
 * Resolve the nearest ancestor of `cwd` containing `.git`, else `cwd` itself.
 *
 * @param {string} cwd - starting directory.
 * @returns {Promise<string>} absolute project root.
 */
async function findProjectRoot(cwd) {
  const start = resolve(cwd)
  let current = start
  for (;;) {
    if ((await statPath(join(current, '.git'))).exists) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

/**
 * Bounded, deterministic walk collecting directories that contain `SKILL.md`.
 * A directory that contains `SKILL.md` is a skill and its subtree is not walked.
 *
 * @param {string} root - absolute skill root.
 * @param {string} sourceId - source id used in errors.
 * @param {{ maxDepth?: number, maxEntries?: number }} [options] - walk bounds.
 * @returns {Promise<{ directories: string[], errors: ScanError[] }>} skill
 *   directories and per-entry errors.
 */
async function collectSkillDirectories(root, sourceId, options = {}) {
  const maxDepth = clampLimit(options.maxDepth, MAX_WALK_DEPTH, 1)
  const maxEntries = clampLimit(options.maxEntries, MAX_WALK_ENTRIES, 1)
  /** @type {string[]} */
  const directories = []
  /** @type {ScanError[]} */
  const errors = []
  /** @type {Array<{ dir: string, depth: number }>} */
  const queue = [{ dir: root, depth: 0 }]
  const seen = new Set()
  let examined = 0
  while (queue.length > 0) {
    const current = queue.shift()
    if (seen.has(current.dir) || current.depth >= maxDepth) continue
    seen.add(current.dir)
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch (error) {
      if (!isMissingPathError(error)) {
        errors.push({ path: current.dir, message: errorMessage(error), sourceId })
      }
      continue
    }
    entries.sort((left, right) => compareStrings(left.name, right.name))
    for (const entry of entries) {
      if (examined >= maxEntries) {
        queue.length = 0
        break
      }
      examined += 1
      if (SKIP_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith('.')) continue
      const child = join(current.dir, entry.name)
      if (!(await isDirectoryEntry(entry, child))) continue
      const skillFile = join(child, SKILL_FILE)
      const info = await statPath(skillFile)
      if (info.exists) {
        if (info.isFile) directories.push(child)
        else errors.push({ path: skillFile, message: `${SKILL_FILE} is not a regular file`, sourceId })
        continue
      }
      if (info.error !== undefined && !isMissingPathError(info.error)) {
        errors.push({ path: skillFile, message: errorMessage(info.error), sourceId })
        continue
      }
      queue.push({ dir: child, depth: current.depth + 1 })
    }
  }
  return { directories, errors }
}

/**
 * Count top-level prompt markdown files in a Codex prompts directory.
 *
 * @param {string} root - absolute prompts directory.
 * @returns {Promise<number>} number of prompt files.
 */
async function countPromptFiles(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    if (!isPromptFileName(entry.name)) continue
    if (entry.isFile()) count += 1
    else if (entry.isSymbolicLink() && (await statPath(join(root, entry.name))).isFile) count += 1
  }
  return count
}

/**
 * Scan a Codex custom prompt directory: each top-level `*.md` file is one skill.
 *
 * @param {{ sourceId: string, kind: EcosystemKind, promptRoot: string, pluginRoot?: string }} context -
 *   scan context.
 * @param {RawSkill[]} skills - mutable output.
 * @param {ScanError[]} errors - mutable output.
 * @returns {Promise<void>}
 */
async function scanPromptFiles(context, skills, errors) {
  let entries
  try {
    entries = await readdir(context.promptRoot, { withFileTypes: true })
  } catch (error) {
    errors.push({ path: context.promptRoot, message: errorMessage(error), sourceId: context.sourceId })
    return
  }
  entries.sort((left, right) => compareStrings(left.name, right.name))
  for (const entry of entries) {
    if (!isPromptFileName(entry.name)) continue
    const filePath = join(context.promptRoot, entry.name)
    let isFile = entry.isFile()
    if (!isFile && entry.isSymbolicLink()) isFile = (await statPath(filePath)).isFile
    if (!isFile) continue
    const read = await readText(filePath)
    if (read.error !== undefined) {
      errors.push({ path: filePath, message: errorMessage(read.error), sourceId: context.sourceId })
      continue
    }
    skills.push(buildRawSkill(read.text, {
      sourceId: context.sourceId,
      kind: context.kind,
      filePath,
      dir: context.promptRoot,
      dirName: promptFileName(entry.name),
      pluginRoot: context.pluginRoot,
    }))
  }
}

/**
 * Build one RawSkill from a Markdown file.
 *
 * @param {string} raw - file text.
 * @param {{ sourceId: string, kind: EcosystemKind, filePath: string, dir: string,
 *           dirName: string, pluginRoot?: string }} context - file facts.
 * @returns {RawSkill} normalized raw skill.
 */
function buildRawSkill(raw, context) {
  /** @type {string[]} */
  const diagnostics = []
  let data = {}
  let body = raw
  const parsed = parseFrontmatter(raw)
  if (parsed !== undefined) {
    data = parsed.data
    body = parsed.body
  } else {
    const fence = splitFrontmatterFence(raw)
    if (fence.found) {
      body = fence.body
      diagnostics.push('YAML frontmatter could not be parsed; ignored')
    } else if (fence.unterminated) {
      diagnostics.push('frontmatter fence is not terminated; treated as body text')
    }
  }
  const normalized = normalizeSkillFrontmatter({
    data,
    dirName: context.dirName,
    filePath: context.filePath,
    body,
  })
  /** @type {Record<string, any>} */
  const skill = {
    name: normalized.name,
    originalName: normalized.originalName,
    description: normalized.description,
    invocation: normalized.invocation,
    sourceId: context.sourceId,
    kind: context.kind,
    ecosystem: context.kind,
    path: context.filePath,
    dir: context.dir,
    metadata: normalized.metadata,
    diagnostics: [...diagnostics, ...normalized.diagnostics],
    content: body.trim(),
  }
  if (normalized.whenToUse !== undefined) skill.whenToUse = normalized.whenToUse
  if (typeof context.pluginRoot === 'string' && context.pluginRoot !== '') skill.pluginRoot = context.pluginRoot
  return /** @type {RawSkill} */ (skill)
}

/**
 * Split a frontmatter fence without parsing YAML (used only to salvage the body of
 * files whose frontmatter is malformed so `parseFrontmatter` rejected them).
 *
 * @param {string} raw - file text.
 * @returns {{ found: boolean, unterminated: boolean, body?: string }} fence facts.
 */
function splitFrontmatterFence(raw) {
  const lines = raw.split(/\r?\n/u)
  const first = (lines[0] ?? '').replace(/^\uFEFF/u, '')
  if (!FENCE_LINE.test(first)) return { found: false, unterminated: false }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trimEnd()
    if (line === '---' || line === '...') {
      return { found: true, unterminated: false, body: lines.slice(index + 1).join('\n') }
    }
  }
  return { found: false, unterminated: true }
}

/**
 * @param {SourceCandidate | Record<string, any>} source - scan source.
 * @returns {EcosystemKind} normalized ecosystem kind.
 */
function sourceKind(source) {
  return typeof source.kind === 'string' && VALID_KINDS.has(source.kind) ? source.kind : 'custom'
}

/**
 * Resolve the plugin root for one scan (candidate-provided value wins).
 *
 * @param {SourceCandidate | Record<string, any>} source - scan source.
 * @returns {Promise<string | undefined>} absolute plugin root, when applicable.
 */
async function resolveSourcePluginRoot(source) {
  if (typeof source.pluginRoot === 'string' && source.pluginRoot !== '') return source.pluginRoot
  if (source.plugin === undefined) return undefined
  const root = resolve(source.path)
  if (await isFile(join(root, '.claude-plugin', 'plugin.json'))) return root
  let current = dirname(root)
  for (let depth = 0; depth < MAX_PLUGIN_ROOT_DEPTH; depth += 1) {
    if (await isFile(join(current, '.claude-plugin', 'plugin.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * @param {RawSkill} left - skill.
 * @param {RawSkill} right - skill.
 * @returns {number} comparison result (name, then path, codepoint order).
 */
function compareSkills(left, right) {
  return compareStrings(left.name, right.name) || compareStrings(left.path, right.path)
}

/**
 * @param {ScanError} left - error.
 * @param {ScanError} right - error.
 * @returns {number} comparison result (path, then message, codepoint order).
 */
function compareErrors(left, right) {
  return compareStrings(left.path, right.path) || compareStrings(left.message, right.message)
}

/**
 * Locale-independent string comparison for deterministic ordering.
 *
 * @param {string} left - left string.
 * @param {string} right - right string.
 * @returns {number} -1, 0 or 1.
 */
function compareStrings(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * @param {unknown} value - limit candidate.
 * @param {number} fallback - default limit.
 * @param {number} minimum - smallest allowed limit.
 * @returns {number} positive integer limit.
 */
function clampLimit(value, fallback, minimum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
    ? Math.floor(value)
    : fallback
}

/**
 * @param {unknown} value - candidate.
 * @returns {boolean} whether the value is a plain record.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} error - thrown value.
 * @returns {boolean} whether the error means "path does not exist".
 */
function isMissingPathError(error) {
  if (error === null || typeof error !== 'object') return false
  const code = /** @type {{ code?: unknown }} */ (error).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * @param {unknown} error - thrown value.
 * @returns {string} printable error message.
 */
function errorMessage(error) {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/**
 * @param {Record<string, string | undefined>} env - environment-like object.
 * @param {string} key - variable name.
 * @param {string} home - home directory for `~/` expansion.
 * @returns {string | undefined} absolute path, or `undefined` when unset.
 */
function envPath(env, key, home) {
  const value = env[key]
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return isAbsolute(value.trim()) ? resolve(value.trim()) : resolveUserPath(value.trim(), home)
}

/**
 * Resolve an absolute, `~/`-prefixed or relative user-supplied path.
 *
 * @param {string} value - path text.
 * @param {string} home - home directory for `~/` expansion.
 * @returns {string} absolute path.
 */
function resolveUserPath(value, home) {
  const text = value.trim()
  if (text === '~') return home
  if (text.startsWith('~/') || text.startsWith('~\\')) return resolve(home, text.slice(2))
  return resolve(text)
}

/**
 * @param {string} parent - ancestor path.
 * @param {string} child - candidate descendant path.
 * @returns {boolean} whether `child` is `parent` or inside it.
 */
function isInside(parent, child) {
  if (parent === child) return true
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/**
 * @param {string} name - directory entry name.
 * @returns {boolean} whether the entry is a Codex prompt markdown file.
 */
function isPromptFileName(name) {
  return !name.startsWith('.') && name.toLowerCase().endsWith('.md')
}

/**
 * @param {string} name - prompt file name.
 * @returns {string} prompt name without the `.md` extension.
 */
function promptFileName(name) {
  return name.slice(0, -3)
}

/**
 * @param {import('node:fs/promises').Dirent} entry - directory entry.
 * @param {string} fullPath - absolute entry path.
 * @returns {Promise<boolean>} whether the entry is (or links to) a directory.
 */
async function isDirectoryEntry(entry, fullPath) {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  return isDirectory(fullPath)
}

/**
 * @param {string} target - path to probe.
 * @returns {Promise<boolean>} whether the path is a directory.
 */
async function isDirectory(target) {
  return (await statPath(target)).isDirectory
}

/**
 * @param {string} target - path to probe.
 * @returns {Promise<boolean>} whether the path is a regular file.
 */
async function isFile(target) {
  return (await statPath(target)).isFile
}

/**
 * @param {string} target - path to probe.
 * @returns {Promise<{ exists: boolean, isFile: boolean, isDirectory: boolean, error?: unknown }>}
 *   stat result; `exists` is false for missing paths, and permission failures carry
 *   the underlying `error`.
 */
async function statPath(target) {
  try {
    const info = await stat(target)
    return { exists: true, isFile: info.isFile(), isDirectory: info.isDirectory() }
  } catch (error) {
    return { exists: false, isFile: false, isDirectory: false, error }
  }
}

/**
 * @param {string} target - file to read.
 * @returns {Promise<{ text: string, error?: undefined } | { text?: undefined, error: unknown }>}
 *   file text or the read error.
 */
async function readText(target) {
  try {
    return { text: await readFile(target, 'utf8') }
  } catch (error) {
    return { error }
  }
}

/**
 * Deterministic 32-bit FNV-1a hash rendered as 8 lowercase hex characters.
 *
 * @param {string} text - input text.
 * @returns {string} 8-character hex digest.
 */
function hash8(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
