/**
 * File operations for the managed skill library (`$DSH_HOME/dsh-skill/skills`).
 *
 * The managed library is the only place dsh-skill writes skill files. Imported
 * skills are copied here (so the library survives changes to the ecosystem
 * roots they came from) and user-created skills are authored here.
 *
 * @module dsh-skill/lib/skillfiles
 */

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter, normalizeSkillFrontmatter, slugifySkillName } from './frontmatter.js'
import { errorMessage, isMissing, libraryError } from './state.js'

const SKILL_FILE = 'SKILL.md'

/**
 * Read and parse one skill instruction file.
 * @param {string} file - absolute path to `SKILL.md` (or a Codex prompt file).
 * @returns {Promise<{ path: string, raw: string, data: Record<string, unknown>, body: string }>}
 */
export async function readSkillFile(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) throw libraryError('not-found', `skill file not found: ${file}`)
    throw libraryError('io-error', `cannot read ${file}: ${errorMessage(error)}`)
  }
  const parsed = parseFrontmatter(raw)
  return { path: file, raw, data: parsed?.data ?? {}, body: (parsed?.body ?? raw).trim() }
}

/**
 * Collect skill directories from a user-selected path.
 * - a directory containing `SKILL.md` is one skill;
 * - a `SKILL.md`/`*.md` file resolves to its own directory (only when it is
 *   `SKILL.md`, because arbitrary Markdown is ambiguous here);
 * - otherwise each immediate child directory containing `SKILL.md` is a skill,
 *   which lets a user import a whole `~/.claude/skills` folder in one action.
 * @param {string} sourcePath - absolute path chosen by the user.
 * @returns {Promise<string[]>} absolute skill directories, deterministically ordered.
 */
export async function collectSkillDirectories(sourcePath) {
  const requestPath = resolve(sourcePath)
  let info
  try {
    info = await stat(requestPath)
  } catch (error) {
    if (isMissing(error)) throw libraryError('source-error', `path does not exist: ${requestPath}`)
    throw libraryError('source-error', `cannot inspect ${requestPath}: ${errorMessage(error)}`)
  }
  if (info.isFile()) {
    if (basename(requestPath) !== SKILL_FILE) {
      throw libraryError('source-error', `expected a skill directory or a ${SKILL_FILE} file: ${requestPath}`)
    }
    return [dirname(requestPath)]
  }
  if (!info.isDirectory()) {
    throw libraryError('source-error', `not a directory: ${requestPath}`)
  }
  if (await pathIsFile(join(requestPath, SKILL_FILE))) return [requestPath]
  let entries
  try {
    entries = await readdir(requestPath, { withFileTypes: true })
  } catch (error) {
    throw libraryError('source-error', `cannot list ${requestPath}: ${errorMessage(error)}`)
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.')) continue
    const child = join(requestPath, entry.name)
    if (await pathIsFile(join(child, SKILL_FILE))) found.push(child)
  }
  found.sort((left, right) => left.localeCompare(right))
  if (found.length === 0) {
    throw libraryError('source-error', `no ${SKILL_FILE} found in ${requestPath}`)
  }
  return found
}

/**
 * Import one or more skill directories into the managed library.
 * @param {{ sourcePath: string, libraryDir: string, overwrite?: boolean }} input
 * @returns {Promise<{ imported: { name: string, dir: string }[], skipped: { path: string, reason: string }[] }>}
 */
export async function importSkills(input) {
  const { sourcePath, libraryDir, overwrite = false } = input
  const directories = await collectSkillDirectories(sourcePath)
  await mkdir(libraryDir, { recursive: true })
  const imported = []
  const skipped = []
  for (const directory of directories) {
    let normalized
    try {
      const file = join(directory, SKILL_FILE)
      const parsed = await readSkillFile(file)
      normalized = normalizeSkillFrontmatter({
        data: parsed.data,
        dirName: basename(directory),
        filePath: file,
        body: parsed.body,
      })
    } catch (error) {
      skipped.push({ path: directory, reason: errorMessage(error) })
      continue
    }
    const name = normalized.name
    if (!name) {
      skipped.push({ path: directory, reason: 'skill has no usable name' })
      continue
    }
    const destination = join(libraryDir, name)
    if (await pathExists(destination)) {
      if (!overwrite) {
        skipped.push({ path: directory, reason: `a managed skill named "${name}" already exists` })
        continue
      }
      await rm(destination, { recursive: true, force: true })
    }
    try {
      await cp(directory, destination, { recursive: true, dereference: true, force: true })
    } catch (error) {
      skipped.push({ path: directory, reason: `copy failed: ${errorMessage(error)}` })
      continue
    }
    await writeImportOrigin(destination, directory).catch(() => {})
    imported.push({ name, dir: destination })
  }
  if (imported.length === 0) {
    const reason = skipped.map(entry => `${entry.path}: ${entry.reason}`).join('; ')
    throw libraryError('source-error', `nothing was imported${reason === '' ? '' : `: ${reason}`}`)
  }
  return { imported, skipped }
}

/**
 * Create a new skill in the managed library from UI input.
 * @param {{ libraryDir: string, name: string, description: string,
 *           instructions: string, whenToUse?: string, overwrite?: boolean }} input
 * @returns {Promise<{ name: string, dir: string, path: string }>}
 */
