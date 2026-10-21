/**
 * Skill library: discovery orchestration and mutations.
 *
 * The library is the single host-side hub between the three faces of the
 * plugin: the global `ctx.skills` provider (model-facing catalog), the browser
 * API (management UI) and the state file. It owns a small cwd-scoped scan
 * cache: one entry per workspace, so sessions in different workspaces do not
 * thrash each other's project-skill discovery. Skills are available to every
 * session once globally enabled; explicit per-message invocation is handled by
 * the harness (`/<name>` gesture) from the composer UI.
 *
 * @module dsh-skill/lib/library
 */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { candidateSources, scanSources } from './discovery.js'
import { parseFrontmatter } from './frontmatter.js'
import { composeSkillContent } from './compat.js'
import {
  createManagedSkill,
  importSkills as importSkillDirectories,
  inferEcosystemFromPath,
  readImportOrigin,
  readSkillFile,
  removeManagedSkill,
} from './skillfiles.js'
import {
  STATE_VERSION,
  customSourceId,
  errorMessage,
  isMissing,
  libraryError,
  resolveUserPath,
} from './state.js'

const SCAN_TTL_MS = 30_000
const MAX_CACHES = 8
const AUTO_SOURCE_RANK = {
  imported: 0,
  'claude-project': 20,
  'codex-project': 21,
  'agents-project': 22,
  'dsh-project': 23,
  'claude-user': 30,
  'claude-desktop': 31,
  'claude-plugins': 32,
  'codex-user': 33,
  'codex-prompts': 34,
  'codex-plugins': 35,
  'agents-user': 36,
  'dsh-user': 37,
}

/**
 * Persistent skill library.
 */
export class SkillLibrary {
  /**
   * @param {{
   *   store: import('./state.js').StateStore,
   *   home?: string,
   *   dshHome?: string,
   *   logger?: { warn?: (message: string) => void },
   * }} options
   */
  constructor(options) {
    this.store = options.store
    /** User home directory used by ecosystem discovery (`~/.claude`, `~/.codex`, ...). */
    this.home = options.home ?? homedir()
    /** Harness home directory; the managed library and state file live below it. */
    this.dshHome = options.dshHome ?? options.store.home
    this.libraryDir = options.store.libraryDir
    this.logger = options.logger
    /** @type {Map<string, Cache>} */
    this.caches = new Map()
    /** @type {Set<(hint: { sessionId?: string } ) => void>} */
    this.listeners = new Set()
  }

  /** @returns {ReturnType<typeof import('./state.js').defaultState>} live state document */
  get state() {
    return this.store.state
  }

  /** Load the persisted state and prepare the managed library directory. */
  async load() {
    await this.store.load()
    await this.store.ensureLibrary()
  }

  /**
   * Read the current scan cache for one workspace, refreshing it when stale.
   * @param {{ cwd?: string, force?: boolean }} [options]
   * @returns {Promise<Cache>}
   */
  async context(options = {}) {
    const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined
    const key = cwd ?? ''
    let cache = this.caches.get(key)
    if (cache === undefined) {
      cache = createCache(key, cwd)
      this.caches.set(key, cache)
      this.trimCaches()
    }
    if (cache.promise !== undefined) {
      await cache.promise
      if (!options.force && !cache.stale) return cache
    }
    if (options.force === true || cache.stale || Date.now() - cache.scannedAt > SCAN_TTL_MS) {
      await this.scan(cache)
    }
    return cache
  }

  /** @param {Cache} cache */
  async scan(cache) {
    if (cache.promise !== undefined) return cache.promise
    cache.promise = this.performScan(cache).finally(() => { cache.promise = undefined })
    return cache.promise
  }

