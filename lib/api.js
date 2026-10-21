/**
 * Host HTTP API for the browser half.
 *
 * The routes are registered through `ctx.connection.fetch`, so they live
 * inside the authenticated `/api` fence: only the page's owner Peer reaches
 * them, and the ordinary browser `fetch` cookie applies. The browser never
 * needs a Remote binding or generated client code.
 *
 * @module dsh-skill/lib/api
 */

import { apiErrorOf, libraryError } from './state.js'

/** Shared path prefix of every dsh-skill route. */
export const API_PREFIX = '/api/dsh-skill'

/**
 * Build the three exact Fetch routes.
 * @param {{
 *   library: import('./library.js').SkillLibrary,
 *   resolveSessionCwd?: (sessionId: string) => Promise<string | undefined>,
 * }} options
 * @returns {import('@deepseek-ai/dsh-client-connection').ConnectionFetchRoute[]}
 */
export function apiRoutes(options) {
  const { library, resolveSessionCwd } = options
  return [
    {
      path: `${API_PREFIX}/state`,
      methods: /** @type {const} */ (['GET']),
      requestBody: 'buffered',
      async fetch(request) {
        const sessionId = sessionIdOf(request)
        const cwd = await cwdOf(resolveSessionCwd, sessionId)
        try {
          return ok(await library.snapshot({ sessionId, cwd }))
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      path: `${API_PREFIX}/action`,
      methods: /** @type {const} */ (['POST']),
      requestBody: 'buffered',
      async fetch(request) {
        let body
        try {
          body = await request.json()
        } catch {
          return fatal('invalid-request', 'request body must be a JSON object', 400)
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          return fatal('invalid-request', 'request body must be a JSON object', 400)
        }
        const action = typeof body.action === 'string' ? body.action : ''
        const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
        const cwd = await cwdOf(resolveSessionCwd, sessionId)
        try {
          const value = await dispatch({ library, action, body, sessionId, cwd })
          return ok(value)
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      path: `${API_PREFIX}/skill`,
      methods: /** @type {const} */ (['GET']),
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url, 'http://dsh.invalid')
        const name = url.searchParams.get('name') ?? ''
        if (!isSkillName(name)) return fatal('invalid-request', 'a valid skill name is required', 400)
        const sessionId = typeof url.searchParams.get('sessionId') === 'string'
          ? url.searchParams.get('sessionId') ?? undefined
          : undefined
        const cwd = await cwdOf(resolveSessionCwd, sessionId)
        try {
          const skill = await library.skillContent(name, { cwd })
          if (skill === undefined) throw libraryError('not-found', `unknown skill "${name}"`)
          return ok(skill)
        } catch (error) {
          return failure(error)
        }
      },
    },
  ]
}

/**
 * @param {{
 *   library: import('./library.js').SkillLibrary,
 *   action: string,
 *   body: Record<string, any>,
 *   sessionId: string | undefined,
 *   cwd: string | undefined,
 * }} input
 */
async function dispatch(input) {
  const { library, action, body, sessionId, cwd } = input
  switch (action) {
    case 'rescan':
      return library.snapshot({ sessionId, cwd, force: true })
    case 'setSkillEnabled':
      return library.setSkillEnabled({
        name: requireString(body, 'name'),
        enabled: requireBoolean(body, 'enabled'),
        cwd,
        sessionId,
      })
    case 'setSourceEnabled':
      return library.setSourceEnabled({
        sourceId: requireString(body, 'sourceId'),
        enabled: requireBoolean(body, 'enabled'),
        cwd,
        sessionId,
      })
    case 'addSource':
      return library.addSource({
        path: requireString(body, 'path'),
        label: optionalString(body, 'label'),
        cwd,
        sessionId,
      })
    case 'removeSource':
      return library.removeSource({
        sourceId: requireString(body, 'sourceId'),
        cwd,
        sessionId,
      })
    case 'importSkill':
      return library.importSkills({
        path: requireString(body, 'path'),
        overwrite: body.overwrite === true,
        cwd,
        sessionId,
      })
    case 'removeSkill':
      return library.removeSkill({
        name: requireString(body, 'name'),
        cwd,
        sessionId,
      })
    case 'createSkill':
      return library.createSkill({
        name: requireString(body, 'name'),
        description: requireString(body, 'description'),
        instructions: requireString(body, 'instructions'),
        whenToUse: optionalString(body, 'whenToUse'),
        overwrite: body.overwrite === true,
        cwd,
        sessionId,
      })
    default:
      throw libraryError('invalid-request', `unknown action "${action}"`)
  }
}

/**
 * @param {string} code - stable error code.
 * @param {string} message - human-readable reason.
 * @returns {Response}
 */
function ok(value) {
  return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
}

/**
 * @param {unknown} error - thrown value.
 * @returns {Response}
 */
function failure(error) {
  const { code, message } = apiErrorOf(error)
  return Response.json(
    { ok: false, error: { code, message } },
    { status: code === 'internal' ? 500 : 200, headers: { 'cache-control': 'no-store' } },
  )
}

/**
 * @param {string} code - stable error code.
 * @param {string} message - human-readable reason.
 * @param {number} status - HTTP status.
 * @returns {Response}
 */
function fatal(code, message, status) {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: { 'cache-control': 'no-store' } },
  )
}

/** @param {Request} request @returns {string | undefined} */
function sessionIdOf(request) {
  const url = new URL(request.url, 'http://dsh.invalid')
  const value = url.searchParams.get('sessionId')
  return value === null || value === '' ? undefined : value
}

/**
 * @param {((sessionId: string) => Promise<string | undefined>) | undefined} resolver
 * @param {string | undefined} sessionId
 * @returns {Promise<string | undefined>}
 */
async function cwdOf(resolver, sessionId) {
  if (resolver === undefined || sessionId === undefined) return undefined
  try {
    const cwd = await resolver(sessionId)
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/** @param {Record<string, any>} body @param {string} key @returns {string} */
function requireString(body, key) {
  const value = body[key]
  if (typeof value !== 'string' || value === '') throw libraryError('invalid-request', `"${key}" must be a non-empty string`)
  return value
}

/** @param {Record<string, any>} body @param {string} key @returns {boolean} */
function requireBoolean(body, key) {
  const value = body[key]
  if (typeof value !== 'boolean') throw libraryError('invalid-request', `"${key}" must be a boolean`)
  return value
}

/** @param {Record<string, any>} body @param {string} key @returns {string | undefined} */
function optionalString(body, key) {
  const value = body[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw libraryError('invalid-request', `"${key}" must be a string`)
  return value
}

/** Skill-name grammar shared with the DSH skill registry. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** @param {string} name @returns {boolean} */
function isSkillName(name) {
  return SKILL_NAME.test(name)
}
