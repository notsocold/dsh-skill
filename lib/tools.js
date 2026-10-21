/**
 * Agent-facing `skill_library` tool.
 *
 * The management page and the agent call the same Host service methods; the
 * tool lets a user ask the assistant to inspect or extend the skill library
 * ("add my superpowers skills", "which skills are enabled").
 *
 * Explicit per-message invocation is not this tool's job: the user inserts a
 * `/<skill-name>` token from the composer skill button (or types it), and the
 * harness's own skill machinery injects that skill's full instructions for the
 * step. The tool may point the model at that mechanism.
 *
 * The tool is declared by hand (plain JSON Schema + render) because this
 * package intentionally has no dependency on Harness packages.
 *
 * @module dsh-skill/lib/tools
 */

import { errorMessage, libraryError } from './state.js'

/** Tool name exposed to the model. */
export const TOOL_NAME = 'skill_library'

const ACTIONS = [
  'list',
  'add_source',
  'import_skill',
  'create_skill',
  'set_enabled',
  'set_source_enabled',
  'remove_source',
  'remove_skill',
  'rescan',
]

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: 'Operation to perform on the user skill library.',
    },
    path: { type: 'string', description: 'Absolute (or ~) directory path for add_source/import_skill.' },
    label: { type: 'string', description: 'Optional display label for add_source.' },
    name: { type: 'string', description: 'Skill name for set_enabled/remove_skill/create_skill.' },
    description: { type: 'string', description: 'Short routing description for create_skill.' },
    instructions: { type: 'string', description: 'Markdown instructions body for create_skill.' },
    whenToUse: { type: 'string', description: 'Optional extra routing guidance for create_skill.' },
    sourceId: { type: 'string', description: 'Source id for set_source_enabled/remove_source (see action list).' },
    enabled: { type: 'boolean', description: 'Whether to enable the skill or source.' },
    overwrite: { type: 'boolean', description: 'Replace an existing managed skill/import with the same name.' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'message'],
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    details: { type: 'string' },
  },
}

/**
 * Build the tool definition over one library.
 * @param {{
 *   library: import('./library.js').SkillLibrary,
 *   resolveAgentCwd?: (agent: any) => Promise<string | undefined>,
 * }} options
 * @returns {Record<string, any>} a ToolDefinition accepted by `ctx.tools.register`.
 */