  /** @param {Cache} cache */
  async performScan(cache) {
    let candidates
    try {
      candidates = await this.buildCandidates(cache.cwd)
    } catch (error) {
      cache.errors = [{ path: cache.cwd ?? '', message: errorMessage(error), sourceId: '' }]
      cache.scannedAt = Date.now()
      cache.stale = false
      return
    }
    const ordered = [...candidates].sort((left, right) => rankOf(left) - rankOf(right) || left.id.localeCompare(right.id))
    const sourceById = new Map(ordered.map(candidate => [candidate.id, candidate]))
    /** @type {Map<string, number>} */
    const counts = new Map()
    let scanned
    try {
      scanned = await scanSources(ordered)
    } catch (error) {
      cache.errors = [{ path: cache.cwd ?? '', message: errorMessage(error), sourceId: '' }]
      cache.scannedAt = Date.now()
      cache.stale = false
      return
    }
    const records = new Map()
    const shadowed = []
    for (const raw of scanned.skills) {
      counts.set(raw.sourceId, (counts.get(raw.sourceId) ?? 0) + 1)
      const candidate = sourceById.get(raw.sourceId)
      const record = this.toRecord(raw, candidate)
      const winner = records.get(record.name)
      if (winner !== undefined) {
        shadowed.push({ ...record, shadowedBy: winner.sourceId })
        continue
      }
      records.set(record.name, record)
    }
    // Imported copies live under $DSH_HOME: their ecosystem origin rides a
    // sidecar written at import time, so the Claude/Codex compatibility
    // preamble survives the copy.
    for (const record of records.values()) {
      if (record.sourceId !== 'imported') continue
      const origin = await readImportOrigin(record.dir)
      if (origin === undefined) continue
      if (origin.ecosystem !== undefined) record.ecosystem = origin.ecosystem
      if (origin.pluginRoot !== undefined) record.pluginRoot = origin.pluginRoot
    }
    cache.candidates = new Map(ordered.map(candidate => [candidate.id, candidate]))
    cache.records = records
    cache.shadowed = shadowed
    cache.sourceCounts = counts
    cache.errors = scanned.errors
    cache.scannedAt = Date.now()
    cache.stale = false
  }

  /**
   * Build the candidate source list for one workspace.
   * @param {string | undefined} cwd
   * @returns {Promise<import('./discovery.js').SourceCandidate[]>}
   */
  async buildCandidates(cwd) {
    const customSources = [
      ...Object.entries(this.state.sources).map(([id, value]) => ({
        id,
        path: value.path,
        label: value.label,
        enabled: value.enabled,
      })),
      { id: 'imported', path: this.libraryDir, label: 'Skill library', enabled: true },
    ]
    let candidates
    try {
      candidates = await candidateSources({
        cwd,
        home: this.home,
        customSources,
      })
    } catch (error) {
      this.logger?.warn?.(`dsh-skill: source discovery failed: ${errorMessage(error)}`)
      candidates = []
    }
    const byId = new Map()
    for (const candidate of candidates) {
      if (candidate && typeof candidate.id === 'string') byId.set(candidate.id, candidate)
    }
    // Custom sources are authoritative from state: discovery may not know them.
    // A broken custom source stays listed (exists=false) so the UI can remove it.
    for (const custom of customSources) {
      const known = byId.get(custom.id)
      const imported = custom.id === 'imported'
      const exists = imported ? true : known?.exists ?? await pathIsDirectory(custom.path)
      byId.set(custom.id, {
        id: custom.id,
        path: custom.path,
        kind: imported ? 'imported' : 'custom',
        label: custom.label,
        auto: false,
        exists,
        skillCount: known?.skillCount ?? 0,
      })
    }
    // DSH natively loads ~/.dsh/skills and ~/.agents/skills (plus bundled skills)
    // through its own skill-filesystem provider; this library manages the
    // EXTERNAL ecosystems only, so a toggle here always has a visible effect.
    return [...byId.values()]
      .filter(candidate => candidate.kind !== 'dsh' && candidate.kind !== 'agents')
      .filter(candidate => candidate.exists !== false || candidate.kind === 'custom')
  }

