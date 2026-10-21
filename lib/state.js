/**
 * Persistent state store for the dsh-skill library.
 *
 * The state file lives at `$DSH_HOME/dsh-skill/state.json` and records the
 * user's source directories, auto-source toggles and globally disabled skill
 * names. It is deliberately small and JSON-shaped: the discovered skills
 * themselves are always recomputed from disk. (Version 2 dropped the old
 * per-session selection table; legacy files are read with those rows ignored.)
 *
 * @module dsh-skill/lib/state
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Current state file schema version. */
export const STATE_VERSION = 2

/** @returns {string} the harness home directory (explicit, `$DSH_HOME`, or `~/.dsh`). */
export function resolveDshHome(explicit) {
  const raw = explicit ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return resolve(expandHome(raw))
}

/**
 * Expand a leading `~` or `~/` against the current user's home directory.
 * @param {string} value - path text from configuration or UI input.
 * @returns {string} the same path with the home prefix expanded.
 */
export function expandHome(value) {
  if (typeof value !== 'string') return ''
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve user input to an absolute path, or throw when it is not a usable
 * absolute/tilde path. Relative paths are rejected so a typo never silently
 * resolves against whatever the harness process working directory happens to be.
 * @param {string} value - user-supplied path.
 * @returns {string} absolute resolved path.
 */
export function resolveUserPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw libraryError('invalid-request', 'a non-empty path is required')
  }
  const text = value.trim()
  if (!isAbsolute(text) && !text.startsWith('~')) {
    throw libraryError('invalid-request', `path must be absolute or start with "~": ${text}`)
  }
  return resolve(expandHome(text))
}

/** Stable custom-source id derived from the normalized directory path. */
export function customSourceId(path) {
  const digest = createHash('sha1').update(resolve(path)).digest('hex').slice(0, 8)
  return `custom-${digest}`
}

/**
 * Create a plugin error carrying a stable machine code for the HTTP API.
 * @param {string} code - one of the API error codes.
 * @param {string} message - human-readable reason.
 * @returns {Error & { code: string }}
 */
export function libraryError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** @returns {object} a fresh default state document. */
export function defaultState() {
  return {
    version: STATE_VERSION,
    sources: {},
    autoSources: {},
    disabledSkills: [],
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize an arbitrary parsed state document into the current schema.
 * Unknown fields are dropped, malformed entries are ignored rather than
 * failing the whole library.
 * @param {unknown} raw - parsed JSON document.
 * @returns {object} a valid state document.
 */
export function normalizeState(raw) {
  const state = defaultState()
  if (!isRecord(raw)) return state
  if (isRecord(raw.sources)) {
    for (const [id, value] of Object.entries(raw.sources)) {
      if (typeof id !== 'string' || !isRecord(value) || typeof value.path !== 'string' || value.path === '') continue
      state.sources[id] = {
        path: value.path,
        label: typeof value.label === 'string' && value.label !== '' ? value.label : basename(value.path),
        enabled: value.enabled !== false,
      }
    }
  }
  if (isRecord(raw.autoSources)) {
    for (const [id, value] of Object.entries(raw.autoSources)) {
      if (typeof id !== 'string' || !isRecord(value)) continue
      state.autoSources[id] = { enabled: value.enabled !== false }
    }
  }
  if (Array.isArray(raw.disabledSkills)) {
    const seen = new Set()
    for (const name of raw.disabledSkills) {
      if (typeof name !== 'string' || name === '' || seen.has(name)) continue
      seen.add(name)
      state.disabledSkills.push(name)
    }
  }
  // Legacy v1 files carried a `sessions` selection table. Session-scoped
  // availability was removed in favor of explicit, per-message invocation, so
  // those rows are intentionally ignored and disappear on the next save.
  return state
}

/**
 * Owns the on-disk state document and the managed library directory.
 */
export class StateStore {
  /** @param {{home?: string}} [options] */
  constructor(options = {}) {
    this.home = resolveDshHome(options.home)
    this.root = join(this.home, 'dsh-skill')
    this.statePath = join(this.root, 'state.json')
    this.libraryDir = join(this.root, 'skills')
    /** @type {ReturnType<typeof defaultState>} */
    this.state = defaultState()
    this.loaded = false
  }

  /** Load (and normalize) the state file. Missing file means defaults. */
  async load() {
    await mkdir(this.libraryDir, { recursive: true })
    let raw
    try {
      raw = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if (isMissing(error)) {
        this.state = defaultState()
        this.loaded = true
        return this.state
      }
      throw libraryError('io-error', `cannot read ${this.statePath}: ${errorMessage(error)}`)
    }
    try {
      this.state = normalizeState(JSON.parse(raw))
    } catch {
      // A hand-edited or truncated file must not take the whole library down:
      // preserve it for inspection and start from defaults.
      const broken = `${this.statePath}.broken-${Date.now()}`
      await rename(this.statePath, broken).catch(() => {})
      this.state = defaultState()
    }
    this.loaded = true
    return this.state
  }

  /** Persist the current state atomically (same-directory temp + rename). */
  async save() {
    await mkdir(dirname(this.statePath), { recursive: true })
    const tmp = join(dirname(this.statePath), `.state.json.${process.pid}.tmp`)
    const body = `${JSON.stringify(this.state, null, 2)}\n`
    try {
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, this.statePath)
    } catch (error) {
      throw libraryError('io-error', `cannot write ${this.statePath}: ${errorMessage(error)}`)
    }
  }

  /** Ensure the managed library directory exists. */
  async ensureLibrary() {
    await mkdir(this.libraryDir, { recursive: true })
    return this.libraryDir
  }
}

/**
 * Render an arbitrary thrown value for logging / API messages.
 * @param {unknown} error - thrown value.
 * @returns {string} bounded text.
 */
export function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 500 ? `${text.slice(0, 497)}...` : text
}

/**
 * Whether an fs error means "the path does not exist".
 * @param {unknown} error - caught fs error.
 * @returns {boolean}
 */
export function isMissing(error) {
  const code = /** @type {{code?: unknown}} */ (error)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Reduce an error to the API-shaped failure envelope.
 * @param {unknown} error - thrown value.
 * @returns {{ code: string, message: string }}
 */
export function apiErrorOf(error) {
  const code = /** @type {{code?: unknown}} */ (error)?.code
  const known = typeof code === 'string'
    && ['invalid-request', 'not-found', 'already-exists', 'io-error', 'source-error'].includes(code)
  return {
    code: known ? code : 'internal',
    message: errorMessage(error),
  }
}
