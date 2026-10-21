/**
 * Model-facing compatibility preambles for imported ecosystem skills.
 *
 * Skills authored for Claude Code and Codex are mostly Markdown instructions that a
 * DSH model can follow, but their tool names, argument placeholders and bundled-file
 * conventions differ. {@link composeSkillContent} prepends a short, bounded
 * `<skill_compatibility>` block explaining those differences and substitutes Claude
 * plugin-root placeholders in the skill body when the real root is known.
 *
 * Composition never throws and never changes the body of native skills.
 *
 * @module dsh-skill/lib/compat
 */

/** Highest number of preamble lines promised to the model-facing prompt. */
const MAX_PREAMBLE_LINES = 12

const PLUGIN_ROOT_PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}'

const CLAUDE_CODE_ECOSYSTEMS = new Set(['claude', 'claude-code'])
const CODEX_ECOSYSTEMS = new Set(['codex'])

/**
 * Model-facing instructions for one loaded skill.
 *
 * - Claude skills get a short `<skill_compatibility source="claude-code">` block that
 *   maps Claude Code tool names to DSH tool names, explains `$ARGUMENTS` / `$1`..`$9`
 *   and `${CLAUDE_PLUGIN_ROOT}` (substituted with the real plugin root when known),
 *   and notes that Claude Code commands/hooks/agents are not installed.
 * - Codex prompt files get a `<skill_compatibility source="codex">` block explaining
 *   `$ARGUMENTS` / `$1`..`$9` substitution and that the body was authored as a Codex
 *   custom prompt.
 * - Other ecosystems (agents, custom, imported, dsh) keep their body unchanged with no
 *   preamble.
 *
 * Substitutions are applied to the body text only.
 *
 * @param {import('./discovery.js').RawSkill} skill - skill record; `content` is the
 *   Markdown body without frontmatter.
 * @returns {string} model-facing content (preamble plus possibly substituted body).
 */
export function composeSkillContent(skill) {
  if (!isRecord(skill)) return ''
  const content = typeof skill.content === 'string' ? skill.content : ''
  const ecosystem = ecosystemOf(skill)

  if (CLAUDE_CODE_ECOSYSTEMS.has(ecosystem)) {
    const body = substitutePluginRoot(content, skill.pluginRoot)
    return joinPreamble(claudePreamble(skill.pluginRoot), body)
  }
  if (CODEX_ECOSYSTEMS.has(ecosystem)) {
    return joinPreamble(codexPreamble(), content)
  }
  return content
}

/**
 * @param {unknown} pluginRoot - known plugin root, when available.
 * @returns {string} Claude Code compatibility preamble.
 */
function claudePreamble(pluginRoot) {
  const rootNote = typeof pluginRoot === 'string' && pluginRoot !== ''
    ? `\`${PLUGIN_ROOT_PLACEHOLDER}\` resolves to the plugin root at ${pluginRoot}.`
    : `\`${PLUGIN_ROOT_PLACEHOLDER}\` refers to the root directory of the plugin that bundled this skill.`
  const lines = [
    '<skill_compatibility source="claude-code">',
    'This skill was authored for Claude Code. Map its tool names to DSH tools:',
    'Bash→bash, Read→read, Edit→edit, Write→write, Glob→glob, Grep→grep,',
    'WebFetch→web_fetch, WebSearch→web_search, Task→subagent, TodoWrite→todo_write,',
    'AskUserQuestion→ask_user_question, ExitPlanMode→exit_plan_mode, Skill→skill.',
    '`$ARGUMENTS` and `$1`..`$9` are literal user arguments for this command, not tool calls.',
    rootNote,
    'Claude Code commands, hooks and agent types are not installed in DSH.',
    '</skill_compatibility>',
  ]
  return lines.slice(0, MAX_PREAMBLE_LINES).join('\n')
}

/**
 * @returns {string} Codex custom-prompt compatibility preamble.
 */
function codexPreamble() {
  const lines = [
    '<skill_compatibility source="codex">',
    'This skill was authored as a Codex custom prompt.',
    '`$ARGUMENTS` and `$1`..`$9` are placeholders for the user\'s arguments; fill them from the',
    'current user message instead of treating them as commands or tool calls.',
    'Codex-only commands and configuration are not installed in DSH.',
    '</skill_compatibility>',
  ]
  return lines.slice(0, MAX_PREAMBLE_LINES).join('\n')
}

/**
 * @param {string} preamble - compatibility block.
 * @param {string} body - skill body, possibly empty.
 * @returns {string} combined content (no trailing blank block for an empty body).
 */
function joinPreamble(preamble, body) {
  if (body === '') return preamble
  return `${preamble}\n\n${body}`
}

/**
 * Replace `${CLAUDE_PLUGIN_ROOT}` in the body when the real root is known.
 *
 * @param {string} body - skill body.
 * @param {unknown} pluginRoot - absolute plugin root, when known.
 * @returns {string} body with the placeholder substituted (unchanged when unknown).
 */
function substitutePluginRoot(body, pluginRoot) {
  if (typeof pluginRoot !== 'string' || pluginRoot === '') return body
  if (!body.includes(PLUGIN_ROOT_PLACEHOLDER)) return body
  return body.split(PLUGIN_ROOT_PLACEHOLDER).join(pluginRoot)
}

/**
 * @param {Record<string, unknown>} skill - skill record.
 * @returns {string} ecosystem bucket, tolerating a missing field for hand-made records.
 */
function ecosystemOf(skill) {
  if (typeof skill.ecosystem === 'string' && skill.ecosystem !== '') return skill.ecosystem
  if (typeof skill.kind === 'string' && skill.kind !== '') return skill.kind
  return ''
}

/**
 * @param {unknown} value - candidate.
 * @returns {boolean} whether the value is a plain record.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
