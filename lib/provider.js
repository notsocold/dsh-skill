/**
 * Global skill provider.
 *
 * The library is process-wide: `ctx.skills.registerProvider()` registers this
 * provider into the global registry layer, so every session sees the same
 * enabled skill catalog. Explicit per-message invocation is the harness's own
 * `/<name>` gesture (the built-in `skill` tool injects the rendered body for
 * that step); this provider only advertises and loads what is globally enabled.
 *
 * Any library change calls `control.invalidate()`, which makes the built-in
 * `skill` tool republish a replacement model catalog on the next step.
 *
 * @module dsh-skill/lib/provider
 */

import { composeSkillContent } from './compat.js'

/** Provider name shown in skill metadata and duplicate diagnostics. */
export const PROVIDER_NAME = 'dsh-skill'
/** Registry rank of this provider's candidates (within the global layer). */
export const PROVIDER_RANK = 250

/**
 * Build the library provider.
 * @param {{ library: import('./library.js').SkillLibrary }} options
 * @returns {{ provider: import('@deepseek-ai/dsh-skill').SkillProvider, attach(control: any): void, invalidate(): void }}
 */
export function createLibraryProvider(options) {
  const { library } = options
  /** @type {any} */
  let control

  return {
    provider: {
      name: PROVIDER_NAME,
      async list(lookup = {}) {
        const skills = await library.visibleSkills({ cwd: lookup.cwd })
        return skills.map(record => candidateOf(record))
      },
      async get(candidate, lookup = {}) {
        const name = candidate?.name
        if (typeof name !== 'string' || name === '') return undefined
        const skills = await library.visibleSkills({ cwd: lookup.cwd })
        const record = skills.find(skill => skill.name === name)
        if (record === undefined) return undefined
        return definitionOf(record)
      },
    },
    /** Retain the registration's invalidation control. */
    attach(providerControl) {
      control = providerControl
    },
    /** Invalidate the registry's cached catalog so consumers republish. */
    invalidate() {
      try {
        control?.invalidate()
      } catch {
        // A disposed registration cannot invalidate; the next activation re-registers.
      }
    },
  }
}

/**
 * @param {Record<string, any>} record - library record.
 * @returns {import('@deepseek-ai/dsh-skill').SkillCandidate} registry candidate.
 */
function candidateOf(record) {
  return {
    name: record.name,
    description: record.description,
    ...(record.whenToUse === undefined ? {} : { whenToUse: record.whenToUse }),
    invocation: { ...record.invocation },
    source: record.ecosystem,
    provider: PROVIDER_NAME,
    rank: PROVIDER_RANK,
    locator: { name: record.name },
    path: record.path,
    ...(hasKeys(record.metadata) ? { metadata: { ...record.metadata } } : {}),
  }
}

/**
 * @param {Record<string, any>} record - library record.
 * @returns {import('@deepseek-ai/dsh-skill').SkillDefinition} registry definition.
 */
function definitionOf(record) {
  return {
    name: record.name,
    description: record.description,
    ...(record.whenToUse === undefined ? {} : { whenToUse: record.whenToUse }),
    invocation: { ...record.invocation },
    source: record.ecosystem,
    provider: PROVIDER_NAME,
    path: record.path,
    resourceBase: { kind: 'directory', path: record.dir },
    ...(hasKeys(record.metadata) ? { metadata: { ...record.metadata } } : {}),
    content: composeSkillContent(record),
  }
}

/** @param {unknown} value @returns {boolean} */
function hasKeys(value) {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0
}
