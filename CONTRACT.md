# dsh-skill internal contract (v1)

`dsh-skill` is a DeepSeek Harness (DSH) plugin **bundle** for the Web profile. It has two faces:

- **Host half** (`index.js` + `lib/*.js`): discovers Agent Skills from the Claude and Codex
  ecosystems, persists a small state file, registers a **per-Agent** `ctx.skills` provider so the
  built-in `skill` tool / skill catalog expose the enabled skills, and serves a small JSON API to
  the browser over `ctx.connection.fetch`.
- **Client half** (`client.js`): a lazy browser module (react from the shared module table) that
  renders (1) a **Skills settings page** and (2) a **composer skill button** for Claude-Desktop-style
  **explicit skill invocation** (it inserts `/<skill-name>` into the draft; the harness's built-in
  skill machinery injects that skill's full instructions for the step).

Everything is plain ESM JavaScript (Node). No npm dependencies, no TypeScript, no imports of DSH
packages: host code talks to services through `ctx`, client code requires only `react`.

## Package layout and ownership

```
package.json          Lead
cordis.patch.yml      Lead
icon.svg              UI teammate
locale/en.json        UI teammate
locale/zh.json        UI teammate
index.js              Lead          plugin entry (host)
client.js             UI teammate   browser bundle (window.__ModuleLoader__.load)
lib/state.js          Lead          persistent store + file operations
lib/library.js        Lead          discovery orchestration, selection, source registry
lib/provider.js       Lead          per-Agent ctx.skills provider
lib/api.js            Lead          ctx.connection.fetch routes
lib/skillfiles.js     Lead          managed-library copy/create/remove helpers
lib/tools.js          Lead          agent-facing `skill_library` tool
lib/frontmatter.js    Ecosystem     YAML frontmatter + name/invocation normalization
lib/discovery.js      Ecosystem     Claude/Codex/DSH ecosystem source discovery + scanning
lib/compat.js         Ecosystem     compatibility preamble / placeholder rewriting
test/*.test.js        each owner for its own module
```

**Write scopes are disjoint.** Do not edit files outside your scope; report a needed change to the
Lead instead.

## Domain terms

- **source** — one directory that may contain skills (a user root, a project root, a plugin cache
  `skills/` dir, a custom folder, the managed library).
- **record** — one discovered skill: normalized metadata pointing at a `SKILL.md` (or a Codex
  prompt `.md`).
- **managed library** — `$DSH_HOME/dsh-skill/skills/<name>/SKILL.md`, the only place this plugin
  writes skill files. Imported and user-created skills live here.
- **explicit invocation** — the user forces one skill for a message by inserting a `/skill-name`
  token (the composer button does this). The built-in `skill` tool injects the rendered skill body
  into that step deterministically; it also works for user-invocable-only skills the model catalog
  never advertises. Availability itself is global (enabled + source enabled).

## State file: `$DSH_HOME/dsh-skill/state.json`

`$DSH_HOME` defaults to `process.env.DSH_HOME`, then `~/.dsh`. The file is JSON, written atomically
(`state.json.tmp` + rename). Missing or unreadable file means defaults; a corrupt file is backed up
to `state.json.broken-<timestamp>` and defaults are used.

```jsonc
{
  "version": 2,
  "sources": {
    // user-managed extra source directories, keyed by generated id "custom-<hash8>"
    "custom-1a2b3c4d": { "path": "/abs/dir", "label": "My skills", "enabled": true }
  },
  "autoSources": {
    // per auto source id: enabled flag. Omitted = default (enabled).
    "claude-user": { "enabled": true }
  },
  "disabledSkills": ["name-a", "name-b"]   // globally disabled record names
}
```

Version 2 removed the v1 `sessions` per-session selection table (the feature was replaced by
explicit invocation). Legacy files still load: those rows are ignored and disappear on the next
save. Availability is global; explicit invocation is per message and creates no persistent state.

Auto source ids (stable, never contain a path):
`claude-user`, `claude-desktop`, `claude-plugins`, `codex-user`, `codex-prompts`, `codex-plugins`,
`agents-user`, `dsh-user` (read-only display only; not listed through this provider),
`claude-project`, `codex-project`, `agents-project`, `dsh-project` (only when a cwd is known),
`imported` (the managed library, always enabled/not removable).

## Module contracts

### `lib/frontmatter.js` (ecosystem teammate)

```js
/** Parse leading YAML frontmatter without dependencies. Handles the common subset:
 *  key: value, quoted strings, booleans/numbers, inline arrays, block scalars (|, >),
 *  simple lists (- item), nested maps one level, comments. Unknown constructs are
 *  ignored, never throw. @returns {{data: Record<string, unknown>, body: string} | undefined} */
export function parseFrontmatter(raw)

/** kebab-case normalize a skill name (lowercase a-z0-9 + single dashes), max 64 chars.
 *  Returns '' when nothing usable remains. */
export function slugifySkillName(value)

/** Normalize frontmatter + directory/file facts into a record identity.
 *  Tolerant across ecosystems: missing name -> dirName; missing description -> first
 *  non-empty body line truncated to 200 chars (diagnostic recorded); invalid name is
 *  slugified (diagnostic); both `whenToUse` and `when_to_use` accepted; invocation from
 *  `disable-model-invocation` / `user-invocable` (boolean or string forms) and the
 *  legacy Claude aliases (`disableModelInvocation`, `modelInvocable`, `userInvocable`)
 *  mapped with a diagnostic rather than rejected.
 *  @param {{data: Record<string, unknown>, dirName: string, filePath: string, body: string}} input
 *  @returns {{name: string, originalName: string, description: string,
 *             whenToUse?: string,
 *             invocation: {modelInvocable: boolean, userInvocable: boolean},
 *             metadata: Record<string, unknown>, diagnostics: string[]}}
 */
export function normalizeSkillFrontmatter(input)
```

`metadata` keeps remaining frontmatter keys (not `name`/`description`/`when_to_use` and not the
invocation keys) so the UI can display them. Keep it JSON-safe.

### `lib/discovery.js` (ecosystem teammate)

```js
/**
 * @typedef {object} SourceCandidate
 * @property {string} id        stable source id (see state file auto ids or 'custom-<hash8>')
 * @property {string} path      absolute directory
 * @property {'claude'|'codex'|'agents'|'dsh'|'custom'|'imported'} kind
 * @property {string} label     human label, e.g. "Claude Code skills", "Superpowers (plugin)"
 * @property {boolean} auto     true for auto-detected roots
 * @property {boolean} exists   directory exists
 * @property {number} skillCount number of skill dirs/files found (0 when missing)
 * @property {string} [plugin]  plugin folder name for plugin-cache sources
 */

/** Enumerate auto-detected + custom sources for the current machine/session.
 *  Never throws: unreadable roots are skipped/annotated.
 *  @param {{cwd?: string, customSources?: Array<{id:string,path:string,label:string,enabled:boolean}>, home?: string}} options
 *  @returns {Promise<SourceCandidate[]>}
 */
export async function candidateSources(options)

/** Scan one source for skills. Directory sources: each child directory containing
 *  SKILL.md, plus (for Codex prompt dirs) top-level *.md prompt files. Recursive
 *  bounded walk is allowed (depth-limited, e.g. maxDepth 6 / maxEntries 2000) for
 *  plugin caches; deterministic ordering.
 *  Never throws per-entry: unreadable/invalid skills become entries in `errors`.
 *  @param {SourceCandidate} source
 *  @returns {Promise<{skills: RawSkill[], errors: {path:string,message:string,sourceId:string}[]}>}
 */
export async function scanSource(source)

/** Scan many sources sequentially, merging in input order.
 *  @param {SourceCandidate[]} sources
 *  @returns {Promise<{skills: RawSkill[], errors: {path:string,message:string,sourceId:string}[]}>}
 */
export async function scanSources(sources)
```

`RawSkill`:

```js
{
  name: string,                 // normalized kebab-case
  originalName: string,
  description: string,
  whenToUse?: string,
  invocation: { modelInvocable: boolean, userInvocable: boolean },
  sourceId: string,             // source.id
  kind: string,                 // source.kind
  ecosystem: 'claude'|'codex'|'agents'|'dsh'|'custom'|'imported',
  path: string,                 // absolute SKILL.md / prompt .md path
  dir: string,                  // absolute skill directory (file's dirname for prompt files)
  pluginRoot?: string,          // absolute plugin root, for ${CLAUDE_PLUGIN_ROOT} substitution
  metadata: Record<string, unknown>,
  diagnostics: string[],
  content: string,              // body without frontmatter, trimmed
}
```

Discovery roots (at minimum; more is welcome when researched):

| id | path |
|---|---|
| `claude-user` | `$CLAUDE_CONFIG_DIR`/`~/.claude` + `/skills` |
| `claude-desktop` | `~/Documents/Claude/Skills`, `~/Library/Application Support/Claude/skills`, `~/.config/Claude/skills`, `%APPDATA%/Claude/skills` |
| `claude-plugins` | `~/.claude/plugins` (deep scan for `skills/*/SKILL.md`; also `marketplaces`) |
| `codex-user` | `$CODEX_HOME`/`~/.codex` + `/skills` |
| `codex-prompts` | `~/.codex/prompts` (top-level `*.md` custom prompts) |
| `codex-plugins` | `~/.codex/plugins` (deep scan for `skills/`) |
| `agents-user` | `~/.agents/skills` |
| `dsh-user` | `~/.dsh/skills` (display/scan only) |
| `claude-project` | `<projectRoot>/.claude/skills` |
| `codex-project` | `<projectRoot>/.codex/skills` |
| `agents-project` | `<projectRoot>/.agents/skills` |
| `dsh-project` | `<projectRoot>/.dsh/skills` |
| `imported` | `$DSH_HOME/dsh-skill/skills` |

Project root = nearest ancestor of `cwd` containing `.git`, else `cwd` itself.

### `lib/compat.js` (ecosystem teammate)

```js
/** Model-facing instructions for one loaded skill.
 *  - Claude skills: prepend a short <skill_compatibility> block that maps Claude Code tool
 *    names to DSH tool names (Bash->bash, Read->read, Edit->edit, Write->write, Glob->glob,
 *    Grep->grep, WebFetch->web_fetch, WebSearch->web_search, Task->subagent,
 *    TodoWrite->todo_write, AskUserQuestion->ask_user_question, ExitPlanMode->exit_plan_mode,
 *    Skill->skill), explains $ARGUMENTS and ${CLAUDE_PLUGIN_ROOT} (substituted with the real
 *    plugin root when known), and notes that Claude Code commands/hooks are not installed.
 *  - Codex prompt files: prepend a <skill_compatibility> block explaining $ARGUMENTS /
 *    $1..$9 substitution and that the body was authored as a Codex custom prompt.
 *  - Other ecosystems: body unchanged, no preamble.
 *  Substitutions are applied to the body text only. Keep the preamble short (<= ~12 lines).
 *  @param {RawSkill} skill
 *  @returns {string}
 */
export function composeSkillContent(skill)
```

### Host library/provider/API (Lead)

- `lib/library.js`: `class SkillLibrary` — owns `SkillState`, scans sources (TTL cache),
  dedupes by name, exposes `snapshot({cwd, sessionId})`, `visibleSkills({cwd, sessionId})`,
  `getRecord(name)`, `loadContent(name)`, and mutation methods used by both the HTTP API and the
  Agent provider.
- `lib/provider.js`: one **global** provider named `dsh-skill`, registered by `index.apply` through
  `ctx.skills.registerProvider()`, so every session sees the same enabled catalog. Candidates are
  `visibleSkills` (enabled + source enabled); any state change calls `control.invalidate()` so the
  model-facing catalog is republished by the built-in `skill` tool. There is no per-session or
  per-Agent filtering — per-message forcing is the harness's own `/<name>` gesture.
- `lib/tools.js`: builds the agent-facing `skill_library` tool over the same library service
  methods (`list`, `add_source`, `import_skill`, `create_skill`, `set_enabled`,
  `set_source_enabled`, `remove_source`, `remove_skill`, `rescan`). Input is
  validated manually; output is `{ok, message, details?}` rendered as text. The user-owned
  per-session selection is only changed when the user asks for it in conversation.
- Managed-library imports preserve their ecosystem origin in a sidecar file
  `<skillDir>/.dsh-skill-origin.json` (`{ecosystem, pluginRoot?, sourcePath, importedAt}`), so the
  Claude/Codex compatibility preamble survives the copy; the library applies it during scanning.
- `lib/api.js`: exact Fetch routes inside the authenticated `/api` fence:
  - `GET /api/dsh-skill/state?sessionId=...`
  - `POST /api/dsh-skill/action` with `{action, ...}` (see below)
  - `GET /api/dsh-skill/skill?name=...` (loaded instructions for preview)

## HTTP API (frozen for the client)

All responses are JSON: `200 { "ok": true, "value": ... }` or
`{ "ok": false, "error": { "code": string, "message": string } }` (200 for action-level failures,
4xx for malformed requests). `cache-control: no-store`.

### `GET /api/dsh-skill/state?sessionId=<optional>`

```ts
{
  ok: true,
  value: {
    version: 1,
    home: string,                 // DSH home
    libraryDir: string,           // managed library absolute path
    scannedAt: string,            // ISO
    sources: SourceView[],        // all known sources (auto + custom + imported)
    skills: SkillView[],          // every discovered record (enabled or not)
    stats: { total: number, enabled: number },
    session: null | { id: string, cwd: string | null },  // cwd drives project-root discovery

    errors: { path: string, message: string, sourceId: string }[]
  }
}

type SourceView = {
  id: string,
  path: string,
  kind: string,                   // claude | codex | agents | dsh | custom | imported
  label: string,
  auto: boolean,
  enabled: boolean,               // source toggle (imported is always true)
  exists: boolean,
  skillCount: number,
  removable: boolean,             // custom sources: true; auto/imported: false
  plugin?: string,
}

type SkillView = {
  name: string,
  originalName: string,
  description: string,
  whenToUse?: string,
  ecosystem: string,
  sourceId: string,
  sourceLabel: string,
  path: string,
  dir: string,
  enabled: boolean,               // global enable (source enabled AND not in disabledSkills)
  modelInvocable: boolean,
  userInvocable: boolean,
  diagnostics: string[],
  metadata: Record<string, unknown>,
  shadowedBy?: string,            // set on a duplicate record hidden by a higher-priority one
}
```

### `POST /api/dsh-skill/action`

Body: `{ action: string, sessionId?: string, ... }`. Every successful result returns the same
`value` shape as `GET state` (recomputed with the same `sessionId`). Actions:

| action | payload | notes |
|---|---|---|
| `rescan` | — | force rescan |
| `setSkillEnabled` | `name`, `enabled` | global disable list |
| `setSourceEnabled` | `sourceId`, `enabled` | auto/custom sources |
| `addSource` | `path`, `label?` | absolute or `~/...`; must exist and contain skills; custom source |
| `removeSource` | `sourceId` | custom sources only |
| `importSkill` | `path`, `overwrite?` | copy a skill dir (or a `SKILL.md` file's parent) into the managed library |
| `removeSkill` | `name` | managed-library skills only |
| `createSkill` | `name`, `description`, `instructions`, `whenToUse?` | write a new managed skill |

Errors codes: `invalid-request`, `not-found`, `already-exists`, `io-error`, `source-error`.

### `GET /api/dsh-skill/skill?name=<name>&sessionId=<optional>`

```ts
{ ok: true, value: { name, path, dir, ecosystem, content } }  // content = composeSkillContent(record)
```

## Client contract (`client.js`)

The bundle is the lazy-CJS factory form:

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-skill',
  factory(require) {
    const React = require('react')
    // components ...
    return { inject: ['slots', 'locale'], apply(ctx) { /* registrations */ } }
  },
})
```

Register exactly:

1. `ctx.effect(() => ctx.locale.register('dsh-skill', { zh, en }), ...)`
2. `ctx.slots.inject('settings.section', () => ctx.slots.register({
     name: 'settings.section', id: 'skills', order: 25, label: () => t('nav'), locale: NS,
   }, SkillSettingsSection))`
3. `ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
     name: 'conversation.input.left', id: 'dsh-skill-invoke', order: 40, locale: NS,
   }, SkillInvokeButton))`

The button receives `sessionId` and `inputActions` props. Both components talk to the Host with
`fetch('/api/dsh-skill/...', { credentials: 'same-origin', ... })`; the settings page has no
session, the invoker passes `sessionId` so project-root skills resolve.

Expected UX:

- Settings page: title + intro (auto availability by description vs explicit composer invocation),
  an **Add** split menu (import folder / add source folder / create skill) opening the in-plugin
  directory chooser (browse capability; native picker fallback), auto-detected source rows, a
  searchable skill list with enable switches, ecosystem badges, expandable details (path,
  description, metadata, diagnostics, instructions preview), remove for imported/custom, and a
  project-skills hint. Must handle loading, API failure with a retry, and an empty state.
- Composer button: compact "技能/Skills" pill. The popover fetches the session's catalog and lists
  `enabled && userInvocable && !shadowedBy` skills with a name/description search. Clicking a row is
  the explicit invocation:
  `const span = inputActions.captureInsertion(); inputActions.insertText('/' + name + ' ', span)`,
  then the popover closes. Insertion failure or a missing `inputActions` shows a small inline hint
  (never throws). Hint copy explains that the token forces the skill's full instructions into the
  next message. Escape/outside-click/focus-restore behaviour matches the host.

Styling: only `--dsw-alias-*` / `--dsw-focus-ring-*` theme tokens. Use one `<style>` element rendered
by the root component, all class names prefixed `dshskill-`. Do not import DSH client packages; React
via `require('react')` only. Match host settings typography from the references described in the
spawn prompt.

## Constraints

- Node >= 22.19 (`node:test`, `fs/promises`).
- No network access in plugin code.
- Never write outside `$DSH_HOME/dsh-skill/` (plus reads anywhere).
- Host code must not throw on missing optional services; check with `ctx.get(name)`.
- Everything model-facing goes through the built-in `skill` tool / catalog: this plugin only
  contributes provider entries, it does not append session events. Explicit invocation reuses the
  harness's `/<name>` gesture; the plugin never injects context itself.