export function createSkillLibraryTool(options) {
  const { library, resolveAgentCwd } = options
  return {
    name: TOOL_NAME,
    description: 'Inspect or manage the user\'s external skill library (Claude Code / Codex / custom Agent Skills). Use action "list" first. This tool does not load skill instructions; use the `skill` tool for model-side loading, or tell the user to invoke a skill explicitly by inserting /<skill-name> in the composer (the Skill button does that).',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(args, value) {
        const lines = [String(value?.message ?? '')]
        if (typeof value?.details === 'string' && value.details !== '') lines.push('', value.details)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      if (typeof args !== 'object' || args === null || typeof args.action !== 'string') {
        throw libraryError('invalid-request', 'action is required')
      }
      const agent = exec?.agent
      const sessionId = agent === undefined ? undefined : String(agent.id)
      const cwd = agent === undefined || resolveAgentCwd === undefined
        ? undefined
        : await resolveAgentCwd(agent).catch(() => undefined)
      const result = await runAction({ library, args, sessionId, cwd })
      return result
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Skill library: ${String(args?.action ?? '')}`,
        kind: 'read',
        rawInput: String(args?.action ?? ''),
      }
    },
  }
}

/**
 * @param {{ library: import('./library.js').SkillLibrary, args: Record<string, any>,
 *           sessionId: string | undefined, cwd: string | undefined }} input
 */
async function runAction(input) {
  const { library, args, sessionId, cwd } = input
  switch (args.action) {
    case 'list': {
      const snapshot = await library.snapshot({ sessionId, cwd })
      return {
        ok: true,
        message: describeSnapshot(snapshot),
        details: formatSnapshot(snapshot),
      }
    }
    case 'rescan': {
      const snapshot = await library.snapshot({ sessionId, cwd, force: true })
      return { ok: true, message: `Rescanned skill sources: ${snapshot.skills.length} skills found.`, details: formatSkills(snapshot) }
    }
    case 'add_source': {
      const snapshot = await library.addSource({ path: requireString(args, 'path'), label: optionalString(args, 'label'), cwd, sessionId })
      return { ok: true, message: `Added source. ${describeSnapshot(snapshot)}`, details: formatSources(snapshot) }
    }
    case 'import_skill': {
      const snapshot = await library.importSkills({ path: requireString(args, 'path'), overwrite: args.overwrite === true, cwd, sessionId })
      const imported = snapshot.action?.imported ?? []
      return { ok: true, message: `Imported ${imported.length} skill(s) into the managed library.`, details: formatImported(imported, snapshot) }
    }
    case 'create_skill': {
      const snapshot = await library.createSkill({
        name: requireString(args, 'name'),
        description: requireString(args, 'description'),
        instructions: requireString(args, 'instructions'),
        whenToUse: optionalString(args, 'whenToUse'),
        overwrite: args.overwrite === true,
        cwd,
        sessionId,
      })
      return { ok: true, message: `Created skill "${args.name}". ${describeSnapshot(snapshot)}`, details: formatSkills(snapshot) }
    }
    case 'set_enabled': {
      const snapshot = await library.setSkillEnabled({ name: requireString(args, 'name'), enabled: requireBoolean(args, 'enabled'), cwd, sessionId })
      return { ok: true, message: `${args.enabled ? 'Enabled' : 'Disabled'} skill "${args.name}" globally.`, details: formatSkills(snapshot) }
    }
    case 'set_source_enabled': {
      const snapshot = await library.setSourceEnabled({ sourceId: requireString(args, 'sourceId'), enabled: requireBoolean(args, 'enabled'), cwd, sessionId })
      return { ok: true, message: `${args.enabled ? 'Enabled' : 'Disabled'} source "${args.sourceId}".`, details: formatSources(snapshot) }
    }
    case 'remove_source': {
      const snapshot = await library.removeSource({ sourceId: requireString(args, 'sourceId'), cwd, sessionId })
      return { ok: true, message: `Removed source "${args.sourceId}".`, details: formatSources(snapshot) }
    }
    case 'remove_skill': {
      const snapshot = await library.removeSkill({ name: requireString(args, 'name'), cwd, sessionId })
      return { ok: true, message: `Removed managed skill "${args.name}".`, details: formatSkills(snapshot) }
    }
    default:
      throw libraryError('invalid-request', `unknown action "${String(args.action)}"`)
  }
}

/** @param {Record<string, any>} snapshot */
function describeSnapshot(snapshot) {
  const total = snapshot.stats?.total ?? 0
  const enabled = snapshot.stats?.enabled ?? 0
  return `${total} library skill(s), ${enabled} enabled. Explicit invocation: insert /<skill-name> in the composer (the Skill button does that) or call the \`skill\` tool from a session.`
}

/** @param {Record<string, any>} snapshot */
function formatSnapshot(snapshot) {
  return [formatSources(snapshot), formatSkills(snapshot)].filter(part => part !== '').join('\n')
}

/** @param {Record<string, any>} snapshot */
function formatSources(snapshot) {
  const rows = (snapshot.sources ?? []).map(source => {
    const flags = [source.enabled ? 'enabled' : 'disabled', `${source.skillCount ?? 0} skills`]
    if (source.exists === false) flags.push('missing')
    return `- ${source.id} (${flags.join(', ')}) ${source.path}`
  })
  return rows.length === 0 ? 'sources: none' : `sources:\n${rows.join('\n')}`
}

/** @param {Record<string, any>} snapshot */
function formatSkills(snapshot) {
  const rows = (snapshot.skills ?? [])
    .filter(skill => skill.shadowedBy === undefined)
    .slice(0, 80)
    .map(skill => {
      const flags = [skill.ecosystem, skill.enabled ? 'enabled' : 'disabled']
      if (skill.modelInvocable === false) flags.push('user-only')
      if (skill.userInvocable === false) flags.push('model-only')
      return `- ${skill.name} [${flags.join(', ')}]: ${oneLine(skill.description)}`
    })
  const more = (snapshot.skills ?? []).length > 80 ? `\n- … ${(snapshot.skills ?? []).length - 80} more` : ''
  return rows.length === 0 ? 'skills: none discovered' : `skills:\n${rows.join('\n')}${more}`
}

/** @param {Array<{name: string, dir: string}>} imported @param {Record<string, any>} snapshot */
function formatImported(imported, snapshot) {
  const rows = imported.map(entry => `- ${entry.name} -> ${entry.dir}`)
  return [rows.length === 0 ? 'nothing imported' : `imported:\n${rows.join('\n')}`, formatSkills(snapshot)].join('\n')
}

/** @param {string} value */
function oneLine(value) {
  return String(value ?? '').replaceAll(/\s+/g, ' ').slice(0, 160)
}

/** @param {Record<string, any>} args @param {string} key */
function requireString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || value === '') throw libraryError('invalid-request', `"${key}" must be a non-empty string`)
  return value
}

/** @param {Record<string, any>} args @param {string} key */
function requireBoolean(args, key) {
  const value = args[key]
  if (typeof value !== 'boolean') throw libraryError('invalid-request', `"${key}" must be a boolean`)
  return value
}

/** @param {Record<string, any>} args @param {string} key */
function optionalString(args, key) {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw libraryError('invalid-request', `"${key}" must be a string`)
  return value
}

/** Exported for diagnostics/tests. */
export { errorMessage }