export async function createManagedSkill(input) {
  const name = slugifySkillName(input.name)
  if (!name) throw libraryError('invalid-request', 'skill name must contain letters or digits')
  const description = collapseWhitespace(input.description ?? '')
  if (description === '') throw libraryError('invalid-request', 'a description is required')
  const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : ''
  if (instructions === '') throw libraryError('invalid-request', 'skill instructions are required')
  await mkdir(input.libraryDir, { recursive: true })
  const directory = join(input.libraryDir, name)
  if (await pathExists(directory)) {
    if (!input.overwrite) throw libraryError('already-exists', `a managed skill named "${name}" already exists`)
    await rm(directory, { recursive: true, force: true })
  }
  await mkdir(directory, { recursive: true })
  const whenToUse = typeof input.whenToUse === 'string' ? collapseWhitespace(input.whenToUse) : ''
  const file = join(directory, SKILL_FILE)
  const frontmatter = [
    '---',
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(description)}`,
    ...(whenToUse === '' ? [] : [`whenToUse: ${yamlScalar(whenToUse)}`]),
    '---',
    '',
    instructions,
    '',
  ].join('\n')
  try {
    await writeFile(file, frontmatter, 'utf8')
  } catch (error) {
    throw libraryError('io-error', `cannot write ${file}: ${errorMessage(error)}`)
  }
  return { name, dir: directory, path: file }
}

/**
 * Remove one managed-library skill directory.
 * @param {{ libraryDir: string, name: string }} input
 * @returns {Promise<void>}
 */
export async function removeManagedSkill(input) {
  const name = slugifySkillName(input.name)
  if (!name) throw libraryError('invalid-request', 'invalid skill name')
  const directory = join(resolve(input.libraryDir), name)
  if (!isInside(resolve(input.libraryDir), directory) || dirname(directory) !== resolve(input.libraryDir)) {
    throw libraryError('invalid-request', 'refusing to remove a path outside the managed library')
  }
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    throw libraryError('io-error', `cannot remove ${directory}: ${errorMessage(error)}`)
  }
}

/** Name of the sidecar that preserves the ecosystem origin of an imported skill. */
const ORIGIN_FILE = '.dsh-skill-origin.json'

/**
 * Infer the ecosystem a skill directory came from by its path segments.
 * @param {string} directory - absolute source directory.
 * @returns {'claude'|'codex'|'agents'|'custom'}
 */
export function inferEcosystemFromPath(directory) {
  const segments = resolve(directory).replaceAll('\\', '/').split('/').filter(Boolean)
  const has = (pattern) => segments.some(segment => pattern.test(segment))
  if (has(/^\.?claude/i)) return 'claude'
  if (has(/^\.?codex/i)) return 'codex'
  if (has(/^\.?agents/i)) return 'agents'
  return 'custom'
}

/**
 * Find the enclosing Claude Code plugin root (a directory whose
 * `.claude-plugin/plugin.json` declares the plugin), if any.
 * @param {string} directory - absolute skill directory.
 * @returns {Promise<string | undefined>}
 */
async function findPluginRoot(directory) {
  let current = resolve(directory)
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await stat(join(current, '.claude-plugin', 'plugin.json'))
      return current
    } catch (error) {
      if (!isMissing(error)) return undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * Persist the origin metadata beside one imported copy, so the loaded skill
 * keeps its Claude/Codex compatibility preamble after the copy.
 * @param {string} destination - managed skill directory.
 * @param {string} sourceDirectory - directory the skill was imported from.
 */
async function writeImportOrigin(destination, sourceDirectory) {
  const ecosystem = inferEcosystemFromPath(sourceDirectory)
  if (ecosystem === 'custom') return
  const pluginRoot = ecosystem === 'claude' ? await findPluginRoot(sourceDirectory) : undefined
  await writeFile(
    join(destination, ORIGIN_FILE),
    `${JSON.stringify({
      ecosystem,
      ...(pluginRoot === undefined ? {} : { pluginRoot }),
      sourcePath: sourceDirectory,
      importedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    'utf8',
  )
}

/**
 * Read the origin metadata of one managed skill copy.
 * @param {string} directory - managed skill directory.
 * @returns {Promise<{ ecosystem?: string, pluginRoot?: string } | undefined>}
 */
export async function readImportOrigin(directory) {
  try {
    const raw = await readFile(join(directory, ORIGIN_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return {
      ...(typeof parsed.ecosystem === 'string' ? { ecosystem: parsed.ecosystem } : {}),
      ...(typeof parsed.pluginRoot === 'string' ? { pluginRoot: parsed.pluginRoot } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Render one YAML double-quoted scalar (JSON string syntax is valid YAML).
 * @param {string} value - raw text.
 * @returns {string} quoted scalar.
 */
function yamlScalar(value) {
  return JSON.stringify(value)
}

function collapseWhitespace(value) {
  return value.replaceAll(/\s+/g, ' ').trim()
}

async function pathIsFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/**
 * Whether `child` is `parent` itself or contained by it (path-segment safe).
 * @param {string} parent - resolved parent directory.
 * @param {string} child - resolved candidate path.
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}