  /**
   * Project one discovery entry into the library record shape.
   * @param {import('./discovery.js').RawSkill} raw
   * @param {import('./discovery.js').SourceCandidate | undefined} candidate
   */
  toRecord(raw, candidate) {
    const kind = raw.kind ?? candidate?.kind ?? 'custom'
    const sourceEnabled = this.isSourceEnabled({ id: raw.sourceId, kind })
    return {
      name: raw.name,
      originalName: raw.originalName ?? raw.name,
      description: raw.description,
      whenToUse: raw.whenToUse,
      invocation: raw.invocation ?? { modelInvocable: true, userInvocable: true },
      sourceId: raw.sourceId,
      sourceLabel: candidate?.label ?? raw.sourceId,
      kind,
      ecosystem: ecosystemOfRecord(raw, kind),
      path: raw.path,
      dir: raw.dir,
      pluginRoot: raw.pluginRoot,
      metadata: raw.metadata ?? {},
      diagnostics: raw.diagnostics ?? [],
      content: raw.content ?? '',
      sourceEnabled,
      enabled: sourceEnabled && !this.state.disabledSkills.includes(raw.name),
    }
  }

  /**
   * Recompute enabled flags on every cached record after a state toggle.
   */
  applyFlags() {
    const disabled = new Set(this.state.disabledSkills)
    for (const cache of this.caches.values()) {
      for (const record of [...cache.records.values(), ...cache.shadowed]) {
        record.sourceEnabled = this.isSourceEnabled({ id: record.sourceId, kind: record.kind })
        record.enabled = record.sourceEnabled && !disabled.has(record.name)
      }
    }
  }

  /** Invalidate every cached scan (the filesystem may have changed). */
  invalidateScans() {
    for (const cache of this.caches.values()) {
      cache.stale = true
    }
  }

  /** Trim the least recently created scan caches beyond the bound. */
  trimCaches() {
    while (this.caches.size > MAX_CACHES) {
      const oldest = this.caches.keys().next()
      if (oldest.done === true) return
      this.caches.delete(oldest.value)
    }
  }

  /**
   * @param {{ id: string, kind: string }} source - source identity.
   * @returns {boolean} whether the source is enabled in state.
   */
  isSourceEnabled(source) {
    if (source.id === 'imported') return true
    if (source.kind === 'custom') return this.state.sources[source.id]?.enabled !== false
    return this.state.autoSources[source.id]?.enabled !== false
  }

  /**
   * Skills the catalog advertises and the loader can resolve, in name order.
   * Availability is global: enabled skill from an enabled source. Per-message
   * invocation is the harness's `/<name>` gesture and is not filtered here.
   * @param {{ cwd?: string, force?: boolean }} [options]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async visibleSkills(options = {}) {
    const cache = await this.context(options)
    return [...cache.records.values()]
      .filter(record => record.enabled === true && record.sourceEnabled === true)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Whether one skill is currently available.
   * @param {string} name - skill name.
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<boolean>}
   */
  async isVisible(name, options = {}) {
    const skills = await this.visibleSkills(options)
    return skills.some(skill => skill.name === name)
  }

  /**
   * @param {string} name - skill name.
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<Record<string, any> | undefined>}
   */
  async getRecord(name, options = {}) {
    const cache = await this.context(options)
    return cache.records.get(name)
  }

  /**
   * Resolve one skill record from any cached workspace.
   * @param {string} name - skill name.
   * @returns {Record<string, any> | undefined}
   */
  recordAnywhere(name) {
    for (const cache of this.caches.values()) {
      const record = cache.records.get(name)
      if (record !== undefined) return record
    }
    return undefined
  }

  /**
   * Model-facing instructions for one skill (works for disabled skills too —
   * the settings page may preview them).
   * @param {string} name - skill name.
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<{ name: string, path: string, dir: string, ecosystem: string, content: string } | undefined>}
   */
  async skillContent(name, options = {}) {
    const record = await this.getRecord(name, options) ?? this.recordAnywhere(name)
    if (record === undefined) return undefined
    let body = record.content
    try {
      const file = await readSkillFile(record.path)
      body = file.body
    } catch {
      // Fall back to the scanned content; the file may be temporarily locked.
    }
    return {
      name: record.name,
      path: record.path,
      dir: record.dir,
      ecosystem: record.ecosystem,
      content: composeSkillContent({ ...record, content: body }),
    }
  }

