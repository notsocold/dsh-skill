/**
 * dsh-skill browser half.
 *
 * A build-free lazy CommonJS client bundle: the Harness Web module table hands
 * us React (the only `require`), and we register the two plugin faces through
 * slots + locale. No DSH client package is imported and no JSX/TypeScript is
 * involved: components are `React.createElement` calls over plain objects.
 *
 * Faces:
 *  - `settings.section` id `skills` order 25: the Skill Library management page.
 *  - `conversation.input.left` id `dsh-skill-invoke` order 40: the composer
 *    control that inserts an explicit `/\<skill> ` token, so the built-in skill
 *    machinery injects that skill's full instructions into the next message.
 *
 * All data goes through the authenticated same-origin JSON API:
 *   GET  /api/dsh-skill/state?sessionId=...
 *   POST /api/dsh-skill/action   { action, sessionId?, ... }
 *   GET  /api/dsh-skill/skill?name=...&sessionId=...
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-skill',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const {
      Fragment, useCallback, useEffect, useId, useMemo, useRef, useState,
    } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-skill'

    /** Authenticated JSON routes served by the Host half. */
    const API_STATE = '/api/dsh-skill/state'
    const API_ACTION = '/api/dsh-skill/action'
    const API_SKILL = '/api/dsh-skill/skill'

    /** Settings section navigation position (between General and Plugins). */
    const SETTINGS_ORDER = 25
    /** Composer tool-row position, after Plan / Read-only and before the model seat. */
    const INVOKE_ORDER = 40

    /* ------------------------------------------------------------------ *
     * Inline dictionaries (flat string maps; registered through ctx.locale)
     * ------------------------------------------------------------------ */

    const en = {
      nav: 'Skills',
      'common.loading': 'Loading…',
      'common.retry': 'Retry',
      'common.cancel': 'Cancel',
      'common.remove': 'Remove',
      'common.close': 'Close',
      'common.dismiss': 'Dismiss',
      'common.working': 'Working…',
      'common.alwaysOn': 'Always on',
      'common.enabled': 'Enabled',
      'common.disabled': 'Disabled',

      'page.title': 'Skill Library',
      'page.intro': 'Browse skills from the Claude Code and Codex ecosystems. Enabled skills are offered to the model by description; the Skills button in the composer forces a skill’s full instructions into your next message.',
      'stats.line': '{total} skills · {enabled} enabled',
      'stats.lineOne': '1 skill · {enabled} enabled',
      'stats.scanned': 'Scanned {time}',
      rescan: 'Rescan',

      'count.skillOne': '1 skill',
      'count.skillMany': '{count} skills',

      'add.label': 'Add skill',
      'add.choose': 'Choose how to add a skill',
      'add.aria': 'Add a skill',
      'add.menuAria': 'Add skill options',
      'add.import': 'Import skill folder…',
      'add.importDesc': 'Copy a skill folder containing SKILL.md into the managed library.',
      'add.source': 'Add source folder…',
      'add.sourceDesc': 'Register an existing folder of skills on disk without copying it.',
      'add.create': 'Create skill…',
      'add.createDesc': 'Write a new skill in the managed library.',

      'auto.title': 'Detected sources',
      'auto.empty': 'No Claude Code or Codex skill folders were detected yet. Install skills into one of these locations and they will appear here automatically.',
      'auto.emptyPaths': '~/.claude/skills · ~/.codex/skills · ~/.claude/plugins · ~/.codex/prompts',

      'sources.title': 'Sources',
      'sources.managedLabel': 'Managed library',
      'sources.empty': 'No custom sources yet. Add a folder of skills that already exists on disk.',
      'sources.missing': 'Folder missing',
      'sources.remove': 'Remove source',
      'sources.confirm': 'Remove this source? Its skills disappear from the library; files on disk are not deleted.',
      'sources.confirmRemove': 'Remove source',
      'source.switchAria': '{label} source',

      'skills.title': 'Skills',
      'skills.count': '{shown} of {total}',
      'skills.search': 'Search skills by name or description',
      'skills.searchClear': 'Clear search',
      'skills.emptyTitle': 'No skills found yet',
      'skills.empty': 'Add a source folder or import a skill folder to start a library. Skills in detected sources appear here automatically.',
      'skills.searchEmpty': 'No skills match “{query}”.',
      'skills.noDescription': 'No description',
      'skills.switchAria': '{name} skill',
      'skills.disabled': 'Disabled',
      'skills.modelHidden': 'Model hidden',
      'skills.shadowed': 'Shadowed by {name}',
      'skills.source': 'Source',
      'skills.path': 'SKILL.md',
      'skills.dir': 'Directory',
      'skills.whenToUse': 'When to use',
      'skills.description': 'Description',
      'skills.metadata': 'Metadata',
      'skills.diagnostics': 'Diagnostics',
      'skills.instructions': 'Instructions',
      'skills.viewInstructions': 'View instructions',
      'skills.hideInstructions': 'Hide instructions',
      'skills.instructionsLoading': 'Loading instructions…',
      'skills.instructionsError': 'Could not load instructions: {message}',
      'skills.instructionsEmpty': 'This skill has no instructions body.',
      'skills.remove': 'Remove skill',
      'skills.removeConfirm': 'Remove “{name}” from the managed library? The skill files on disk are deleted.',
      'skills.removeConfirmAction': 'Delete skill',
      'skills.readOnlyNote': 'This skill lives outside the managed library and is read-only here. Disable it, or remove its source instead.',
      'skills.shadowedNote': 'A same-named skill from a higher-priority source is in use instead; this copy is kept on disk only.',

      'project.hint': 'Project skills: when a conversation has a working directory, that directory’s .claude/skills, .codex/skills, .dsh/skills, and .agents/skills roots are detected automatically for the conversation. Enabled skills are auto-routed by description; the Skills button in the composer explicitly invokes one skill for your message.',

      'warn.scanErrors': '{count} source folder(s) could not be read completely.',
      'errors.more': 'and {count} more',

      'error.load': 'Could not load the skill library: {message}',
      'error.action': 'The action failed: {message}',
      'error.picker': 'Could not open the folder picker: {message}',

      'notice.imported': 'Imported {count} skill(s) from the folder.',
      'notice.importDone': 'Imported the skill folder.',
      'notice.importNone': 'No skills were found in that folder.',
      'notice.sourceAdded': 'Added source “{label}”.',
      'notice.sourceRemoved': 'Removed source “{label}”.',
      'notice.skillCreated': 'Created skill “{name}”.',
      'notice.skillRemoved': 'Removed skill “{name}”.',
      'notice.skillOn': 'Enabled skill “{name}”.',
      'notice.skillOff': 'Disabled skill “{name}”.',
      'notice.sourceOn': 'Enabled source “{label}”.',
      'notice.sourceOff': 'Disabled source “{label}”.',
      'notice.rescanned': 'Rescanned skill sources.',

      'path.importTitle': 'Import skill folder',
      'path.sourceTitle': 'Add source folder',
      'path.importDesc': 'Enter the absolute path of a skill folder containing SKILL.md. It is copied into the managed library.',
      'path.sourceDesc': 'Enter the absolute path of an existing folder of skills. It stays where it is and is scanned in place.',
      'path.label': 'Folder path',
      'path.placeholder': '/home/you/.claude/skills/my-skill',
      'path.submitImport': 'Import',
      'path.submitSource': 'Add source',
      'path.required': 'Enter a folder path.',

      'chooser.title': 'Choose a folder',
      'chooser.importHint': 'Choose the skill folder to copy into the managed library.',
      'chooser.sourceHint': 'Choose a folder of skills to register as a source.',
      'chooser.current': 'Current folder',
      'chooser.home': 'Home',
      'chooser.pathLabel': 'Go to folder',
      'chooser.pathPlaceholder': '/absolute/path',
      'chooser.openPath': 'Open',
      'chooser.loading': 'Loading folders…',
      'chooser.emptyTitle': 'No subfolders',
      'chooser.empty': 'This folder has no subfolders. Select it, or type another absolute path above.',
      'chooser.error': 'Could not read this folder: {message}',
      'chooser.retry': 'Retry',
      'chooser.showHidden': 'Show hidden',
      'chooser.truncated': 'Some subfolders are not listed; type a path to go deeper.',
      'chooser.select': 'Select this folder',
      'chooser.manual': 'Enter path manually…',
      'chooser.jumpRequired': 'Enter an absolute folder path.',

      'create.title': 'Create skill',
      'create.desc': 'Write a new skill into the managed library. The model reads the instructions after loading the skill.',
      'create.name': 'Name',
      'create.nameHint': 'Lowercase letters, digits, and single dashes.',
      'create.namePlaceholder': 'my-new-skill',
      'create.description': 'Description',
      'create.descriptionHint': 'What the skill does and when to use it.',
      'create.instructions': 'Instructions',
      'create.instructionsHint': 'The SKILL.md body that the model follows once the skill is loaded.',
      'create.whenToUse': 'When to use (optional)',
      'create.submit': 'Create skill',
      'create.busy': 'Creating…',
      'create.required': 'Name, description, and instructions are required.',

      'invoke.label': 'Skills',
      'invoke.triggerTitle': 'Insert a skill into this message',
      'invoke.noInput': 'The composer editor is not available here.',
      'invoke.title': 'Invoke a skill',
      'invoke.available': '{count} invocable skills',
      'invoke.search': 'Search skills',
      'invoke.searchEmpty': 'No skills match “{query}”.',
      'invoke.empty': 'No invocable skills yet. Enable skills in Settings → Skills.',
      'invoke.loading': 'Loading skills…',
      'invoke.error': 'Could not load skills: {message}',
      'invoke.hint': 'Inserting a token forces that skill’s full instructions into the next message (/name).',
      'invoke.insertFailed': 'Could not insert the skill token. The draft changed — try again.',
      'invoke.enterHint': 'Press Enter to insert the first match.',
      'invoke.userOnly': 'User-only',

      'eco.claude': 'Claude',
      'eco.codex': 'Codex',
      'eco.agents': 'Agents',
      'eco.dsh': 'DSH',
      'eco.custom': 'Custom',
      'eco.imported': 'Imported',
      'eco.unknown': 'Other',
    }

    const zh = {
      nav: '技能',
      'common.loading': '加载中…',
      'common.retry': '重试',
      'common.cancel': '取消',
      'common.remove': '移除',
      'common.close': '关闭',
      'common.dismiss': '忽略',
      'common.working': '处理中…',
      'common.alwaysOn': '始终启用',
      'common.enabled': '已启用',
      'common.disabled': '已停用',

      'page.title': '技能库',
      'page.intro': '浏览来自 Claude Code 与 Codex 生态的技能。已启用的技能会按描述自动提供给模型；输入框工具条的“技能”按钮可把某个技能的完整指令注入下一条消息。',
      'stats.line': '共 {total} 个技能 · {enabled} 个已启用',
      'stats.lineOne': '共 1 个技能 · {enabled} 个已启用',
      'stats.scanned': '扫描于 {time}',
      rescan: '重新扫描',

      'count.skillOne': '1 个技能',
      'count.skillMany': '{count} 个技能',

      'add.label': '添加技能',
      'add.choose': '选择添加技能的方式',
      'add.aria': '添加技能',
      'add.menuAria': '添加技能选项',
      'add.import': '导入技能文件夹…',
      'add.importDesc': '把包含 SKILL.md 的技能文件夹复制到托管技能库。',
      'add.source': '添加来源文件夹…',
      'add.sourceDesc': '登记磁盘上已有的技能文件夹，不复制文件。',
      'add.create': '新建技能…',
      'add.createDesc': '在托管技能库中编写一个新技能。',

      'auto.title': '自动检测到的来源',
      'auto.empty': '暂时没有检测到 Claude Code 或 Codex 技能文件夹。把技能安装到下列任一位置后，它们会自动出现在这里。',
      'auto.emptyPaths': '~/.claude/skills · ~/.codex/skills · ~/.claude/plugins · ~/.codex/prompts',

      'sources.title': '来源',
      'sources.managedLabel': '托管技能库',
      'sources.empty': '还没有自定义来源。可以添加一个磁盘上已存在的技能文件夹。',
      'sources.missing': '文件夹不存在',
      'sources.remove': '移除来源',
      'sources.confirm': '确定移除此来源吗？其技能会从技能库中消失，磁盘上的文件不会被删除。',
      'sources.confirmRemove': '移除来源',
      'source.switchAria': '{label} 来源',

      'skills.title': '技能',
      'skills.count': '{shown} / {total}',
      'skills.search': '按名称或描述搜索技能',
      'skills.searchClear': '清除搜索',
      'skills.emptyTitle': '还没有技能',
      'skills.empty': '添加来源文件夹或导入技能文件夹即可建立技能库；自动检测到的来源中的技能会自动出现在这里。',
      'skills.searchEmpty': '没有匹配“{query}”的技能。',
      'skills.noDescription': '无描述',
      'skills.switchAria': '{name} 技能',
      'skills.disabled': '已停用',
      'skills.modelHidden': '模型不可调用',
      'skills.shadowed': '被 {name} 覆盖',
      'skills.source': '来源',
      'skills.path': 'SKILL.md',
      'skills.dir': '目录',
      'skills.whenToUse': '适用场景',
      'skills.description': '描述',
      'skills.metadata': '元数据',
      'skills.diagnostics': '诊断信息',
      'skills.instructions': '指令内容',
      'skills.viewInstructions': '查看指令内容',
      'skills.hideInstructions': '收起指令内容',
      'skills.instructionsLoading': '正在加载指令内容…',
      'skills.instructionsError': '无法加载指令内容：{message}',
      'skills.instructionsEmpty': '该技能没有指令正文。',
      'skills.remove': '删除技能',
      'skills.removeConfirm': '确定从托管技能库删除“{name}”吗？磁盘上的技能文件会被删除。',
      'skills.removeConfirmAction': '删除技能',
      'skills.readOnlyNote': '该技能不在托管技能库中，此处只读。可以停用它，或移除其来源文件夹。',
      'skills.shadowedNote': '同名技能已由更高优先级的来源提供并使用；这份副本仅保留在磁盘上。',

      'project.hint': '项目级技能：会话拥有工作目录时，会自动发现该目录下的 .claude/skills、.codex/skills、.dsh/skills 与 .agents/skills。已启用的技能会按描述自动路由；也可用输入框工具条上的“技能”按钮为当前消息显式调用某个技能。',

      'warn.scanErrors': '有 {count} 个来源文件夹未能完全读取。',
      'errors.more': '还有 {count} 条',

      'error.load': '无法加载技能库：{message}',
      'error.action': '操作失败：{message}',
      'error.picker': '无法打开文件夹选择器：{message}',

      'notice.imported': '已从该文件夹导入 {count} 个技能。',
      'notice.importDone': '已导入该技能文件夹。',
      'notice.importNone': '该文件夹中没有找到技能。',
      'notice.sourceAdded': '已添加来源“{label}”。',
      'notice.sourceRemoved': '已移除来源“{label}”。',
      'notice.skillCreated': '已创建技能“{name}”。',
      'notice.skillRemoved': '已删除技能“{name}”。',
      'notice.skillOn': '已启用技能“{name}”。',
      'notice.skillOff': '已停用技能“{name}”。',
      'notice.sourceOn': '已启用来源“{label}”。',
      'notice.sourceOff': '已停用来源“{label}”。',
      'notice.rescanned': '已重新扫描技能来源。',

      'path.importTitle': '导入技能文件夹',
      'path.sourceTitle': '添加来源文件夹',
      'path.importDesc': '输入包含 SKILL.md 的技能文件夹绝对路径，它会被复制到托管技能库。',
      'path.sourceDesc': '输入磁盘上已有技能文件夹的绝对路径，它保持原位并被就地扫描。',
      'path.label': '文件夹路径',
      'path.placeholder': '/home/you/.claude/skills/my-skill',
      'path.submitImport': '导入',
      'path.submitSource': '添加来源',
      'path.required': '请输入文件夹路径。',

      'chooser.title': '选择文件夹',
      'chooser.importHint': '选择要复制到托管技能库的技能文件夹。',
      'chooser.sourceHint': '选择一个技能文件夹作为来源登记。',
      'chooser.current': '当前文件夹',
      'chooser.home': '主目录',
      'chooser.pathLabel': '跳转到文件夹',
      'chooser.pathPlaceholder': '/绝对路径',
      'chooser.openPath': '打开',
      'chooser.loading': '正在加载文件夹…',
      'chooser.emptyTitle': '没有子文件夹',
      'chooser.empty': '该文件夹没有子文件夹。可以直接选择它，或在上方输入其他绝对路径。',
      'chooser.error': '无法读取该文件夹：{message}',
      'chooser.retry': '重试',
      'chooser.showHidden': '显示隐藏项',
      'chooser.truncated': '部分子文件夹未列出；可输入路径继续深入。',
      'chooser.select': '选择此文件夹',
      'chooser.manual': '手动输入路径…',
      'chooser.jumpRequired': '请输入文件夹的绝对路径。',

      'create.title': '新建技能',
      'create.desc': '在托管技能库中编写一个新技能。模型加载该技能后会阅读指令正文。',
      'create.name': '名称',
      'create.nameHint': '小写字母、数字和单个短横线。',
      'create.namePlaceholder': 'my-new-skill',
      'create.description': '描述',
      'create.descriptionHint': '这个技能做什么、什么时候使用。',
      'create.instructions': '指令内容',
      'create.instructionsHint': '技能加载后模型遵循的 SKILL.md 正文。',
      'create.whenToUse': '适用场景（可选）',
      'create.submit': '创建技能',
      'create.busy': '正在创建…',
      'create.required': '名称、描述和指令内容为必填项。',

      'invoke.label': '技能',
      'invoke.triggerTitle': '把技能插入本条消息',
      'invoke.noInput': '此处无法使用输入框编辑器。',
      'invoke.title': '调用技能',
      'invoke.available': '可显式调用 {count} 个技能',
      'invoke.search': '搜索技能',
      'invoke.searchEmpty': '没有匹配“{query}”的技能。',
      'invoke.empty': '还没有可调用的技能。请到“设置 → 技能”中启用技能。',
      'invoke.loading': '正在加载技能…',
      'invoke.error': '无法加载技能：{message}',
      'invoke.hint': '插入后本条消息会强制加载该技能全文（/name）。',
      'invoke.insertFailed': '无法插入技能标记：草稿已变化，请重试。',
      'invoke.enterHint': '按回车插入第一个匹配项。',
      'invoke.userOnly': '仅用户调用',

      'eco.claude': 'Claude',
      'eco.codex': 'Codex',
      'eco.agents': 'Agents',
      'eco.dsh': 'DSH',
      'eco.custom': '自定义',
      'eco.imported': '导入',
      'eco.unknown': '其他',
    }

    /* ------------------------------------------------------------------ *
     * Runtime + translation
     * ------------------------------------------------------------------ */

    /** Late-bound plugin runtime: the Client Context and its bound translate. */
    const runtime = { ctx: null, translate: null }

    /**
     * Interpolate `{name}` placeholders in a template.
     * @param {string} template - dictionary value or key fallback.
     * @param {Record<string, unknown> | undefined} params - replacement values.
     * @returns {string}
     */
    function interpolate(template, params) {
      if (params === undefined || params === null) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ))
    }

    /**
     * English-only fallback used before the locale service binds (or if it fails).
     * @param {string} key - dictionary key.
     * @param {Record<string, unknown>} [params] - template params.
     * @returns {string}
     */
    function fallbackTranslate(key, params) {
      const template = typeof en[key] === 'string' ? en[key] : key
      return interpolate(template, params)
    }

    /**
     * Translate through the plugin namespace, degrading to the inline English copy.
     * @param {string} key - dictionary key.
     * @param {Record<string, unknown>} [params] - template params.
     * @returns {string}
     */
    function translate(key, params) {
      if (runtime.translate !== null) {
        try {
          return runtime.translate(key, params)
        } catch {
          // Fall through to the inline English dictionary.
        }
      }
      return fallbackTranslate(key, params)
    }

    /**
     * Resolve the translate seat: the renderer-injected `t` when the slot entry
     * declares this plugin's locale namespace, else the plugin-bound fallback.
     * @param {{ t?: unknown }} props - slot component props.
     * @returns {(key: string, params?: Record<string, unknown>) => string}
     */
    function translateOf(props) {
      return typeof props.t === 'function' ? props.t : translate
    }

    /* ------------------------------------------------------------------ *
     * Small pure helpers
     * ------------------------------------------------------------------ */

    /** @param {unknown} value @returns {boolean} */
    function isObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /** @param {unknown} value @returns {string} */
    function asString(value) {
      return typeof value === 'string' ? value : ''
    }

    /** @param {unknown} value @returns {string[]} */
    function asStringArray(value) {
      if (!Array.isArray(value)) return []
      return value.filter(item => typeof item === 'string' && item !== '')
    }

    /** @param {unknown} value @param {number} fallback @returns {number} */
    function asNumber(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    /**
     * Middle-truncate a long path for a single line (full value stays in `title`).
     * @param {string} value - path text.
     * @param {number} max - maximum characters to keep.
     * @returns {string}
     */
    function truncateMiddle(value, max) {
      if (typeof value !== 'string' || value.length <= max || max < 8) return value
      const keep = Math.max(6, Math.floor((max - 1) / 2))
      return value.slice(0, keep) + '…' + value.slice(-keep)
    }

    /**
     * JSON text of a skill's remaining frontmatter metadata.
     * @param {Record<string, unknown>} metadata - normalized metadata object.
     * @returns {string} empty when there is nothing to show.
     */
    function metadataText(metadata) {
      if (!isObject(metadata)) return ''
      try {
        if (Object.keys(metadata).length === 0) return ''
        return JSON.stringify(metadata, null, 2)
      } catch {
        return ''
      }
    }

    /** @param {unknown} cause @returns {string} human-readable failure message. */
    function messageOf(cause) {
      if (cause instanceof Error && typeof cause.message === 'string' && cause.message !== '') return cause.message
      if (typeof cause === 'string' && cause !== '') return cause
      return String(cause)
    }

    /**
     * Failure text for a directory capability call: the Host business message
     * (`error.rpcError.message`, as DirectoryBrowseError carries) wins over the
     * wrapper's own phrasing.
     * @param {unknown} cause - rejection value.
     * @returns {string}
     */
    function browseFailureText(cause) {
      if (isObject(cause) && isObject(cause.rpcError)) {
        const message = asString(cause.rpcError.message)
        if (message !== '') return message
      }
      return messageOf(cause)
    }

    /**
     * Format the Host scan timestamp for the stats line.
     * @param {string} value - ISO timestamp.
     * @returns {string} empty when unparseable.
     */
    function formatScannedAt(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      try {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /** @param {string} base @param {string} extra @returns {string} */
    function classNames(base, extra) {
      return extra === undefined || extra === '' ? base : base + ' ' + extra
    }

    /** Map an ecosystem id to its dictionary key. */
    const ECOSYSTEM_KEYS = {
      claude: 'eco.claude',
      codex: 'eco.codex',
      agents: 'eco.agents',
      dsh: 'eco.dsh',
      custom: 'eco.custom',
      imported: 'eco.imported',
    }

    /** @param {string} ecosystem @returns {string} */
    function ecosystemKey(ecosystem) {
      return Object.prototype.hasOwnProperty.call(ECOSYSTEM_KEYS, ecosystem)
        ? ECOSYSTEM_KEYS[ecosystem]
        : 'eco.unknown'
    }

    /** @param {string} ecosystem @returns {string} badge tone */
    function ecosystemTone(ecosystem) {
      if (ecosystem === 'claude') return 'info'
      if (ecosystem === 'codex') return 'success'
      if (ecosystem === 'imported') return 'outline'
      return 'neutral'
    }

    /* ------------------------------------------------------------------ *
     * HTTP layer (authenticated same-origin JSON routes)
     * ------------------------------------------------------------------ */

    /**
     * One HTTP failure with its stable Host error code.
     * @param {string} code - error code.
     * @param {string} message - readable message.
     * @param {number} status - HTTP status (0 for transport failures).
     * @returns {Error}
     */
    function requestError(code, message, status) {
      const error = new Error(message)
      error.code = code
      error.status = status
      return error
    }

    /**
     * Append `sessionId` to a route URL.
     * @param {string} url - route path with or without a query.
     * @param {string | undefined} sessionId - current session id.
     * @returns {string}
     */
    function withSession(url, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return url
      const query = 'sessionId=' + encodeURIComponent(sessionId)
      return url + (url.indexOf('?') === -1 ? '?' : '&') + query
    }

    /**
     * Fetch one JSON envelope and unwrap `{ ok: true, value }`.
     * @param {string} url - route path.
     * @param {RequestInit} [init] - fetch options.
     * @returns {Promise<unknown>} the envelope value.
     */
    async function requestJson(url, init) {
      let response
      try {
        const headers = Object.assign({ accept: 'application/json' }, init === undefined ? undefined : init.headers)
        response = await fetch(url, Object.assign(
          { credentials: 'same-origin', cache: 'no-store' },
          init,
          { headers },
        ))
      } catch (cause) {
        throw requestError('network', messageOf(cause), 0)
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (response.ok && isObject(payload) && payload.ok === true) return payload.value
      const error = isObject(payload) && isObject(payload.error) ? payload.error : undefined
      const code = error !== undefined && typeof error.code === 'string' ? error.code : 'request-failed'
      const message = error !== undefined && typeof error.message === 'string' && error.message !== ''
        ? error.message
        : 'HTTP ' + response.status
      throw requestError(code, message, response.status)
    }

    /**
     * GET the library state document.
     * @param {string} [sessionId] - current conversation id.
     * @returns {Promise<unknown>}
     */
    function fetchState(sessionId) {
      return requestJson(withSession(API_STATE, sessionId))
    }

    /**
     * POST one mutation and receive the recomputed state document.
     * @param {string} action - action name.
     * @param {Record<string, unknown>} payload - action fields.
     * @returns {Promise<unknown>}
     */
    function postAction(action, payload) {
      return requestJson(API_ACTION, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({}, payload, { action })),
      })
    }

    /**
     * GET one skill's model-facing instructions.
     * @param {string} name - skill name.
     * @param {string} [sessionId] - optional session context.
     * @returns {Promise<unknown>}
     */
    function fetchSkill(name, sessionId) {
      return requestJson(withSession(API_SKILL + '?name=' + encodeURIComponent(name), sessionId))
    }

    /**
     * Read the optional Workspace UI service from the Client Context.
     * @returns {Record<string, any> | null} the service, or null when absent.
     */
    function workspaceService() {
      if (runtime.ctx === null || typeof runtime.ctx.get !== 'function') return null
      try {
        const workspace = runtime.ctx.get('uiWorkspace')
        return workspace === undefined ? null : workspace
      } catch {
        return null
      }
    }

    /**
     * The browse-capable Workspace UI service: the Web profile composes the
     * `browse` directory capability, so its `listDirectory` is the portable
     * picker surface (the native `pickDirectory` needs the `native` capability
     * and is only a fallback for desktop compositions).
     * @returns {Record<string, any> | null}
     */
    function browseWorkspace() {
      const workspace = workspaceService()
      if (workspace === null || typeof workspace.listDirectory !== 'function') return null
      return workspace
    }

    /**
     * Ask the optional Workspace UI for a directory through its native picker.
     * @returns {Promise<string | null | undefined>} path, null on cancel,
     * undefined when this deployment has no native directory picker.
     */
    async function pickDirectory() {
      const workspace = workspaceService()
      if (workspace === null || typeof workspace.pickDirectory !== 'function') return undefined
      const picked = await workspace.pickDirectory()
      return typeof picked === 'string' && picked !== '' ? picked : null
    }

    /**
     * List one absolute Host directory level through the browse capability.
     * @param {string | undefined} path - directory path; absent lists the Host home.
     * @param {AbortSignal | undefined} signal - cancellation for a superseded scan.
     * @returns {Promise<unknown>} the DirectoryListing envelope.
     */
    async function readDirectory(path, signal) {
      const workspace = browseWorkspace()
      if (workspace === null) throw requestError('directory-unavailable', 'directory browsing is unavailable', 0)
      return workspace.listDirectory(path, signal)
    }

    /* ------------------------------------------------------------------ *
     * State normalization (the API is JSON; every field is treated as optional)
     * ------------------------------------------------------------------ */

    /** @param {Record<string, unknown>} raw @returns {Record<string, unknown>} */
    function normalizeSource(raw) {
      return {
        id: asString(raw.id),
        path: asString(raw.path),
        kind: asString(raw.kind) === '' ? 'custom' : asString(raw.kind),
        label: asString(raw.label) === '' ? asString(raw.id) : asString(raw.label),
        auto: raw.auto === true,
        enabled: raw.enabled !== false,
        exists: raw.exists !== false,
        skillCount: asNumber(raw.skillCount, 0),
        removable: raw.removable === true,
        plugin: asString(raw.plugin),
      }
    }

    /** @param {Record<string, unknown>} raw @returns {Record<string, unknown>} */
    function normalizeSkill(raw) {
      return {
        name: asString(raw.name) === '' ? asString(raw.originalName) : asString(raw.name),
        originalName: asString(raw.originalName),
        description: asString(raw.description),
        whenToUse: asString(raw.whenToUse),
        ecosystem: asString(raw.ecosystem),
        sourceId: asString(raw.sourceId),
        sourceLabel: asString(raw.sourceLabel),
        path: asString(raw.path),
        dir: asString(raw.dir),
        enabled: raw.enabled === true,
        modelInvocable: raw.modelInvocable !== false,
        userInvocable: raw.userInvocable !== false,
        diagnostics: asStringArray(raw.diagnostics),
        metadata: isObject(raw.metadata) ? raw.metadata : {},
        shadowedBy: typeof raw.shadowedBy === 'string' && raw.shadowedBy !== '' ? raw.shadowedBy : undefined,
      }
    }

    /**
     * Normalize one GET state / action value.
     * @param {unknown} value - envelope value.
     * @returns {Record<string, unknown> | null} null when the value is unusable.
     */
    function normalizeState(value) {
      if (!isObject(value)) return null
      const stats = isObject(value.stats) ? value.stats : {}
      const sessionRaw = isObject(value.session) ? value.session : null
      return {
        raw: value,
        home: asString(value.home),
        libraryDir: asString(value.libraryDir),
        scannedAt: asString(value.scannedAt),
        sources: Array.isArray(value.sources) ? value.sources.filter(isObject).map(normalizeSource) : [],
        skills: Array.isArray(value.skills) ? value.skills.filter(isObject).map(normalizeSkill) : [],
        stats: {
          total: asNumber(stats.total, 0),
          enabled: asNumber(stats.enabled, 0),
        },
        session: sessionRaw === null
          ? null
          : { id: asString(sessionRaw.id), cwd: asString(sessionRaw.cwd) },
        scanErrors: Array.isArray(value.errors)
          ? value.errors.filter(isObject).map(item => ({
            path: asString(item.path),
            message: asString(item.message),
            sourceId: asString(item.sourceId),
          }))
          : [],
      }
    }

    /**
     * Normalize one directory entry from a DirectoryListing.
     * @param {unknown} raw - wire entry.
     * @returns {{ name: string, path: string, hidden: boolean } | null}
     */
    function normalizeDirectoryEntry(raw) {
      if (!isObject(raw)) return null
      const path = asString(raw.path)
      if (path === '') return null
      const name = asString(raw.name)
      return { name: name === '' ? path : name, path, hidden: raw.hidden === true }
    }

    /**
     * Normalize one browse DirectoryListing defensively (every field optional
     * on the wire as far as this component is concerned).
     * @param {unknown} raw - wire listing.
     * @returns {{ path: string, home: string, crumbs: Array<object>, entries: Array<object>, truncated: boolean } | null}
     */
    function normalizeListing(raw) {
      if (!isObject(raw)) return null
      const path = asString(raw.path)
      if (path === '') return null
      const crumbs = Array.isArray(raw.crumbs) ? raw.crumbs.map(normalizeDirectoryEntry).filter(entry => entry !== null) : []
      const entries = Array.isArray(raw.entries) ? raw.entries.map(normalizeDirectoryEntry).filter(entry => entry !== null) : []
      return { path, home: asString(raw.home), crumbs, entries, truncated: raw.truncated === true }
    }

    /**
     * Breadcrumb rows for display: inside the home subtree the trail starts at
     * a localized Home crumb; outside it the full ancestry shows.
     * @param {{ home: string, crumbs: Array<{ name: string, path: string, hidden: boolean }> }} listing
     * @param {string} homeLabel - localized Home label.
     * @returns {Array<{ name: string, path: string, hidden: boolean }>}
     */
    function crumbTrail(listing, homeLabel) {
      if (listing.home === '') return listing.crumbs
      const homeIndex = listing.crumbs.findIndex(crumb => crumb.path === listing.home)
      if (homeIndex === -1) return listing.crumbs
      return [{ name: homeLabel, path: listing.home, hidden: false }].concat(listing.crumbs.slice(homeIndex + 1))
    }

    /**
     * Skills the composer may explicitly invoke: globally enabled, not shadowed
     * by a higher-priority source, and user-invocable (the `\/<name>` token is a
     * user gesture, so user-only skills qualify even when the model catalog
     * does not advertise them).
     * @param {Record<string, unknown> | null} state - normalized state.
     * @returns {Array<Record<string, any>>}
     */
    function invocableSkills(state) {
      if (state === null) return []
      const seen = new Set()
      const options = []
      for (const skill of state.skills) {
        if (skill.shadowedBy !== undefined) continue
        if (!skill.enabled) continue
        if (!skill.userInvocable) continue
        if (seen.has(skill.name)) continue
        seen.add(skill.name)
        options.push(skill)
      }
      options.sort((left, right) => left.name.localeCompare(right.name))
      return options
    }

    /**
     * Read the import count out of a mutation's optional `action` echo.
     * @param {Record<string, unknown> | null} state - normalized state.
     * @returns {number | null}
     */
    function importedCount(state) {
      if (state === null) return null
      const raw = state.raw
      const action = isObject(raw) && isObject(raw.action) ? raw.action : null
      if (action === null) return null
      if (Array.isArray(action.imported)) return action.imported.length
      if (typeof action.imported === 'number' && Number.isFinite(action.imported)) return action.imported
      return null
    }

    /* ------------------------------------------------------------------ *
     * Own inline icons (currentColor strokes; no external references)
     * ------------------------------------------------------------------ */

    /** Shared stroke attributes for the inline glyph set. */
    function iconProps(className) {
      return {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        className,
      }
    }

    function IconPlus({ className }) {
      return h('svg', iconProps(className), h('path', { d: 'M8 3.2v9.6M3.2 8h9.6' }))
    }

    function IconChevronDown({ className }) {
      return h('svg', iconProps(className), h('path', { d: 'M4 6.2 8 10.2l4-4' }))
    }

    function IconChevronRight({ className }) {
      return h('svg', iconProps(className), h('path', { d: 'M6.2 4 10.2 8l-4 4' }))
    }

    function IconCheck({ className }) {
      return h('svg', iconProps(className), h('path', { d: 'm3.2 8.4 3.2 3.2 6.4-7.2' }))
    }

    function IconSearch({ className }) {
      return h('svg', iconProps(className),
        h('circle', { cx: 7, cy: 7, r: 3.8 }),
        h('path', { d: 'm10.3 10.3 2.7 2.7' }),
      )
    }

    function IconClose({ className }) {
      return h('svg', iconProps(className), h('path', { d: 'm4 4 8 8M12 4l-8 8' }))
    }

    function IconWarning({ className }) {
      return h('svg', iconProps(className),
        h('path', { d: 'M8 2.4 14.2 13.4H1.8L8 2.4Z' }),
        h('path', { d: 'M8 6.3v3.4' }),
        h('circle', { cx: 8, cy: 11.5, r: 0.7, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function IconRefresh({ className }) {
      return h('svg', iconProps(className),
        h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.7-3.8' }),
        h('path', { d: 'M13.2 2.6v2.9h-2.9' }),
      )
    }

    function IconFolder({ className }) {
      return h('svg', iconProps(className),
        h('path', { d: 'M2.4 5a1.2 1.2 0 0 1 1.2-1.2h2.2l1.3 1.6h5.3A1.2 1.2 0 0 1 13.6 6.6v5.4a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2V5Z' }),
        h('path', { d: 'M2.4 8h11.2' }),
      )
    }

    function IconLayers({ className }) {
      return h('svg', iconProps(className),
        h('path', { d: 'M8 2.6 14 6 8 9.4 2 6l6-3.4Z' }),
        h('path', { d: 'M2 9.1 8 12.5l6-3.4' }),
      )
    }

    function IconPencil({ className }) {
      return h('svg', iconProps(className),
        h('path', { d: 'm3 13 1-2.7 6.9-6.9 1.8 1.8-6.9 6.9L3 13Z' }),
        h('path', { d: 'm9.8 4.5 1.8 1.8' }),
      )
    }

    function IconTrash({ className }) {
      return h('svg', iconProps(className),
        h('path', { d: 'M2.8 4.6h10.4M6.2 4.6V2.9h3.6v1.7' }),
        h('path', { d: 'm4.2 4.6.6 8.6h6.4l.6-8.6' }),
      )
    }

    function IconSpark({ className }) {
      return h('svg', iconProps(className),
        h('path', { d: 'M8 1.8v2.6M8 11.6v2.6M1.8 8h2.6M11.6 8h2.6' }),
        h('path', { d: 'M3.6 3.6 5.4 5.4M10.6 10.6l1.8 1.8M12.4 3.6l-1.8 1.8M5.4 10.6l-1.8 1.8' }),
      )
    }

    /** Known ecosystems that get a dedicated tinted glyph badge. */
    const ECOSYSTEM_GLYPH_SET = {
      claude: true,
      codex: true,
      agents: true,
      imported: true,
      custom: true,
      dsh: true,
    }

    /**
     * Shared brand mark: a rounded indigo→violet tile carrying a stack of white
     * skill cards and a warm four-point sparkle — the same artwork as icon.svg.
     * Purely decorative: every host renders a readable title next to it.
     * @param {{ size?: number, className?: string }} props
     */
    function BrandMark({ size, className }) {
      const rawId = useId()
      const uid = 'dshskill-brand-' + rawId.replace(/[^a-zA-Z0-9_-]/g, '')
      const px = typeof size === 'number' && size > 0 ? size : 24
      return h('svg', {
        viewBox: '0 0 24 24',
        width: px,
        height: px,
        className,
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('defs', null,
          h('linearGradient', { id: uid + '-tile', x1: 3, y1: 2, x2: 21, y2: 22, gradientUnits: 'userSpaceOnUse' },
            h('stop', { offset: 0, stopColor: '#5B6CFF' }),
            h('stop', { offset: 1, stopColor: '#9B5CF6' }),
          ),
          h('linearGradient', { id: uid + '-sheen', x1: 3, y1: 2, x2: 14, y2: 13, gradientUnits: 'userSpaceOnUse' },
            h('stop', { offset: 0, stopColor: '#FFFFFF', stopOpacity: 0.3 }),
            h('stop', { offset: 1, stopColor: '#FFFFFF', stopOpacity: 0 }),
          ),
          h('linearGradient', { id: uid + '-spark', x1: 15, y1: 2.5, x2: 19, y2: 9, gradientUnits: 'userSpaceOnUse' },
            h('stop', { offset: 0, stopColor: '#FFF0B8' }),
            h('stop', { offset: 1, stopColor: '#FFC94A' }),
          ),
        ),
        h('rect', { x: 1, y: 1, width: 22, height: 22, rx: 5.6, fill: 'url(#' + uid + '-tile)' }),
        h('rect', { x: 1, y: 1, width: 22, height: 22, rx: 5.6, fill: 'url(#' + uid + '-sheen)' }),
        h('rect', {
          x: 1.35,
          y: 1.35,
          width: 21.3,
          height: 21.3,
          rx: 5.3,
          fill: 'none',
          stroke: '#FFFFFF',
          strokeOpacity: 0.22,
          strokeWidth: 0.7,
        }),
        h('g', null,
          h('rect', { x: 4.6, y: 5.6, width: 12.2, height: 8.2, rx: 2, fill: '#FFFFFF', fillOpacity: 0.32 }),
          h('rect', { x: 5.4, y: 8.3, width: 12.2, height: 8.2, rx: 2, fill: '#FFFFFF', fillOpacity: 0.58 }),
          h('rect', { x: 6.2, y: 11, width: 12.2, height: 8.2, rx: 2, fill: '#FFFFFF', fillOpacity: 0.96 }),
          h('path', {
            d: 'M8.6 13.6h6.2M8.6 15.8h4.4',
            stroke: '#7C5CF6',
            strokeOpacity: 0.55,
            strokeWidth: 1,
            strokeLinecap: 'round',
          }),
        ),
        h('path', {
          d: 'M18.1 3.2c.32 1.95 1.12 2.75 3.07 3.07-1.95.32-2.75 1.12-3.07 3.07-.32-1.95-1.12-2.75-3.07-3.07 1.95-.32 2.75-1.12 3.07-3.07Z',
          fill: 'url(#' + uid + '-spark)',
        }),
      )
    }

    /**
     * Composer glyph: four-point invocation sparkle, a small plus, and a brand
     * accent dot — stroked in currentColor so it inherits the pill's state tone.
     */
    function IconInvoke({ className }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        className,
      },
        h('path', {
          d: 'M6.3 2.1c.34 2.2 1.26 3.12 3.46 3.46-2.2.34-3.12 1.26-3.46 3.46-.34-2.2-1.26-3.12-3.46-3.46 2.2-.34 3.12-1.26 3.46-3.46Z',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M11.35 8.9v3.5M9.6 10.65h3.5',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 12.9, cy: 4.6, r: 1.05, fill: 'var(--dsw-alias-brand-primary)' }),
      )
    }

    /**
     * Per-ecosystem monochrome glyph inside a tinted rounded badge (the tint is
     * artwork, so literal colors live here; the badge shape follows the theme).
     * @param {{ ecosystem: string, label: string }} props
     */
    function EcosystemGlyph({ ecosystem, label }) {
      const eco = typeof ecosystem === 'string' && ECOSYSTEM_GLYPH_SET[ecosystem] === true ? ecosystem : 'unknown'
      let nodes
      switch (eco) {
        case 'claude':
          nodes = [h('path', {
            key: 'claude',
            d: 'M8 2.6v10.8M3.3 5.3l9.4 5.4M12.7 5.3l-9.4 5.4',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinecap: 'round',
          })]
          break
        case 'codex':
          nodes = [h('path', {
            key: 'codex',
            d: 'M5.4 4.4 2.9 8l2.5 3.6M10.6 4.4 13.1 8l-2.5 3.6M9.3 3.6 6.7 12.4',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          })]
          break
        case 'agents':
          nodes = [
            h('path', {
              key: 'edges',
              d: 'M4.1 4.7 7.9 10.2M11.9 4.7 8.1 10.2M4.1 4.7h7.8',
              stroke: 'currentColor',
              strokeWidth: 1.1,
              strokeLinecap: 'round',
            }),
            h('circle', { key: 'n1', cx: 4, cy: 4.7, r: 1.35, fill: 'currentColor' }),
            h('circle', { key: 'n2', cx: 12, cy: 4.7, r: 1.35, fill: 'currentColor' }),
            h('circle', { key: 'n3', cx: 8, cy: 11.2, r: 1.35, fill: 'currentColor' }),
          ]
          break
        case 'imported':
          nodes = [h('path', {
            key: 'imported',
            d: 'M8 2.8v6.1M5.4 6.3 8 8.9l2.6-2.6M3.1 10.7v1.7h9.8v-1.7',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          })]
          break
        case 'custom':
          nodes = [h('path', {
            key: 'custom',
            d: 'M2.8 5.2a1.1 1.1 0 0 1 1.1-1.1h2.2l1.2 1.5h4.8a1.1 1.1 0 0 1 1.1 1.1v5.1a1.1 1.1 0 0 1-1.1 1.1H3.9a1.1 1.1 0 0 1-1.1-1.1V5.2Z',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinejoin: 'round',
          })]
          break
        case 'dsh':
          nodes = [h('path', {
            key: 'dsh',
            d: 'M8 2.8 13.2 5.8 8 8.8 2.8 5.8 8 2.8ZM2.8 8.8 8 11.8l5.2-3',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          })]
          break
        default:
          nodes = [h('circle', { key: 'unknown', cx: 8, cy: 8, r: 2.3, fill: 'currentColor' })]
      }
      return h('span', {
        className: 'dshskill-ecoBadge',
        'data-eco': eco,
        role: 'img',
        'aria-label': label,
        title: label,
      }, h('svg', {
        viewBox: '0 0 16 16',
        width: 13,
        height: 13,
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('g', null, ...nodes)))
    }

    /* ------------------------------------------------------------------ *
     * Scoped stylesheet (one <style> element per rendered root)
     * ------------------------------------------------------------------ */

    const STYLE_TEXT = `
.dshskill-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 760px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}

.dshskill-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dshskill-headText { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dshskill-headTitleRow { display: flex; flex: 1 1 auto; align-items: flex-start; gap: 10px; min-width: 0; }
.dshskill-title { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; }
.dshskill-intro { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dshskill-headActions { flex: none; display: flex; align-items: center; gap: 8px; }

.dshskill-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}
.dshskill-btn:disabled { opacity: 0.45; cursor: default; }
.dshskill-btn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dshskill-btnPrimary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dshskill-btnPrimary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dshskill-btnOutline { border: 0.5px solid var(--dsw-alias-border-l3); }
.dshskill-btnOutline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshskill-btnGhost { color: var(--dsw-alias-label-secondary); }
.dshskill-btnGhost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshskill-btnDanger { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-foreground); }
.dshskill-btnDanger:hover:not(:disabled) { opacity: 0.9; }
.dshskill-btnDangerText { color: var(--dsw-alias-state-error-primary); }
.dshskill-btnSm { height: 24px; padding: 0 8px; font-size: 11px; line-height: 16px; }
.dshskill-btnIcon { flex: none; width: 13px; height: 13px; }

.dshskill-addGroup { position: relative; display: inline-flex; align-items: stretch; }
.dshskill-addChevron {
  flex: none;
  width: 12px;
  height: 12px;
  margin-left: 1px;
  transition: transform 140ms ease;
}
.dshskill-addMain[aria-expanded='true'] .dshskill-addChevron { transform: rotate(180deg); }

.dshskill-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 320px;
  max-width: calc(100vw - 32px);
  padding: 4px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-elevation-prominent);
}
.dshskill-menuItem {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshskill-menuItem:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshskill-menuItem:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.dshskill-menuIcon { flex: none; display: inline-flex; margin-top: 1px; color: var(--dsw-alias-label-secondary); }
.dshskill-menuIcon svg { width: 15px; height: 15px; }
.dshskill-menuCopy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dshskill-menuLabel { font-size: 13px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dshskill-menuDesc { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary); white-space: normal; }

.dshskill-block { display: flex; flex-direction: column; gap: 8px; }
.dshskill-blockHead { display: flex; align-items: baseline; gap: 8px; min-height: 20px; }
.dshskill-blockTitle { margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; }
.dshskill-blockCount { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dshskill-blockSpacer { flex: 1 1 auto; }

.dshskill-panel {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.dshskill-source, .dshskill-skill { display: flex; flex-direction: column; }
.dshskill-source + .dshskill-source, .dshskill-skill + .dshskill-skill { border-top: 0.5px solid var(--dsw-alias-border-l1); }
.dshskill-sourceRow { display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 8px 12px; box-sizing: border-box; }
.dshskill-sourceMain { flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dshskill-sourceTitleLine { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.dshskill-sourceLabel { font-size: 13px; line-height: 18px; font-weight: 500; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshskill-sourceCount { flex: none; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dshskill-source[data-missing='true'] .dshskill-sourceLabel { color: var(--dsw-alias-state-warn-label); }
.dshskill-rowConfirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 12px 10px; }
.dshskill-rowConfirmText { flex: 1 1 160px; margin: 0; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.dshskill-confirmIcon { flex: none; width: 14px; height: 14px; margin-top: 2px; color: var(--dsw-alias-state-warn-primary); }

.dshskill-switch {
  position: relative;
  flex: none;
  box-sizing: border-box;
  width: 32px;
  height: 18px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
}
.dshskill-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dshskill-switch:disabled { opacity: 0.5; cursor: default; }
.dshskill-switch:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dshskill-switchThumb {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 120ms ease;
}
.dshskill-switch[aria-checked='false'] .dshskill-switchThumb { background: var(--dsw-alias-switch-thumb); }
.dshskill-switch[aria-checked='true'] .dshskill-switchThumb { transform: translateX(14px); }

.dshskill-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 0 7px;
  font-size: 10px;
  line-height: 16px;
  font-weight: 500;
  white-space: nowrap;
}
.dshskill-badge[data-tone='neutral'] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.dshskill-badge[data-tone='quiet'] { padding: 0; color: var(--dsw-alias-label-tertiary); }
.dshskill-badge[data-tone='outline'] { border: 0.5px solid var(--dsw-alias-border-l4); color: var(--dsw-alias-label-tertiary); }
.dshskill-badge[data-tone='info'] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
.dshskill-badge[data-tone='success'] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-state-success-primary);
}
.dshskill-badge[data-tone='warning'] {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}

.dshskill-skillRow { display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px; }
.dshskill-skillTogglePlaceholder { flex: none; width: 32px; height: 18px; }
.dshskill-skillMain {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-xs);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshskill-skillMain:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dshskill-skillTitleLine { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; min-width: 0; }
.dshskill-skillName { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 18px; font-weight: 500; }
.dshskill-skillDesc { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary); }
.dshskill-skill[data-disabled='true'] .dshskill-skillName { color: var(--dsw-alias-label-tertiary); }
.dshskill-skill[data-disabled='true'] .dshskill-skillDesc { color: var(--dsw-alias-label-dimmed); }
.dshskill-skill[data-shadowed='true'] { opacity: 0.65; }
.dshskill-skillChevron { flex: none; width: 12px; height: 12px; margin-top: 3px; color: var(--dsw-alias-label-caption); transition: transform 120ms ease; }
.dshskill-open { transform: rotate(180deg); }

.dshskill-detail {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px 12px 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dshskill-detailRow { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dshskill-detailLabel { flex: none; font-size: 10px; line-height: 16px; font-weight: 500; letter-spacing: 0.03em; text-transform: uppercase; color: var(--dsw-alias-label-caption); }
.dshskill-detailValue { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dshskill-detailBlock { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dshskill-detailHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dshskill-detailText { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.dshskill-detailHint { margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption); }
.dshskill-path {
  font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dshskill-code {
  max-height: 200px;
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 17px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dshskill-diagnostics { display: flex; flex-direction: column; gap: 3px; padding: 7px 9px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); }
.dshskill-diagList { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dshskill-diagItem { display: flex; align-items: flex-start; gap: 6px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-state-warn-label); overflow-wrap: anywhere; }
.dshskill-diagIcon { flex: none; width: 12px; height: 12px; margin-top: 2px; color: var(--dsw-alias-state-warn-label); }
.dshskill-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dshskill-confirmText { flex: 1 1 180px; margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }

.dshskill-search { position: relative; display: flex; align-items: center; }
.dshskill-searchIcon { position: absolute; left: 10px; width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary); pointer-events: none; }
.dshskill-search input {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 10px 0 32px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  outline: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}
.dshskill-search input::placeholder { color: var(--dsw-alias-label-tertiary); }
.dshskill-search input:focus-visible {
  border-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 18%, transparent);
}

.dshskill-empty {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 18px 14px;
  border: 0.5px dashed var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  color: var(--dsw-alias-label-tertiary);
  text-align: center;
}
.dshskill-emptyTitle { margin: 0; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dshskill-emptyText { margin: 0; font-size: 12px; line-height: 18px; }
.dshskill-hintBox {
  margin: 0;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

.dshskill-notice, .dshskill-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--dsw-radius-md);
  font-size: 12px;
  line-height: 18px;
}
.dshskill-notice[data-kind='success'] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-state-success-primary);
}
.dshskill-notice[data-kind='error'], .dshskill-banner[data-kind='error'] {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}
.dshskill-banner[data-kind='error'] { align-items: flex-start; }
.dshskill-banner[data-kind='warning'] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-warn-label); }
.dshskill-noticeText, .dshskill-bannerText { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dshskill-bannerIcon { flex: none; width: 14px; height: 14px; margin-top: 2px; color: inherit; }
.dshskill-iconBtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-xs);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.dshskill-iconBtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshskill-iconBtn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dshskill-iconBtn svg { width: 12px; height: 12px; }

.dshskill-skeleton { display: flex; flex-direction: column; gap: 8px; }
.dshskill-skeletonRow { height: 44px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-skeleton); animation: dshskill-pulse 1.4s ease-in-out infinite; }
@keyframes dshskill-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.dshskill-spinner {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--dsw-alias-border-l3);
  border-top-color: var(--dsw-alias-state-business-primary);
  border-radius: 50%;
  animation: dshskill-spin 0.8s linear infinite;
}
@keyframes dshskill-spin { to { transform: rotate(360deg); } }
.dshskill-visuallyHidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.dshskill-status { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

.dshskill-modalLayer { position: fixed; inset: 0; z-index: 1300; display: flex; align-items: center; justify-content: center; padding: 24px; }
.dshskill-modalMask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur); }
.dshskill-modal {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box;
  width: min(480px, 100%);
  max-height: calc(100vh - 96px);
  overflow: auto;
  padding: 20px;
  border-radius: var(--dsw-radius-panel);
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
}
.dshskill-modal:focus { outline: none; }
.dshskill-modalHead { display: flex; flex-direction: column; gap: 4px; }
.dshskill-modalTitle { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.dshskill-modalDesc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dshskill-modalFooter { display: flex; justify-content: flex-end; gap: 8px; }
.dshskill-footerRow { display: flex; justify-content: flex-end; gap: 8px; }
.dshskill-field { display: flex; flex-direction: column; gap: 4px; }
.dshskill-fieldMain { display: flex; flex-direction: column; gap: 4px; }
.dshskill-fieldLabel { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dshskill-fieldHint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption); }
.dshskill-input {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  outline: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}
.dshskill-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dshskill-input:focus-visible {
  border-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 18%, transparent);
}
.dshskill-input:disabled { opacity: 0.6; }
.dshskill-textarea { height: auto; min-height: 60px; padding: 7px 10px; line-height: 19px; resize: vertical; }
.dshskill-textareaCode {
  min-height: 140px;
  font-family: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 18px;
}
.dshskill-errorText { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }

.dshskill-modalWide { width: min(560px, 100%); }

/* Directory chooser: breadcrumbs, path jump, and the scrollable child list. */
.dshskill-chooserBody { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.dshskill-pathJump { display: flex; align-items: center; gap: 6px; }
.dshskill-pathJump .dshskill-input { flex: 1 1 auto; min-width: 0; }
.dshskill-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 1px; min-height: 20px; }
.dshskill-crumbSeat { display: inline-flex; align-items: center; gap: 1px; min-width: 0; }
.dshskill-crumb {
  max-width: 220px;
  padding: 2px 5px;
  overflow: hidden;
  border: none;
  border-radius: var(--dsw-radius-xs);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.dshskill-crumb:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshskill-crumb:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dshskill-crumb:disabled { opacity: 0.5; cursor: default; }
.dshskill-crumbChevron { flex: none; width: 10px; height: 10px; color: var(--dsw-alias-label-caption); }
.dshskill-chooserCurrent { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dshskill-chooserCurrent .dshskill-path { min-width: 0; overflow-wrap: anywhere; }
.dshskill-dirList {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 132px;
  max-height: min(280px, 40vh);
  padding: 2px;
  overflow-y: auto;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
}
.dshskill-dirRow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.dshskill-dirRow:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshskill-dirRow:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.dshskill-dirRow:disabled { opacity: 0.55; cursor: default; }
.dshskill-dirIcon { flex: none; width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary); }
.dshskill-dirName { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshskill-dirChevron { flex: none; width: 12px; height: 12px; color: var(--dsw-alias-label-caption); }
.dshskill-chooserLoading { display: flex; align-items: center; gap: 8px; padding: 14px 10px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dshskill-chooserError {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
  margin: 2px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dshskill-chooserError .dshskill-bannerText { flex: 1 1 200px; }
.dshskill-chooserEmpty { display: flex; flex-direction: column; gap: 3px; margin: auto; padding: 16px 12px; text-align: center; }
.dshskill-chooserFooter { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; }

.dshskill-selRoot { position: relative; display: inline-flex; min-width: 0; }
.dshskill-selTrigger {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px 0 9px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  cursor: pointer;
}
.dshskill-selTrigger:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dshskill-selTrigger[aria-expanded='true'] {
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
}
.dshskill-selTrigger:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dshskill-selTrigger:disabled { opacity: 0.5; cursor: default; }
.dshskill-selIcon {
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--dsw-alias-label-caption);
  transition: color 120ms ease;
}
.dshskill-selTrigger:hover:not(:disabled) .dshskill-selIcon { color: var(--dsw-alias-label-secondary); }
.dshskill-selTrigger[aria-expanded='true'] .dshskill-selIcon { color: var(--dsw-alias-brand-primary); }
.dshskill-selLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshskill-selChevron {
  flex: none;
  width: 11px;
  height: 11px;
  color: var(--dsw-alias-label-caption);
  transition: transform 140ms ease;
}
.dshskill-selTrigger[aria-expanded='true'] .dshskill-selChevron { color: var(--dsw-alias-label-secondary); }

.dshskill-pop {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-width: calc(100vw - 32px);
  max-height: min(440px, 60vh);
  overflow: hidden;
  padding: 4px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
}
.dshskill-pop:focus { outline: none; }
.dshskill-popHead { display: flex; align-items: center; gap: 8px; padding: 10px 8px 6px; }
.dshskill-popMark { flex: none; }
.dshskill-popTitle {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
}
.dshskill-popChip {
  display: inline-flex;
  flex: none;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  line-height: 16px;
  font-weight: 600;
  white-space: nowrap;
}
.dshskill-popList { display: flex; flex-direction: column; gap: 1px; min-height: 0; overflow-y: auto; padding: 4px; }
.dshskill-popHead, .dshskill-popSearch, .dshskill-popFooter, .dshskill-popError { flex: none; }
.dshskill-popSearch { margin: 0 4px 6px; }
.dshskill-popSearch input { height: 30px; padding-left: 30px; font-size: 12px; }
.dshskill-popSearch .dshskill-searchIcon { left: 9px; width: 13px; height: 13px; }
.dshskill-invokeRow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 7px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshskill-invokeRow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshskill-invokeRow:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.dshskill-ecoBadge {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dshskill-ecoBadge svg { width: 13px; height: 13px; }
.dshskill-ecoBadge[data-eco='claude'] { color: #D97757; background: color-mix(in srgb, #D97757 16%, transparent); }
.dshskill-ecoBadge[data-eco='codex'] { color: #0F9F7C; background: color-mix(in srgb, #10A37F 16%, transparent); }
.dshskill-ecoBadge[data-eco='agents'] { color: #5B8DEF; background: color-mix(in srgb, #5B8DEF 16%, transparent); }
.dshskill-ecoBadge[data-eco='imported'] { color: #8B5CF6; background: color-mix(in srgb, #8B5CF6 16%, transparent); }
.dshskill-ecoBadge[data-eco='custom'] { color: #8A94A6; background: color-mix(in srgb, #64748B 14%, transparent); }
.dshskill-ecoBadge[data-eco='dsh'] { color: #6D8BFF; background: color-mix(in srgb, #4C6FFF 16%, transparent); }
.dshskill-invokeText { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
.dshskill-invokeTitleLine { display: flex; align-items: center; gap: 5px; min-width: 0; }
.dshskill-invokeName {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  line-height: 17px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dshskill-invokeUserOnly {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-tertiary);
  font-size: 9px;
  line-height: 14px;
  font-weight: 600;
}
.dshskill-invokeDesc {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-tertiary);
}
.dshskill-invokePlus {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  opacity: 0;
  transition: opacity 120ms ease;
}
.dshskill-invokePlus svg { width: 10px; height: 10px; }
.dshskill-invokeRow:hover .dshskill-invokePlus,
.dshskill-invokeRow:focus-visible .dshskill-invokePlus { opacity: 1; }
@media (hover: none) { .dshskill-invokePlus { opacity: 1; } }
.dshskill-popStatus, .dshskill-popEmpty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 10px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dshskill-popEmpty { display: block; }
.dshskill-popError {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 4px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 16px;
}
.dshskill-popErrorText { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dshskill-popFooter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 7px 8px 5px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.dshskill-popSpark { flex: none; width: 12px; height: 12px; color: var(--dsw-alias-label-caption); }
.dshskill-popHint {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-tertiary);
}
.dshskill-kbd {
  display: inline-flex;
  flex: none;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary);
  font-family: inherit;
  font-size: 10px;
  line-height: 16px;
  font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  .dshskill-switchThumb, .dshskill-skillChevron, .dshskill-selChevron,
  .dshskill-selIcon, .dshskill-invokePlus, .dshskill-addChevron { transition: none; }
  .dshskill-skeletonRow, .dshskill-spinner { animation: none; }
}
`

    /** Render the plugin's one scoped stylesheet. */
    function StyleElement() {
      return h('style', { 'data-dshskill-styles': true }, STYLE_TEXT)
    }

    /* ------------------------------------------------------------------ *
     * Small shared controls
     * ------------------------------------------------------------------ */

    /**
     * Two-state switch with the host's `role="switch"` semantics.
     * @param {{ checked: boolean, onChange: (next: boolean) => void, label: string,
     *           disabled?: boolean, title?: string }} props
     */
    function Switch({ checked, onChange, label, disabled, title }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        title,
        disabled: disabled === true,
        className: 'dshskill-switch',
        onClick: () => { onChange(checked !== true) },
      }, h('span', { className: 'dshskill-switchThumb' }))
    }

    /**
     * Read-only capsule badge.
     * @param {{ tone?: string, children?: unknown }} props
     */
    function Badge({ tone, children }) {
      return h('span', { className: 'dshskill-badge', 'data-tone': tone === undefined ? 'neutral' : tone }, children)
    }

    /** Indeterminate spinner. */
    function Spinner() {
      return h('span', { className: 'dshskill-spinner', 'aria-hidden': 'true' })
    }

    /**
     * Labeled form field (the label wraps the control; the hint sits below).
     * @param {{ label: string, hint?: string, children?: unknown }} props
     */
    function Field({ label, hint, children }) {
      return h('div', { className: 'dshskill-field' },
        h('label', { className: 'dshskill-fieldMain' },
          h('span', { className: 'dshskill-fieldLabel' }, label),
          children,
        ),
        hint === undefined ? null : h('span', { className: 'dshskill-fieldHint' }, hint),
      )
    }

    /**
     * Modal dialog rendered in place (no body append): mask, focus trap,
     * Escape close, focus restore.
     * @param {{ title: string, description?: string, busy?: boolean, children?: unknown,
     *           footer?: unknown, onClose: () => void }} props
     */
    function Modal({ title, description, busy, wide, children, footer, onClose }) {
      const modalRef = useRef(null)
      const headingId = useId()
      const busyRef = useRef(busy === true)
      const closeRef = useRef(onClose)
      busyRef.current = busy === true
      closeRef.current = onClose

      useEffect(() => {
        const previous = typeof document === 'undefined' ? null : document.activeElement
        const node = modalRef.current
        const timer = window.setTimeout(() => {
          const target = node === null ? null : node.querySelector('[data-autofocus]')
          if (target !== null && typeof target.focus === 'function') target.focus()
        }, 0)
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || busyRef.current) return
          event.preventDefault()
          event.stopPropagation()
          closeRef.current()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          window.clearTimeout(timer)
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous !== null && typeof previous.focus === 'function') {
            try {
              previous.focus()
            } catch {
              // The opener may have unmounted.
            }
          }
        }
      }, [])

      const trapFocus = (event) => {
        if (event.key !== 'Tab') return
        const node = modalRef.current
        if (node === null) return
        const focusables = node.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]')
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }

      return h('div', { className: 'dshskill-modalLayer' },
        h('div', {
          className: 'dshskill-modalMask',
          'aria-hidden': 'true',
          onClick: () => { if (!busyRef.current) closeRef.current() },
        }),
        h('div', {
          ref: modalRef,
          className: wide === true ? 'dshskill-modal dshskill-modalWide' : 'dshskill-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': headingId,
          tabIndex: -1,
          onKeyDown: trapFocus,
        },
          h('div', { className: 'dshskill-modalHead' },
            h('h3', { className: 'dshskill-modalTitle', id: headingId }, title),
            description === undefined ? null : h('p', { className: 'dshskill-modalDesc' }, description),
          ),
          children,
          footer === undefined ? null : h('div', { className: 'dshskill-modalFooter' }, footer),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Add-skill split menu
     * ------------------------------------------------------------------ */

    /**
     * Primary "Add skill" button with its split menu of add paths.
     * @param {{ t: (key: string, params?: Record<string, unknown>) => string,
     *           disabled: boolean, onImport: () => void, onAddSource: () => void,
     *           onCreate: () => void }} props
     */
    function AddMenu({ t, disabled, onImport, onAddSource, onCreate }) {
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const itemRefs = useRef([])

      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const root = rootRef.current
          if (root !== null && event.target instanceof Node && root.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          if (triggerRef.current !== null) triggerRef.current.focus()
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      useEffect(() => {
        if (!open) return
        const first = itemRefs.current.find(node => node !== null && node !== undefined)
        if (first !== undefined) first.focus()
      }, [open])

      const items = [
        { key: 'import', icon: IconFolder, label: t('add.import'), description: t('add.importDesc'), run: onImport },
        { key: 'source', icon: IconLayers, label: t('add.source'), description: t('add.sourceDesc'), run: onAddSource },
        { key: 'create', icon: IconPencil, label: t('add.create'), description: t('add.createDesc'), run: onCreate },
      ]

      const closeAndRun = (run) => {
        setOpen(false)
        if (triggerRef.current !== null) triggerRef.current.focus()
        run()
      }

      const onMenuKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          if (triggerRef.current !== null) triggerRef.current.focus()
          return
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
        event.preventDefault()
        const nodes = itemRefs.current.filter(node => node !== null && node !== undefined)
        if (nodes.length === 0) return
        if (event.key === 'Home') {
          nodes[0].focus()
          return
        }
        if (event.key === 'End') {
          nodes[nodes.length - 1].focus()
          return
        }
        const index = nodes.indexOf(document.activeElement)
        const step = event.key === 'ArrowDown' ? 1 : -1
        const next = index === -1 ? 0 : (index + step + nodes.length) % nodes.length
        nodes[next].focus()
      }

      // One menu-trigger button: the caret is the dropdown indicator, not a
      // second control with the same action (it used to be a split button whose
      // halves both only toggled the menu).
      return h('div', { className: 'dshskill-addGroup', ref: rootRef, role: 'group', 'aria-label': t('add.aria') },
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'dshskill-btn dshskill-btnPrimary dshskill-addMain',
          disabled,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => { setOpen(value => !value) },
          onKeyDown: (event) => {
            if (!open && event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
            }
          },
        },
          h(IconPlus, { className: 'dshskill-btnIcon' }),
          h('span', null, t('add.label')),
          h(IconChevronDown, { className: 'dshskill-addChevron' }),
        ),
        open
          ? h('div', { className: 'dshskill-menu', role: 'menu', 'aria-label': t('add.menuAria'), onKeyDown: onMenuKeyDown },
            items.map((item, index) => h('button', {
              key: item.key,
              ref: (node) => { itemRefs.current[index] = node },
              type: 'button',
              role: 'menuitem',
              className: 'dshskill-menuItem',
              onClick: () => { closeAndRun(item.run) },
            },
              h('span', { className: 'dshskill-menuIcon' }, h(item.icon, null)),
              h('span', { className: 'dshskill-menuCopy' },
                h('span', { className: 'dshskill-menuLabel' }, item.label),
                h('span', { className: 'dshskill-menuDesc' }, item.description),
              ),
            )),
          )
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Status surfaces
     * ------------------------------------------------------------------ */

    /** Initial-load skeleton rows. @param {{ t }} props */
    function LoadingSkeleton({ t }) {
      return h('div', { className: 'dshskill-skeleton', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dshskill-visuallyHidden' }, t('common.loading')),
        h('div', { className: 'dshskill-skeletonRow' }),
        h('div', { className: 'dshskill-skeletonRow' }),
        h('div', { className: 'dshskill-skeletonRow' }),
      )
    }

    /**
     * Failure banner with a Retry action.
     * @param {{ t, message: string, busy?: boolean, onRetry: () => void }} props
     */
    function ErrorBanner({ t, message, busy, onRetry }) {
      return h('div', { className: 'dshskill-banner', 'data-kind': 'error', role: 'alert' },
        h(IconWarning, { className: 'dshskill-bannerIcon' }),
        h('span', { className: 'dshskill-bannerText' }, message),
        h('button', {
          type: 'button',
          className: 'dshskill-btn dshskill-btnOutline dshskill-btnSm',
          disabled: busy === true,
          onClick: onRetry,
        }, t('common.retry')),
      )
    }

    /* ------------------------------------------------------------------ *
     * Source rows
     * ------------------------------------------------------------------ */

    /**
     * One source row: label, middle-truncated path, skill count, enable switch,
     * and (for custom sources) inline-confirmed removal.
     * @param {{ t, source: Record<string, any>, busy: boolean,
     *           onToggle: (source: Record<string, any>) => void,
     *           onRemove: (source: Record<string, any>) => void }} props
     */
    function SourceRow({ t, source, busy, onToggle, onRemove }) {
      const [confirming, setConfirming] = useState(false)
      const label = source.id === 'imported' ? t('sources.managedLabel') : source.label
      const countText = source.skillCount === 1
        ? t('count.skillOne')
        : t('count.skillMany', { count: source.skillCount })
      const imported = source.kind === 'imported'

      return h('li', { className: 'dshskill-source', 'data-missing': source.exists ? undefined : 'true' },
        h('div', { className: 'dshskill-sourceRow' },
          h('div', { className: 'dshskill-sourceMain' },
            h('div', { className: 'dshskill-sourceTitleLine' },
              h('span', { className: 'dshskill-sourceLabel', title: label }, label),
              source.plugin === '' ? null : h(Badge, { tone: 'neutral' }, source.plugin),
              source.exists ? null : h(Badge, { tone: 'warning' }, t('sources.missing')),
            ),
            source.path === '' ? null : h('code', { className: 'dshskill-path', title: source.path }, truncateMiddle(source.path, 58)),
          ),
          h('span', { className: 'dshskill-sourceCount' }, countText),
          imported
            ? h(Badge, { tone: 'quiet' }, t('common.alwaysOn'))
            : h(Switch, {
              checked: source.enabled,
              disabled: busy,
              label: t('source.switchAria', { label }),
              onChange: () => { onToggle(source) },
            }),
          source.removable
            ? h('button', {
              type: 'button',
              className: 'dshskill-btn dshskill-btnGhost dshskill-btnSm',
              disabled: busy,
              'aria-label': t('sources.remove'),
              title: t('sources.remove'),
              onClick: () => { setConfirming(true) },
            }, h(IconTrash, { className: 'dshskill-btnIcon' }))
            : null,
        ),
        confirming
          ? h('div', { className: 'dshskill-rowConfirm' },
            h('p', { className: 'dshskill-rowConfirmText' }, t('sources.confirm')),
            h('button', {
              type: 'button',
              className: 'dshskill-btn dshskill-btnDanger dshskill-btnSm',
              disabled: busy,
              onClick: () => { onRemove(source) },
            }, t('sources.confirmRemove')),
            h('button', {
              type: 'button',
              className: 'dshskill-btn dshskill-btnOutline dshskill-btnSm',
              disabled: busy,
              onClick: () => { setConfirming(false) },
            }, t('common.cancel')),
          )
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Skill rows + expandable detail
     * ------------------------------------------------------------------ */

    /**
     * Expanded detail of one skill: identity, paths, when-to-use, metadata,
     * diagnostics, lazily loaded model-facing instructions, and removal.
     * @param {{ t, skill: Record<string, any>, id: string, busy: boolean,
     *           onRemove: (skill: Record<string, any>) => void }} props
     */
    function SkillDetail({ t, skill, id, busy, onRemove }) {
      const [instructions, setInstructions] = useState(null)
      const [confirmingRemove, setConfirmingRemove] = useState(false)
      const metadata = metadataText(skill.metadata)
      const manageable = skill.sourceId === 'imported' && skill.shadowedBy === undefined

      const loadInstructions = async () => {
        setInstructions({ status: 'loading', content: '', error: '' })
        try {
          const value = await fetchSkill(skill.name)
          const content = isObject(value) ? asString(value.content) : ''
          setInstructions({ status: 'ready', content, error: '' })
        } catch (cause) {
          setInstructions({ status: 'error', content: '', error: messageOf(cause) })
        }
      }

      const instructionBusy = instructions !== null && instructions.status === 'loading'

      return h('div', { className: 'dshskill-detail', id },
        h('div', { className: 'dshskill-detailRow' },
          h('span', { className: 'dshskill-detailLabel' }, t('skills.source')),
          h('span', { className: 'dshskill-detailValue' }, skill.sourceLabel === '' ? skill.sourceId : skill.sourceLabel),
        ),
        skill.path === '' ? null : h('div', { className: 'dshskill-detailRow' },
          h('span', { className: 'dshskill-detailLabel' }, t('skills.path')),
          h('code', { className: 'dshskill-path', title: skill.path }, truncateMiddle(skill.path, 72)),
        ),
        skill.dir === '' ? null : h('div', { className: 'dshskill-detailRow' },
          h('span', { className: 'dshskill-detailLabel' }, t('skills.dir')),
          h('code', { className: 'dshskill-path', title: skill.dir }, truncateMiddle(skill.dir, 72)),
        ),
        h('div', { className: 'dshskill-detailBlock' },
          h('span', { className: 'dshskill-detailLabel' }, t('skills.description')),
          h('p', { className: 'dshskill-detailText' }, skill.description === '' ? t('skills.noDescription') : skill.description),
        ),
        skill.whenToUse === '' ? null : h('div', { className: 'dshskill-detailBlock' },
          h('span', { className: 'dshskill-detailLabel' }, t('skills.whenToUse')),
          h('p', { className: 'dshskill-detailText' }, skill.whenToUse),
        ),
        skill.shadowedBy === undefined ? null : h('p', { className: 'dshskill-detailHint' }, t('skills.shadowedNote')),
        metadata === '' ? null : h('div', { className: 'dshskill-detailBlock' },
          h('span', { className: 'dshskill-detailLabel' }, t('skills.metadata')),
          h('pre', { className: 'dshskill-code' }, metadata),
        ),
        skill.diagnostics.length === 0 ? null : h('div', { className: 'dshskill-diagnostics' },
          h('span', { className: 'dshskill-detailLabel' }, t('skills.diagnostics')),
          h('ul', { className: 'dshskill-diagList' },
            skill.diagnostics.map((message, index) => h('li', { key: String(index), className: 'dshskill-diagItem' },
              h(IconWarning, { className: 'dshskill-diagIcon' }),
              h('span', null, message),
            )),
          ),
        ),
        h('div', { className: 'dshskill-detailBlock' },
          h('div', { className: 'dshskill-detailHead' },
            h('span', { className: 'dshskill-detailLabel' }, t('skills.instructions')),
            instructions !== null && instructions.status === 'ready'
              ? h('button', {
                type: 'button',
                className: 'dshskill-btn dshskill-btnGhost dshskill-btnSm',
                onClick: () => { setInstructions(null) },
              }, t('skills.hideInstructions'))
              : h('button', {
                type: 'button',
                className: 'dshskill-btn dshskill-btnGhost dshskill-btnSm',
                disabled: instructionBusy,
                onClick: () => { void loadInstructions() },
              },
                instructionBusy ? h(Spinner) : h(IconSpark, { className: 'dshskill-btnIcon' }),
                h('span', null, instructionBusy ? t('skills.instructionsLoading') : t('skills.viewInstructions')),
              ),
          ),
          instructions !== null && instructions.status === 'error'
            ? h('p', { className: 'dshskill-errorText', role: 'alert' }, t('skills.instructionsError', { message: instructions.error }))
            : null,
          instructions !== null && instructions.status === 'ready'
            ? h('pre', { className: 'dshskill-code' }, instructions.content === '' ? t('skills.instructionsEmpty') : instructions.content)
            : null,
        ),
        manageable
          ? (confirmingRemove
            ? h('div', { className: 'dshskill-confirm' },
              h('p', { className: 'dshskill-confirmText' }, t('skills.removeConfirm', { name: skill.name })),
              h('button', {
                type: 'button',
                className: 'dshskill-btn dshskill-btnDanger dshskill-btnSm',
                disabled: busy,
                onClick: () => { onRemove(skill) },
              }, t('skills.removeConfirmAction')),
              h('button', {
                type: 'button',
                className: 'dshskill-btn dshskill-btnOutline dshskill-btnSm',
                disabled: busy,
                onClick: () => { setConfirmingRemove(false) },
              }, t('common.cancel')),
            )
            : h('div', { className: 'dshskill-confirm' },
              h('button', {
                type: 'button',
                className: 'dshskill-btn dshskill-btnGhost dshskill-btnSm dshskill-btnDangerText',
                disabled: busy,
                onClick: () => { setConfirmingRemove(true) },
              }, h(IconTrash, { className: 'dshskill-btnIcon' }), h('span', null, t('skills.remove'))),
            ))
          : h('p', { className: 'dshskill-detailHint' }, t('skills.readOnlyNote')),
      )
    }

    /**
     * One searchable skill row with enable switch, ecosystem badge, and a
     * disclosure that mounts the detail lazily.
     * @param {{ t, skill: Record<string, any>, expanded: boolean, busy: boolean,
     *           onToggleExpand: (skill: Record<string, any>) => void,
     *           onToggleEnabled: (skill: Record<string, any>) => void,
     *           onRemove: (skill: Record<string, any>) => void }} props
     */
    function SkillRow({ t, skill, expanded, busy, onToggleExpand, onToggleEnabled, onRemove }) {
      const detailId = useId()
      const shadowed = skill.shadowedBy !== undefined

      return h('li', {
        className: 'dshskill-skill',
        'data-disabled': skill.enabled ? undefined : 'true',
        'data-shadowed': shadowed ? 'true' : undefined,
      },
        h('div', { className: 'dshskill-skillRow' },
          shadowed
            ? h('span', { className: 'dshskill-skillTogglePlaceholder', 'aria-hidden': 'true' })
            : h(Switch, {
              checked: skill.enabled,
              disabled: busy,
              label: t('skills.switchAria', { name: skill.name }),
              onChange: () => { onToggleEnabled(skill) },
            }),
          h('button', {
            type: 'button',
            className: 'dshskill-skillMain',
            'aria-expanded': expanded,
            'aria-controls': expanded ? detailId : undefined,
            onClick: () => { onToggleExpand(skill) },
          },
            h('span', { className: 'dshskill-skillTitleLine' },
              h('span', { className: 'dshskill-skillName', title: skill.name }, skill.name),
              h(Badge, { tone: ecosystemTone(skill.ecosystem) }, t(ecosystemKey(skill.ecosystem))),
              shadowed ? h(Badge, { tone: 'quiet' }, t('skills.shadowed', { name: skill.shadowedBy })) : null,
              skill.modelInvocable ? null : h(Badge, { tone: 'warning' }, t('skills.modelHidden')),
              skill.enabled ? null : h(Badge, { tone: 'quiet' }, t('skills.disabled')),
            ),
            h('span', { className: 'dshskill-skillDesc' }, skill.description === '' ? t('skills.noDescription') : skill.description),
          ),
          h(IconChevronDown, { className: classNames('dshskill-skillChevron', expanded ? 'dshskill-open' : '') }),
        ),
        expanded
          ? h(SkillDetail, { t, skill, id: detailId, busy, onRemove })
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Modals: create skill + path prompt fallback
     * ------------------------------------------------------------------ */

    /**
     * Inline authoring form for a managed skill.
     * @param {{ t, onClose: () => void,
     *           onSubmit: (values: { name: string, description: string,
     *             instructions: string, whenToUse: string }) =>
     *             Promise<{ ok: boolean, message?: string }> }} props
     */
    function CreateSkillModal({ t, onClose, onSubmit }) {
      const [name, setName] = useState('')
      const [description, setDescription] = useState('')
      const [instructions, setInstructions] = useState('')
      const [whenToUse, setWhenToUse] = useState('')
      const [error, setError] = useState('')
      const [submitting, setSubmitting] = useState(false)

      const submit = async () => {
        if (submitting) return
        if (name.trim() === '' || description.trim() === '' || instructions.trim() === '') {
          setError(t('create.required'))
          return
        }
        setSubmitting(true)
        setError('')
        const result = await onSubmit({
          name: name.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
          whenToUse: whenToUse.trim(),
        })
        setSubmitting(false)
        if (!result.ok) setError(t('error.action', { message: result.message === undefined ? '' : result.message }))
      }

      return h(Modal, {
        title: t('create.title'),
        description: t('create.desc'),
        busy: submitting,
        onClose,
        footer: h('div', { className: 'dshskill-footerRow' },
          h('button', { type: 'button', className: 'dshskill-btn dshskill-btnOutline', disabled: submitting, onClick: onClose }, t('common.cancel')),
          h('button', { type: 'button', className: 'dshskill-btn dshskill-btnPrimary', disabled: submitting, onClick: () => { void submit() } }, submitting ? t('create.busy') : t('create.submit')),
        ),
      },
        h(Field, { label: t('create.name'), hint: t('create.nameHint') },
          h('input', {
            type: 'text',
            className: 'dshskill-input',
            value: name,
            placeholder: t('create.namePlaceholder'),
            'data-autofocus': true,
            disabled: submitting,
            onChange: (event) => { setName(event.target.value) },
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void submit() } },
          }),
        ),
        h(Field, { label: t('create.description'), hint: t('create.descriptionHint') },
          h('textarea', {
            className: 'dshskill-input dshskill-textarea',
            rows: 2,
            value: description,
            disabled: submitting,
            onChange: (event) => { setDescription(event.target.value) },
          }),
        ),
        h(Field, { label: t('create.instructions'), hint: t('create.instructionsHint') },
          h('textarea', {
            className: 'dshskill-input dshskill-textarea dshskill-textareaCode',
            rows: 7,
            value: instructions,
            disabled: submitting,
            onChange: (event) => { setInstructions(event.target.value) },
          }),
        ),
        h(Field, { label: t('create.whenToUse') },
          h('input', {
            type: 'text',
            className: 'dshskill-input',
            value: whenToUse,
            disabled: submitting,
            onChange: (event) => { setWhenToUse(event.target.value) },
          }),
        ),
        error === '' ? null : h('p', { className: 'dshskill-errorText', role: 'alert' }, error),
      )
    }

    /**
     * Text-input fallback for deployments without the Workspace directory picker.
     * @param {{ t, prompt: { kind: string, value: string, busy: boolean, error: string },
     *           onChange: (value: string) => void, onClose: () => void,
     *           onSubmit: () => void }} props
     */
    function PathPromptModal({ t, prompt, onChange, onClose, onSubmit }) {
      const importing = prompt.kind === 'import'
      const title = importing ? t('path.importTitle') : t('path.sourceTitle')
      const description = importing ? t('path.importDesc') : t('path.sourceDesc')
      const submitLabel = importing ? t('path.submitImport') : t('path.submitSource')

      return h(Modal, {
        title,
        description,
        busy: prompt.busy,
        onClose,
        footer: h('div', { className: 'dshskill-footerRow' },
          h('button', { type: 'button', className: 'dshskill-btn dshskill-btnOutline', disabled: prompt.busy, onClick: onClose }, t('common.cancel')),
          h('button', { type: 'button', className: 'dshskill-btn dshskill-btnPrimary', disabled: prompt.busy, onClick: onSubmit }, prompt.busy ? t('common.working') : submitLabel),
        ),
      },
        h(Field, { label: t('path.label') },
          h('input', {
            type: 'text',
            className: 'dshskill-input',
            value: prompt.value,
            placeholder: t('path.placeholder'),
            'data-autofocus': true,
            disabled: prompt.busy,
            onChange: (event) => { onChange(event.target.value) },
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); onSubmit() } },
          }),
        ),
        prompt.error === '' ? null : h('p', { className: 'dshskill-errorText', role: 'alert' }, prompt.error),
      )
    }

    /* ------------------------------------------------------------------ *
     * Directory chooser (browse capability)
     * ------------------------------------------------------------------ */

    /**
     * In-plugin directory chooser over the Workspace browse capability, used by
     * the import-folder and add-source flows when `uiWorkspace.listDirectory`
     * exists (the Web profile composes the `browse` directory capability, not
     * the native picker).
     * @param {{ t, kind: 'import' | 'source', busy: boolean,
     *           onConfirm: (path: string) => Promise<{ ok: boolean, message?: string }>,
     *           onCancel: () => void, onManual: () => void }} props
     */
    function DirectoryChooserModal({ t, kind, busy, onConfirm, onCancel, onManual }) {
      const [listing, setListing] = useState(null)
      const [scanning, setScanning] = useState(false)
      const [scanError, setScanError] = useState('')
      const [showHidden, setShowHidden] = useState(false)
      const [pathDraft, setPathDraft] = useState('')
      const [jumpError, setJumpError] = useState('')
      const [submitting, setSubmitting] = useState(false)
      const [actionError, setActionError] = useState('')
      const sequenceRef = useRef(0)
      const controllerRef = useRef(null)
      const currentPathRef = useRef('')

      const scan = useCallback(async (path) => {
        const seq = ++sequenceRef.current
        if (controllerRef.current !== null) controllerRef.current.abort()
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        controllerRef.current = controller
        setScanning(true)
        setJumpError('')
        try {
          const value = await readDirectory(path, controller === null ? undefined : controller.signal)
          if (seq !== sequenceRef.current) return
          const next = normalizeListing(value)
          if (next === null) throw requestError('invalid-listing', 'the directory listing response was malformed', 0)
          setListing(next)
          currentPathRef.current = next.path
          setScanError('')
          setPathDraft('')
        } catch (cause) {
          if (seq !== sequenceRef.current) return
          if (controller !== null && controller.signal.aborted) return
          setScanError(browseFailureText(cause))
        } finally {
          if (seq === sequenceRef.current) setScanning(false)
        }
      }, [])

      useEffect(() => {
        void scan(undefined)
        return () => {
          sequenceRef.current += 1
          if (controllerRef.current !== null) controllerRef.current.abort()
        }
      }, [scan])

      const disabled = busy === true || submitting
      const crumbs = listing === null ? [] : crumbTrail(listing, t('chooser.home'))
      const visibleEntries = listing === null ? [] : listing.entries.filter(entry => showHidden || !entry.hidden)

      const openPath = () => {
        const target = pathDraft.trim()
        if (target === '') {
          setJumpError(t('chooser.jumpRequired'))
          return
        }
        void scan(target)
      }

      const confirm = async () => {
        if (listing === null || scanning || disabled) return
        setSubmitting(true)
        setActionError('')
        try {
          const result = await onConfirm(listing.path)
          if (!result.ok) {
            setActionError(t('error.action', { message: result.message === undefined ? '' : result.message }))
          }
        } finally {
          setSubmitting(false)
        }
      }

      const retryCurrent = () => {
        const target = currentPathRef.current === '' ? undefined : currentPathRef.current
        void scan(target)
      }

      return h(Modal, {
        title: t('chooser.title'),
        description: kind === 'import' ? t('chooser.importHint') : t('chooser.sourceHint'),
        busy: disabled,
        wide: true,
        onClose: () => { if (!disabled) onCancel() },
        footer: h('div', { className: 'dshskill-chooserFooter' },
          h('button', {
            type: 'button',
            className: 'dshskill-btn dshskill-btnGhost dshskill-btnSm',
            disabled: disabled || listing === null,
            'aria-pressed': showHidden,
            onClick: () => { setShowHidden(value => !value) },
          },
            h(IconFolder, { className: 'dshskill-btnIcon' }),
            h('span', null, t('chooser.showHidden')),
            showHidden ? h(IconCheck, { className: 'dshskill-btnIcon' }) : null,
          ),
          h('button', {
            type: 'button',
            className: 'dshskill-btn dshskill-btnGhost dshskill-btnSm',
            disabled,
            onClick: () => { if (!disabled) onManual() },
          }, t('chooser.manual')),
          h('span', { className: 'dshskill-blockSpacer' }),
          h('button', {
            type: 'button',
            className: 'dshskill-btn dshskill-btnOutline',
            disabled,
            onClick: () => { if (!disabled) onCancel() },
          }, t('common.cancel')),
          h('button', {
            type: 'button',
            className: 'dshskill-btn dshskill-btnPrimary',
            disabled: disabled || listing === null || scanning,
            onClick: () => { void confirm() },
          }, submitting ? t('common.working') : t('chooser.select')),
        ),
      },
        h('div', { className: 'dshskill-chooserBody' },
          h('div', { className: 'dshskill-pathJump' },
            h('input', {
              type: 'text',
              className: 'dshskill-input',
              value: pathDraft,
              placeholder: t('chooser.pathPlaceholder'),
              'aria-label': t('chooser.pathLabel'),
              'data-autofocus': true,
              disabled: submitting,
              onChange: (event) => {
                setPathDraft(event.target.value)
                setJumpError('')
              },
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                openPath()
              },
            }),
            h('button', {
              type: 'button',
              className: 'dshskill-btn dshskill-btnOutline dshskill-btnSm',
              disabled: submitting,
              onClick: openPath,
            }, t('chooser.openPath')),
          ),
          jumpError === '' ? null : h('p', { className: 'dshskill-errorText', role: 'alert' }, jumpError),
          crumbs.length === 0
            ? null
            : h('nav', { className: 'dshskill-crumbs', 'aria-label': t('chooser.current') },
              crumbs.map((crumb, index) => h('span', { key: crumb.path + '#' + String(index), className: 'dshskill-crumbSeat' },
                index > 0 ? h(IconChevronRight, { className: 'dshskill-crumbChevron' }) : null,
                h('button', {
                  type: 'button',
                  className: 'dshskill-crumb',
                  title: crumb.path,
                  disabled,
                  onClick: () => { void scan(crumb.path) },
                }, crumb.name),
              )),
            ),
          listing === null
            ? null
            : h('div', { className: 'dshskill-chooserCurrent' },
              h('span', { className: 'dshskill-detailLabel' }, t('chooser.current')),
              h('code', { className: 'dshskill-path', title: listing.path }, listing.path),
              scanning ? h(Spinner) : null,
            ),
          h('div', {
            className: 'dshskill-dirList',
            role: 'group',
            'aria-label': t('chooser.current'),
            'aria-busy': scanning ? 'true' : undefined,
          },
            scanning && listing === null
              ? h('div', { className: 'dshskill-chooserLoading' }, h(Spinner), h('span', null, t('chooser.loading')))
              : (listing === null
                ? h('div', { className: 'dshskill-chooserError', role: 'alert' },
                  h(IconWarning, { className: 'dshskill-bannerIcon' }),
                  h('span', { className: 'dshskill-bannerText' }, t('chooser.error', { message: scanError })),
                  h('button', {
                    type: 'button',
                    className: 'dshskill-btn dshskill-btnOutline dshskill-btnSm',
                    disabled: scanning,
                    onClick: () => { void scan(undefined) },
                  }, t('chooser.retry')),
                )
                : (visibleEntries.length === 0
                  ? h('div', { className: 'dshskill-chooserEmpty' },
                    h('p', { className: 'dshskill-emptyTitle' }, t('chooser.emptyTitle')),
                    h('p', { className: 'dshskill-emptyText' }, t('chooser.empty')),
                  )
                  : visibleEntries.map(entry => h('button', {
                    key: entry.path,
                    type: 'button',
                    className: 'dshskill-dirRow',
                    title: entry.path,
                    disabled,
                    onClick: () => { void scan(entry.path) },
                  },
                    h(IconFolder, { className: 'dshskill-dirIcon' }),
                    h('span', { className: 'dshskill-dirName' }, entry.name),
                    h(IconChevronRight, { className: 'dshskill-dirChevron' }),
                  )))),
          ),
          listing !== null && scanError !== ''
            ? h('div', { className: 'dshskill-chooserError', role: 'alert' },
              h(IconWarning, { className: 'dshskill-bannerIcon' }),
              h('span', { className: 'dshskill-bannerText' }, t('chooser.error', { message: scanError })),
              h('button', {
                type: 'button',
                className: 'dshskill-btn dshskill-btnGhost dshskill-btnSm',
                disabled: scanning,
                onClick: retryCurrent,
              }, t('chooser.retry')),
            )
            : null,
          listing !== null && listing.truncated
            ? h('p', { className: 'dshskill-detailHint', role: 'status' }, t('chooser.truncated'))
            : null,
          actionError === '' ? null : h('p', { className: 'dshskill-errorText', role: 'alert' }, actionError),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Settings section: Skill Library
     * ------------------------------------------------------------------ */

    /**
     * The Skill Library settings page: sources, skills, and every mutation the
     * HTTP API exposes.
     * @param {{ close?: () => void, t?: unknown }} props - slot owner + locale seats.
     */
    function SkillSettingsSection(props) {
      const t = translateOf(props)
      const [data, setData] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [refreshing, setRefreshing] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [query, setQuery] = useState('')
      const [expandedKey, setExpandedKey] = useState('')
      const [pending, setPending] = useState(null)
      const [createOpen, setCreateOpen] = useState(false)
      const [pathPrompt, setPathPrompt] = useState(null)
      const [chooser, setChooser] = useState(null)
      const seqRef = useRef(0)
      const pendingRef = useRef(null)

      const load = useCallback(async () => {
        const seq = ++seqRef.current
        setRefreshing(true)
        try {
          const value = await fetchState()
          if (seq !== seqRef.current) return
          setData(normalizeState(value))
          setPhase('ready')
          setError(null)
        } catch (cause) {
          if (seq !== seqRef.current) return
          setError(t('error.load', { message: messageOf(cause) }))
          setPhase(previous => (previous === 'ready' ? 'ready' : 'error'))
        } finally {
          if (seq === seqRef.current) setRefreshing(false)
        }
      }, [t])

      useEffect(() => {
        void load()
      }, [load])

      useEffect(() => {
        if (notice === null) return undefined
        const timer = window.setTimeout(() => { setNotice(null) }, notice.kind === 'error' ? 9000 : 4500)
        return () => { window.clearTimeout(timer) }
      }, [notice])

      const notify = useCallback((kind, text) => { setNotice({ kind, text }) }, [])

      const beginPending = useCallback((key) => {
        if (pendingRef.current !== null) return false
        pendingRef.current = key
        setPending(key)
        return true
      }, [])

      const endPending = useCallback(() => {
        pendingRef.current = null
        setPending(null)
      }, [])

      const runAction = useCallback(async (action, payload) => {
        try {
          const value = await postAction(action, payload)
          const next = normalizeState(value)
          if (next !== null) {
            setData(next)
            setPhase('ready')
            setError(null)
          }
          return { ok: true, value: next }
        } catch (cause) {
          return { ok: false, message: messageOf(cause) }
        }
      }, [])

      const retry = () => {
        setError(null)
        setPhase(previous => (previous === 'error' ? 'loading' : previous))
        void load()
      }

      const sourceLabelOf = (source) => (source.id === 'imported' ? t('sources.managedLabel') : source.label)

      const toggleSource = async (source) => {
        if (!beginPending('source:' + source.id)) return
        try {
          const result = await runAction('setSourceEnabled', { sourceId: source.id, enabled: !source.enabled })
          if (result.ok) notify('success', t(source.enabled ? 'notice.sourceOff' : 'notice.sourceOn', { label: sourceLabelOf(source) }))
          else notify('error', t('error.action', { message: result.message }))
        } finally {
          endPending()
        }
      }

      const removeSource = async (source) => {
        if (!beginPending('source-remove:' + source.id)) return
        try {
          const result = await runAction('removeSource', { sourceId: source.id })
          if (result.ok) notify('success', t('notice.sourceRemoved', { label: sourceLabelOf(source) }))
          else notify('error', t('error.action', { message: result.message }))
        } finally {
          endPending()
        }
      }

      const toggleSkill = async (skill) => {
        if (!beginPending('skill:' + skill.name)) return
        try {
          const result = await runAction('setSkillEnabled', { name: skill.name, enabled: !skill.enabled })
          if (result.ok) notify('success', t(skill.enabled ? 'notice.skillOff' : 'notice.skillOn', { name: skill.name }))
          else notify('error', t('error.action', { message: result.message }))
        } finally {
          endPending()
        }
      }

      const removeSkill = async (skill) => {
        if (!beginPending('skill-remove:' + skill.name)) return
        try {
          const result = await runAction('removeSkill', { name: skill.name })
          if (result.ok) {
            setExpandedKey('')
            notify('success', t('notice.skillRemoved', { name: skill.name }))
          } else {
            notify('error', t('error.action', { message: result.message }))
          }
        } finally {
          endPending()
        }
      }

      const rescan = async () => {
        if (!beginPending('rescan')) return
        try {
          const result = await runAction('rescan', {})
          if (result.ok) notify('success', t('notice.rescanned'))
          else notify('error', t('error.action', { message: result.message }))
        } finally {
          endPending()
        }
      }

      const runImport = async (path) => {
        if (!beginPending('import')) return { ok: false, message: t('common.working') }
        try {
          const result = await runAction('importSkill', { path })
          if (!result.ok) return { ok: false, message: result.message }
          const count = importedCount(result.value)
          notify('success', count === null
            ? t('notice.importDone')
            : count === 0 ? t('notice.importNone') : t('notice.imported', { count }))
          setPathPrompt(null)
          return { ok: true }
        } finally {
          endPending()
        }
      }

      const runAddSource = async (path) => {
        if (!beginPending('source-add')) return { ok: false, message: t('common.working') }
        try {
          const result = await runAction('addSource', { path })
          if (!result.ok) return { ok: false, message: result.message }
          const label = path.split(/[\\/]/).filter(Boolean).pop() || path
          notify('success', t('notice.sourceAdded', { label }))
          setPathPrompt(null)
          return { ok: true }
        } finally {
          endPending()
        }
      }

      /**
       * Pick a directory for one flow. The browse chooser is preferred (the Web
       * profile composes the `browse` directory capability, not the native
       * picker); the native picker and the text form stay as desktop fallbacks.
       * @param {'import' | 'source'} kind - which action consumes the path.
       */
      const startDirectoryFlow = async (kind) => {
        if (pendingRef.current !== null) return
        if (browseWorkspace() !== null) {
          setChooser({ kind })
          return
        }
        let picked
        try {
          picked = await pickDirectory()
        } catch (cause) {
          notify('error', t('error.picker', { message: browseFailureText(cause) }))
          return
        }
        if (picked === undefined) {
          setPathPrompt({ kind, value: '', busy: false, error: '' })
          return
        }
        if (picked === null) return
        const result = kind === 'import' ? await runImport(picked) : await runAddSource(picked)
        if (!result.ok) notify('error', t('error.action', { message: result.message }))
      }

      const startImport = () => startDirectoryFlow('import')
      const startAddSource = () => startDirectoryFlow('source')

      /**
       * Commit the chosen folder from the browse chooser: the existing import /
       * add-source action owns the POST and its success notice.
       * @param {string} path - absolute directory path.
       * @returns {Promise<{ ok: boolean, message?: string }>}
       */
      const confirmChooser = async (path) => {
        if (chooser === null) return { ok: false, message: t('common.working') }
        const result = chooser.kind === 'import' ? await runImport(path) : await runAddSource(path)
        if (result.ok) setChooser(null)
        return result
      }

      /** Leave the chooser for the free-form absolute-path form. */
      const manualFromChooser = () => {
        if (chooser === null) return
        const kind = chooser.kind
        setChooser(null)
        setPathPrompt({ kind, value: '', busy: false, error: '' })
      }

      const submitPathPrompt = async () => {
        if (pathPrompt === null || pathPrompt.busy) return
        const path = pathPrompt.value.trim()
        if (path === '') {
          setPathPrompt(previous => (previous === null ? previous : Object.assign({}, previous, { error: t('path.required') })))
          return
        }
        setPathPrompt(previous => (previous === null ? previous : Object.assign({}, previous, { busy: true, error: '' })))
        const result = pathPrompt.kind === 'import' ? await runImport(path) : await runAddSource(path)
        if (!result.ok) {
          setPathPrompt(previous => (previous === null ? previous : Object.assign({}, previous, { busy: false, error: t('error.action', { message: result.message }) })))
        }
      }

      const submitCreate = async (values) => {
        if (!beginPending('create')) return { ok: false, message: t('common.working') }
        try {
          const payload = {
            name: values.name,
            description: values.description,
            instructions: values.instructions,
          }
          if (values.whenToUse !== '') payload.whenToUse = values.whenToUse
          const result = await runAction('createSkill', payload)
          if (!result.ok) return { ok: false, message: result.message }
          setCreateOpen(false)
          notify('success', t('notice.skillCreated', { name: values.name }))
          return { ok: true }
        } finally {
          endPending()
        }
      }

      const toggleExpand = (skill) => {
        const key = skill.name + '|' + skill.sourceId
        setExpandedKey(current => (current === key ? '' : key))
      }

      const autoSources = useMemo(
        () => (data === null ? [] : data.sources.filter(source => source.auto && source.exists)),
        [data],
      )
      const addedSources = useMemo(
        () => (data === null ? [] : data.sources.filter(source => !source.auto)),
        [data],
      )
      const filteredSkills = useMemo(() => {
        if (data === null) return []
        const needle = query.trim().toLowerCase()
        if (needle === '') return data.skills
        return data.skills.filter(skill => skill.name.toLowerCase().indexOf(needle) !== -1
          || skill.description.toLowerCase().indexOf(needle) !== -1)
      }, [data, query])

      const busy = pending !== null
      const showSkeleton = data === null && phase === 'loading'
      const loadFailedWithoutData = data === null && phase === 'error'
      let statsText = ''
      if (data !== null) {
        statsText = data.stats.total === 1
          ? t('stats.lineOne', { enabled: data.stats.enabled })
          : t('stats.line', { total: data.stats.total, enabled: data.stats.enabled })
      }
      const scannedText = data === null ? '' : formatScannedAt(data.scannedAt)

      return h('section', {
        className: 'dshskill-section',
        'aria-busy': busy || refreshing || showSkeleton ? 'true' : undefined,
      },
        h(StyleElement, { key: 'style' }),
        h('div', { className: 'dshskill-head' },
          h('div', { className: 'dshskill-headTitleRow' },
            h('div', { className: 'dshskill-headText' },
              h('h2', { className: 'dshskill-title' }, t('page.title')),
              h('p', { className: 'dshskill-intro' }, t('page.intro')),
              data === null
                ? null
                : h('p', { className: 'dshskill-intro' },
                  h('span', null, statsText),
                  scannedText === ''
                    ? null
                    : h('span', null, ' · ' + t('stats.scanned', { time: scannedText })),
                ),
            ),
          ),
          h('div', { className: 'dshskill-headActions' },
            h('button', {
              type: 'button',
              className: 'dshskill-btn dshskill-btnGhost',
              disabled: busy || showSkeleton || loadFailedWithoutData,
              onClick: () => { void rescan() },
            },
              h(IconRefresh, { className: 'dshskill-btnIcon' }),
              h('span', null, t('rescan')),
            ),
            h(AddMenu, {
              t,
              disabled: busy || showSkeleton || loadFailedWithoutData,
              onImport: () => { void startImport() },
              onAddSource: () => { void startAddSource() },
              onCreate: () => { setCreateOpen(true) },
            }),
          ),
        ),
        notice === null
          ? null
          : h('div', {
            className: 'dshskill-notice',
            'data-kind': notice.kind,
            role: notice.kind === 'error' ? 'alert' : 'status',
          },
            h('span', { className: 'dshskill-noticeText' }, notice.text),
            h('button', {
              type: 'button',
              className: 'dshskill-iconBtn',
              'aria-label': t('common.dismiss'),
              onClick: () => { setNotice(null) },
            }, h(IconClose, null)),
          ),
        error === null ? null : h(ErrorBanner, { t, message: error, busy: refreshing, onRetry: retry }),
        showSkeleton ? h(LoadingSkeleton, { t }) : null,
        loadFailedWithoutData
          ? null
          : (data === null
            ? null
            : h(Fragment, null,
              h('section', { key: 'auto', className: 'dshskill-block' },
                h('div', { className: 'dshskill-blockHead' },
                  h('h3', { className: 'dshskill-blockTitle' }, t('auto.title')),
                ),
                autoSources.length === 0
                  ? h('div', { className: 'dshskill-empty' },
                    h('p', { className: 'dshskill-emptyText' }, t('auto.empty')),
                    h('p', { className: 'dshskill-hintPath' }, t('auto.emptyPaths')),
                  )
                  : h('ul', { className: 'dshskill-panel' },
                    autoSources.map(source => h(SourceRow, {
                      key: source.id,
                      t,
                      source,
                      busy,
                      onToggle: (value) => { void toggleSource(value) },
                      onRemove: (value) => { void removeSource(value) },
                    })),
                  ),
              ),
              h('section', { key: 'sources', className: 'dshskill-block' },
                h('div', { className: 'dshskill-blockHead' },
                  h('h3', { className: 'dshskill-blockTitle' }, t('sources.title')),
                ),
                addedSources.length === 0
                  ? h('p', { className: 'dshskill-hintBox' }, t('sources.empty'))
                  : h('ul', { className: 'dshskill-panel' },
                    addedSources.map(source => h(SourceRow, {
                      key: source.id,
                      t,
                      source,
                      busy,
                      onToggle: (value) => { void toggleSource(value) },
                      onRemove: (value) => { void removeSource(value) },
                    })),
                  ),
              ),
              data.scanErrors.length === 0
                ? null
                : h('section', { key: 'scan-errors', className: 'dshskill-block' },
                  h('div', { className: 'dshskill-banner', 'data-kind': 'warning', role: 'note' },
                    h(IconWarning, { className: 'dshskill-bannerIcon' }),
                    h('span', { className: 'dshskill-bannerText' }, t('warn.scanErrors', { count: data.scanErrors.length })),
                  ),
                  h('ul', { className: 'dshskill-diagList' },
                    data.scanErrors.slice(0, 8).map((item, index) => h('li', {
                      key: 'scan-' + index,
                      className: 'dshskill-diagItem',
                    },
                      h('code', { className: 'dshskill-path', title: item.path }, truncateMiddle(item.path, 48)),
                      h('span', null, item.message),
                    )),
                  ),
                  data.scanErrors.length > 8
                    ? h('p', { className: 'dshskill-detailHint' }, t('errors.more', { count: data.scanErrors.length - 8 }))
                    : null,
                ),
              h('section', { key: 'skills', className: 'dshskill-block' },
                h('div', { className: 'dshskill-blockHead' },
                  h('h3', { className: 'dshskill-blockTitle' }, t('skills.title')),
                  h('span', { className: 'dshskill-blockCount' }, t('skills.count', { shown: filteredSkills.length, total: data.skills.length })),
                  h('span', { className: 'dshskill-blockSpacer' }),
                  refreshing
                    ? h('span', { className: 'dshskill-status' }, h(Spinner), h('span', null, t('common.loading')))
                    : null,
                ),
                h('div', { className: 'dshskill-search' },
                  h(IconSearch, { className: 'dshskill-searchIcon' }),
                  h('input', {
                    type: 'search',
                    value: query,
                    placeholder: t('skills.search'),
                    'aria-label': t('skills.search'),
                    onChange: (event) => { setQuery(event.target.value) },
                  }),
                ),
                data.skills.length === 0
                  ? h('div', { className: 'dshskill-empty' },
                    h('p', { className: 'dshskill-emptyTitle' }, t('skills.emptyTitle')),
                    h('p', { className: 'dshskill-emptyText' }, t('skills.empty')),
                  )
                  : filteredSkills.length === 0
                    ? h('p', { className: 'dshskill-hintBox' }, t('skills.searchEmpty', { query: query.trim() }))
                    : h('ul', { className: 'dshskill-panel' },
                      filteredSkills.map(skill => {
                        const key = skill.name + '|' + skill.sourceId
                        return h(SkillRow, {
                          key,
                          t,
                          skill,
                          busy,
                          expanded: expandedKey === key,
                          onToggleExpand: toggleExpand,
                          onToggleEnabled: (value) => { void toggleSkill(value) },
                          onRemove: (value) => { void removeSkill(value) },
                        })
                      }),
                    ),
              ),
              h('p', { key: 'project-hint', className: 'dshskill-hintBox' }, t('project.hint')),
            )),
        createOpen
          ? h(CreateSkillModal, {
            t,
            onClose: () => { setCreateOpen(false) },
            onSubmit: submitCreate,
          })
          : null,
        pathPrompt === null
          ? null
          : h(PathPromptModal, {
            t,
            prompt: pathPrompt,
            onChange: (value) => {
              setPathPrompt(previous => (previous === null ? previous : Object.assign({}, previous, { value, error: '' })))
            },
            onClose: () => { if (!pathPrompt.busy) setPathPrompt(null) },
            onSubmit: () => { void submitPathPrompt() },
          }),
        chooser === null
          ? null
          : h(DirectoryChooserModal, {
            t,
            kind: chooser.kind,
            busy,
            onConfirm: confirmChooser,
            onCancel: () => { setChooser(null) },
            onManual: manualFromChooser,
          }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Composer explicit skill invocation
     * ------------------------------------------------------------------ */

    /**
     * Composer control that inserts an explicit `/\<skill> ` token into the
     * draft. The built-in skill machinery renders that token into the next
     * message and loads the skill's full instructions deterministically —
     * unlike description-based auto-routing, and it also reaches user-invocable
     * skills the model catalog never advertises.
     * @param {{ sessionId?: string, inputActions?: Record<string, any>, t?: unknown }} props
     */
    function SkillInvokeButton(props) {
      const t = translateOf(props)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const inputActions = isObject(props.inputActions) ? props.inputActions : null
      const canInsert = inputActions !== null
        && typeof inputActions.captureInsertion === 'function'
        && typeof inputActions.insertText === 'function'
      const [data, setData] = useState(null)
      const [fetching, setFetching] = useState(false)
      const [loadError, setLoadError] = useState('')
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [insertError, setInsertError] = useState('')
      const seqRef = useRef(0)
      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const popoverRef = useRef(null)
      const searchRef = useRef(null)
      const triggerId = useId()
      const panelId = useId()

      const loadSkills = useCallback(async () => {
        const seq = ++seqRef.current
        setFetching(true)
        setLoadError('')
        try {
          const value = await fetchState(sessionId === '' ? undefined : sessionId)
          if (seq !== seqRef.current) return
          setData(normalizeState(value))
        } catch (cause) {
          if (seq !== seqRef.current) return
          setLoadError(messageOf(cause))
        } finally {
          if (seq === seqRef.current) setFetching(false)
        }
      }, [sessionId])

      // A different conversation never reuses the previous popover state.
      useEffect(() => {
        seqRef.current += 1
        setOpen(false)
        setData(null)
        setFetching(false)
        setLoadError('')
        setQuery('')
        setInsertError('')
      }, [sessionId])

      const options = useMemo(() => invocableSkills(data), [data])
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return options
        return options.filter(skill => skill.name.toLowerCase().indexOf(needle) !== -1
          || skill.description.toLowerCase().indexOf(needle) !== -1)
      }, [options, query])

      const closePopover = useCallback((restoreFocus) => {
        setOpen(false)
        setQuery('')
        setInsertError('')
        if (restoreFocus === true && triggerRef.current !== null) triggerRef.current.focus()
      }, [])

      const togglePopover = () => {
        if (open) {
          closePopover(true)
          return
        }
        if (!canInsert) return
        setOpen(true)
        setQuery('')
        setInsertError('')
        setLoadError('')
        void loadSkills()
      }

      const invoke = (skill) => {
        if (!canInsert) {
          setInsertError(t('invoke.noInput'))
          return
        }
        let inserted = false
        try {
          const span = inputActions.captureInsertion()
          // The built-in gesture regex is `(^|\s)\/(...)(?=\s|$)`: it needs
          // start-of-text or whitespace before the slash. When the caret follows
          // existing text (e.g. a Chinese prompt with no trailing space), prefix
          // one boundary space so the token is actually recognized; it stays a
          // single undo step because the span and insertText call are the same.
          const prefix = isObject(span) && asNumber(span.start, 0) > 0 ? ' ' : ''
          inserted = inputActions.insertText(prefix + '/' + skill.name + ' ', span) === true
        } catch {
          inserted = false
        }
        if (!inserted) {
          setInsertError(t('invoke.insertFailed'))
          return
        }
        closePopover(true)
      }

      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const root = rootRef.current
          if (root !== null && event.target instanceof Node && root.contains(event.target)) return
          closePopover(false)
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          closePopover(true)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open, closePopover])

      useEffect(() => {
        if (!open) return undefined
        const timer = window.setTimeout(() => {
          const search = searchRef.current
          if (search !== null) search.focus()
        }, 0)
        return () => { window.clearTimeout(timer) }
      }, [open])

      const onPopoverKeyDown = (event) => {
        if (event.key !== 'Tab') return
        const popover = popoverRef.current
        if (popover === null) return
        const focusables = popover.querySelectorAll('button:not([disabled]), input:not([disabled])')
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }

      const triggerTitle = canInsert ? t('invoke.triggerTitle') : t('invoke.noInput')

      return h('div', { className: 'dshskill-selRoot', ref: rootRef },
        h(StyleElement, { key: 'style' }),
        h('button', {
          ref: triggerRef,
          id: triggerId,
          type: 'button',
          className: 'dshskill-selTrigger',
          disabled: !canInsert,
          title: triggerTitle,
          'aria-label': triggerTitle,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-controls': open ? panelId : undefined,
          'aria-busy': fetching ? 'true' : undefined,
          onClick: togglePopover,
        },
          h(IconInvoke, { className: 'dshskill-selIcon' }),
          h('span', { className: 'dshskill-selLabel' }, t('invoke.label')),
          h(IconChevronDown, { className: classNames('dshskill-selChevron', open ? 'dshskill-open' : '') }),
        ),
        open
          ? h('div', {
            ref: popoverRef,
            id: panelId,
            className: 'dshskill-pop',
            role: 'dialog',
            'aria-label': t('invoke.title'),
            tabIndex: -1,
            onKeyDown: onPopoverKeyDown,
          },
            h('div', { className: 'dshskill-popHead' },
              h(BrandMark, { size: 20, className: 'dshskill-popMark' }),
              h('h4', { className: 'dshskill-popTitle', title: t('invoke.title') }, t('invoke.title')),
              data === null
                ? null
                : h('span', { className: 'dshskill-popChip' }, t('invoke.available', { count: options.length })),
            ),
            h('div', { className: 'dshskill-search dshskill-popSearch' },
              h(IconSearch, { className: 'dshskill-searchIcon' }),
              h('input', {
                ref: searchRef,
                type: 'search',
                value: query,
                placeholder: t('invoke.search'),
                'aria-label': t('invoke.search'),
                onChange: (event) => {
                  setQuery(event.target.value)
                  setInsertError('')
                },
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return
                  if (event.nativeEvent !== undefined && event.nativeEvent.isComposing === true) return
                  event.preventDefault()
                  const first = filtered[0]
                  if (first !== undefined) invoke(first)
                },
              }),
            ),
            fetching
              ? h('div', { className: 'dshskill-popStatus' }, h(Spinner), h('span', null, t('invoke.loading')))
              : (loadError !== ''
                ? h('div', { className: 'dshskill-popError', role: 'alert' },
                  h('span', { className: 'dshskill-popErrorText' }, t('invoke.error', { message: loadError })),
                  h('button', {
                    type: 'button',
                    className: 'dshskill-btn dshskill-btnGhost dshskill-btnSm',
                    disabled: fetching,
                    onClick: () => { void loadSkills() },
                  }, t('common.retry')),
                )
                : (data === null
                  ? null
                  : (options.length === 0
                    ? h('p', { className: 'dshskill-popEmpty' }, t('invoke.empty'))
                    : (filtered.length === 0
                      ? h('p', { className: 'dshskill-popEmpty' }, t('invoke.searchEmpty', { query: query.trim() }))
                      : h('div', { className: 'dshskill-popList', role: 'group', 'aria-label': t('invoke.title') },
                        filtered.map(skill => h('button', {
                          key: skill.name + '|' + skill.sourceId,
                          type: 'button',
                          className: 'dshskill-invokeRow',
                          title: skill.name,
                          onClick: () => { invoke(skill) },
                        },
                          h(EcosystemGlyph, {
                            ecosystem: skill.ecosystem,
                            label: t(ecosystemKey(skill.ecosystem)),
                          }),
                          h('span', { className: 'dshskill-invokeText' },
                            h('span', { className: 'dshskill-invokeTitleLine' },
                              h('span', { className: 'dshskill-invokeName', title: skill.name }, skill.name),
                              skill.modelInvocable ? null : h('span', { className: 'dshskill-invokeUserOnly' }, t('invoke.userOnly')),
                            ),
                            skill.description === '' ? null : h('span', { className: 'dshskill-invokeDesc' }, skill.description),
                          ),
                          h('span', { className: 'dshskill-invokePlus', 'aria-hidden': 'true' }, h(IconPlus, null)),
                        )),
                      ))))),
            insertError === ''
              ? null
              : h('div', { className: 'dshskill-popError', role: 'alert' },
                h('span', { className: 'dshskill-popErrorText' }, insertError),
              ),
            h('div', { className: 'dshskill-popFooter' },
              h(IconSpark, { className: 'dshskill-popSpark' }),
              h('span', { className: 'dshskill-popHint' }, t('invoke.hint')),
              h('kbd', { className: 'dshskill-kbd', title: t('invoke.enterHint') }, 'Enter'),
            ),
          )
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Plugin registration
     * ------------------------------------------------------------------ */

    /**
     * Mount both browser faces on the Client Context.
     * @param {Record<string, any>} ctx - client root context.
     */
    function apply(ctx) {
      runtime.ctx = ctx

      try {
        runtime.translate = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-skill: dictionaries')
      } catch (cause) {
        runtime.translate = null
        try {
          if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('dsh-skill: locale registration failed: ' + messageOf(cause))
        } catch {
          // Logging is best-effort.
        }
      }

      const label = () => translate('nav')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'skills',
        order: SETTINGS_ORDER,
        label,
        locale: NS,
      }, SkillSettingsSection))

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'dsh-skill-invoke',
        order: INVOKE_ORDER,
        locale: NS,
      }, SkillInvokeButton))
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})

