/**
 * dsh-skill host plugin.
 *
 * Responsibilities:
 * 1. Own the skill library (persisted state + discovered external skills).
 * 2. Register one global `ctx.skills` provider so every session sees the
 *    enabled library skills; the built-in `skill` tool republishes its catalog
 *    whenever the provider invalidates. Explicit per-message invocation is the
 *    harness's own `/<name>` gesture from the composer (the composer button in
 *    `client.js` only inserts that token), so no per-session filtering lives
 *    here.
 * 3. Serve the authenticated `/api/dsh-skill/*` routes used by the browser
 *    half (`client.js`: Skills settings page + composer skill button).
 *
 * @module @local/dsh-skill
 */

import { homedir } from 'node:os'
import { apiRoutes } from './lib/api.js'
import { SkillLibrary } from './lib/library.js'
import { createLibraryProvider } from './lib/provider.js'
import { StateStore, errorMessage } from './lib/state.js'
import { createSkillLibraryTool } from './lib/tools.js'

/** Cordis plugin name. */
export const name = 'dsh-skill'
/** Services required before activation. */
export const inject = ['agents', 'connection', 'skills', 'tools']

/**
 * Host plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export async function apply(ctx) {
  const store = new StateStore()
  // Ecosystem roots are resolved against the USER home; the state file and
  // managed library live below $DSH_HOME.
  const library = new SkillLibrary({ store, home: homedir(), dshHome: store.home, logger: ctx.logger })
  await library.load()

  // Warm the user-level catalog so the first catalog read and the first
  // settings-page request do not each pay for a full discovery pass.
  try {
    await library.context({ force: true })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-skill: initial skill discovery failed: ${errorMessage(error)}`)
  }

  // One process-wide provider in the global registry layer. Skill availability
  // is global; per-message forcing happens through the harness's `/<name>`
  // gesture, which the built-in skill tool already understands.
  const provider = createLibraryProvider({ library })
  ctx.effect(
    () => ctx.skills.registerProvider((control) => {
      provider.attach(control)
      return provider.provider
    }),
    'dsh-skill: skill provider',
  )

  // One state change republishes the catalog: invalidating the registry cache
  // makes the built-in skill tool recompute and re-inject its catalog message.
  ctx.effect(
    () => library.onChange(() => { provider.invalidate() }),
    'dsh-skill: catalog invalidation',
  )

  /**
   * Resolve the workspace directory of one live session for project-root
   * discovery (`.claude/skills`, `.codex/skills`, `.dsh/skills`, `.agents/skills`).
   * @param {string} sessionId - session identity sent by the browser.
   * @returns {Promise<string | undefined>}
   */
  const resolveSessionCwd = async (sessionId) => {
    try {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) return undefined
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory === undefined) return undefined
      return await workingDirectory.ensure(agent)
    } catch {
      return undefined
    }
  }

  // Model-facing management tool: the same operations the settings page uses.
  ctx.effect(
    () => ctx.tools.register(createSkillLibraryTool({
      library,
      resolveAgentCwd: async (agent) => {
        try {
          return await resolveSessionCwd(String(agent.id))
        } catch {
          return undefined
        }
      },
    })),
    'dsh-skill: skill_library tool',
  )

  const routes = apiRoutes({ library, resolveSessionCwd })
  ctx.effect(async () => {
    const disposers = []
    try {
      for (const route of routes) disposers.push(await ctx.connection.fetch.register(route))
    } catch (error) {
      for (const dispose of disposers) {
        try {
          await dispose()
        } catch {
          // Containment only: the route registry is being rolled back anyway.
        }
      }
      throw error
    }
    return async () => {
      for (const dispose of disposers) {
        try {
          await dispose()
        } catch {
          // Route removal during host teardown is best-effort.
        }
      }
    }
  }, 'dsh-skill: http routes')

  ctx.logger?.info?.(`dsh-skill: skill library at ${store.libraryDir}`)
}