  /**
   * Build the API state document.
   * @param {{ cwd?: string, sessionId?: string, force?: boolean, action?: object }} [options]
   */
  async snapshot(options = {}) {
    const cache = await this.context({ cwd: options.cwd, force: options.force })
    const skillViews = []
    for (const record of cache.records.values()) {
      skillViews.push(this.skillView(record, true))
    }
    for (const record of cache.shadowed) {
      skillViews.push(this.skillView(record, false))
    }
    skillViews.sort((left, right) => left.name.localeCompare(right.name)
      || (left.shadowedBy === undefined ? -1 : 1) - (right.shadowedBy === undefined ? -1 : 1))
    const sources = [...cache.candidates.values()]
      .map(candidate => ({
        id: candidate.id,
        path: candidate.path,
        kind: candidate.kind,
        label: candidate.label,
        auto: candidate.auto === true,
        enabled: this.isSourceEnabled({ id: candidate.id, kind: candidate.kind }),
        exists: candidate.exists !== false,
        skillCount: cache.sourceCounts.get(candidate.id) ?? 0,
        removable: candidate.kind === 'custom',
        ...(candidate.plugin === undefined ? {} : { plugin: candidate.plugin }),
      }))
      .sort((left, right) => rankOf({ id: left.id, kind: left.kind }) - rankOf({ id: right.id, kind: right.kind })
        || left.label.localeCompare(right.label))
    const enabledCount = [...cache.records.values()].filter(record => record.enabled && record.sourceEnabled).length
    return {
      version: STATE_VERSION,
      home: this.dshHome,
      libraryDir: this.libraryDir,
      scannedAt: new Date(cache.scannedAt).toISOString(),
      sources,
      skills: skillViews,
      stats: {
        total: cache.records.size,
        enabled: enabledCount,
      },
      session: options.sessionId === undefined ? null : {
        id: options.sessionId,
        cwd: options.cwd ?? null,
      },
      errors: cache.errors,
      ...(options.action === undefined ? {} : { action: options.action }),
    }
  }

  /**
   * @param {Record<string, any>} record
   * @param {boolean} primary - false for a duplicate shadowed by a higher-priority source.
   */
  skillView(record, primary) {
    const available = record.enabled === true && record.sourceEnabled === true
    return {
      name: record.name,
      originalName: record.originalName,
      description: record.description,
      ...(record.whenToUse === undefined ? {} : { whenToUse: record.whenToUse }),
      ecosystem: record.ecosystem,
      sourceId: record.sourceId,
      sourceLabel: record.sourceLabel,
      path: record.path,
      dir: record.dir,
      enabled: available,
      modelInvocable: record.invocation?.modelInvocable !== false,
      userInvocable: record.invocation?.userInvocable !== false,
      diagnostics: [...record.diagnostics],
      metadata: { ...record.metadata },
      ...(primary || record.shadowedBy === undefined ? {} : { shadowedBy: record.shadowedBy }),
    }
  }

  /**
   * Subscribe to library changes (a state mutation happened).
   * @param {(hint: { sessionId?: string }) => void} listener
   * @returns {() => void} disposer
   */
  onChange(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @param {{ sessionId?: string }} [hint] */
  notify(hint = {}) {
    for (const listener of [...this.listeners]) {
      try {
        listener(hint)
      } catch (error) {
        this.logger?.warn?.(`dsh-skill: change listener failed: ${errorMessage(error)}`)
      }
    }
  }

  /**
   * After a mutation, force a fresh snapshot for the caller's workspace.
   * `sessionId` only echoes `{ id, cwd }` into the snapshot; it never filters.
   * @param {{ cwd?: string, sessionId?: string, action?: object }} options
   */
  async afterMutation(options, { rescan = true } = {}) {
    if (rescan) this.invalidateScans()
    this.notify(options.sessionId === undefined ? {} : { sessionId: options.sessionId })
    return this.snapshot({ ...options, force: rescan })
  }

  /**
   * Enable or disable one skill globally.
   * @param {{ name: string, enabled: boolean, cwd?: string, sessionId?: string }} input
   */
  async setSkillEnabled(input) {
    const record = await this.getRecord(input.name, { cwd: input.cwd }) ?? this.recordAnywhere(input.name)
    if (record === undefined) throw libraryError('not-found', `unknown skill "${input.name}"`)
    const disabled = new Set(this.state.disabledSkills)
    if (input.enabled) disabled.delete(record.name)
    else disabled.add(record.name)
    this.state.disabledSkills = [...disabled].sort()
    await this.store.save()
    this.applyFlags()
    return this.afterMutation({
      cwd: input.cwd,
      sessionId: input.sessionId,
      action: { type: 'setSkillEnabled', name: record.name, enabled: input.enabled },
    }, { rescan: false })
  }

  /**
   * Enable or disable one source.
   * @param {{ sourceId: string, enabled: boolean, cwd?: string, sessionId?: string }} input
   */
  async setSourceEnabled(input) {
    const sourceId = input.sourceId
    if (sourceId === 'imported') throw libraryError('invalid-request', 'the managed skill library cannot be disabled')
    if (this.state.sources[sourceId] !== undefined) {
      this.state.sources[sourceId].enabled = input.enabled
    } else {
      this.state.autoSources[sourceId] = { enabled: input.enabled }
    }
    await this.store.save()
    this.applyFlags()
    return this.afterMutation({
      cwd: input.cwd,
      sessionId: input.sessionId,
      action: { type: 'setSourceEnabled', sourceId, enabled: input.enabled },
    }, { rescan: false })
  }

  /**
   * Register a user-selected source directory.
   * @param {{ path: string, label?: string, cwd?: string, sessionId?: string }} input
   */
  async addSource(input) {
    const path = resolveUserPath(input.path)
    let info
    try {
      info = await stat(path)
    } catch (error) {
      if (isMissing(error)) throw libraryError('source-error', `path does not exist: ${path}`)
      throw libraryError('source-error', `cannot inspect ${path}: ${errorMessage(error)}`)
    }
    if (!info.isDirectory()) throw libraryError('source-error', `not a directory: ${path}`)
    const id = customSourceId(path)
    const label = typeof input.label === 'string' && input.label.trim() !== ''
      ? input.label.trim()
      : path.split(/[\\/]/).filter(Boolean).pop() ?? path
    this.state.sources[id] = { path, label, enabled: true }
    await this.store.save()
    return this.afterMutation({
      cwd: input.cwd,
      sessionId: input.sessionId,
      action: { type: 'addSource', sourceId: id },
    })
  }

  /**
   * Remove a custom source (auto sources can only be disabled).
   * @param {{ sourceId: string, cwd?: string, sessionId?: string }} input
   */
  async removeSource(input) {
    if (this.state.sources[input.sourceId] === undefined) {
      throw libraryError('not-found', `no removable source "${input.sourceId}"`)
    }
    delete this.state.sources[input.sourceId]
    await this.store.save()
    return this.afterMutation({
      cwd: input.cwd,
      sessionId: input.sessionId,
      action: { type: 'removeSource', sourceId: input.sourceId },
    })
  }

  /**
   * Copy one or more ecosystem skill directories into the managed library.
   * @param {{ path: string, overwrite?: boolean, cwd?: string, sessionId?: string }} input
   */
  async importSkills(input) {
    const sourcePath = resolveUserPath(input.path)
    const result = await importSkillDirectories({
      sourcePath,
      libraryDir: this.libraryDir,
      overwrite: input.overwrite === true,
    })
    return this.afterMutation({
      cwd: input.cwd,
      sessionId: input.sessionId,
      action: { type: 'importSkill', imported: result.imported, skipped: result.skipped },
    })
  }

  /**
   * Remove one managed-library skill.
   * @param {{ name: string, cwd?: string, sessionId?: string }} input
   */
  async removeSkill(input) {
    const record = await this.getRecord(input.name, { cwd: input.cwd }) ?? this.recordAnywhere(input.name)
    if (record === undefined) throw libraryError('not-found', `unknown skill "${input.name}"`)
    if (record.sourceId !== 'imported') {
      throw libraryError('invalid-request', 'only skills in the managed library can be removed; disable or remove their source instead')
    }
    await removeManagedSkill({ libraryDir: this.libraryDir, name: record.name })
    return this.afterMutation({
      cwd: input.cwd,
      sessionId: input.sessionId,
      action: { type: 'removeSkill', name: record.name },
    })
  }

  /**
   * Author a new managed skill from UI input.
   * @param {{ name: string, description: string, instructions: string, whenToUse?: string,
   *           overwrite?: boolean, cwd?: string, sessionId?: string }} input
   */
  async createSkill(input) {
    const created = await createManagedSkill({
      libraryDir: this.libraryDir,
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      whenToUse: input.whenToUse,
      overwrite: input.overwrite === true,
    })
    return this.afterMutation({
      cwd: input.cwd,
      sessionId: input.sessionId,
      action: { type: 'createSkill', name: created.name },
    })
  }
}

/**
 * @typedef {object} Cache
 * @property {string} key
 * @property {string | undefined} cwd
 * @property {Map<string, import('./discovery.js').SourceCandidate>} candidates
 * @property {Map<string, Record<string, any>>} records
 * @property {Array<Record<string, any>>} shadowed
 * @property {Map<string, number>} sourceCounts
 * @property {Array<{ path: string, message: string, sourceId: string }>} errors
 * @property {number} scannedAt
 * @property {boolean} stale
 * @property {Promise<void> | undefined} promise
 */

/** @returns {Cache} */
function createCache(key, cwd) {
  return {
    key,
    cwd,
    candidates: new Map(),
    records: new Map(),
    shadowed: [],
    sourceCounts: new Map(),
    errors: [],
    scannedAt: 0,
    stale: true,
    promise: undefined,
  }
}

/**
 * Precedence of one source: imported wins, then custom sources, then project
 * roots, then user roots. Lower rank wins a duplicate skill name.
 * @param {{ id: string, kind?: string }} source
 * @returns {number}
 */
/**
 * Infer the ecosystem of a skill whose provider kind does not name one
 * (custom source directories): a path inside `.claude`/`.codex`/`.agents`
 * keeps its Claude/Codex compatibility preamble.
 * @param {string} kind - provider kind.
 * @param {string} path - absolute skill file path.
 * @returns {string} ecosystem label.
 */
function inferEcosystem(kind, path) {
  if (kind === 'custom') {
    const inferred = inferEcosystemFromPath(path)
    return inferred === 'custom' ? kind : inferred
  }
  return kind
}

/**
 * The ecosystem label of one discovered skill. Discovery labels custom sources
 * as `custom`; a path inside `.claude`/`.codex`/`.agents` keeps its real
 * ecosystem so the compatibility preamble applies.
 * @param {Record<string, any>} raw - discovery entry.
 * @param {string} kind - provider kind.
 * @returns {string}
 */
function ecosystemOfRecord(raw, kind) {
  if (kind === 'custom') {
    const inferred = inferEcosystemFromPath(raw.dir ?? raw.path ?? '')
    if (inferred !== 'custom') return inferred
  }
  return raw.ecosystem ?? inferEcosystem(kind, raw.dir ?? raw.path ?? '')
}

async function pathIsDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function rankOf(source) {
  if (source.id.startsWith('custom-')) return 10
  const known = AUTO_SOURCE_RANK[source.id]
  if (known !== undefined) return known
  // Plugin caches carry a per-plugin suffix (`claude-plugins:<name>`).
  if (source.id.startsWith('claude-plugins:')) return 32
  if (source.id.startsWith('codex-plugins:')) return 35
  return source.kind === 'custom' ? 10 : 60
}
