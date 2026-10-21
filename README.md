# dsh-skill — DeepSeek Harness 可视化 Skill 库

一个 DeepSeek Harness（DSH）Web 插件 bundle，把 **Claude Code / Codex 生态的 Agent Skill**
（`SKILL.md` 目录，例如 [superpowers](https://github.com/obra/superpowers)）变成 DSH 会话中
可管理的技能，并提供：

- **可视化技能库管理页**（设置 → 技能）：自动发现、按来源展示、导入/新建/删除、逐项启用停用、
  查看说明与诊断。
- **类 Claude Desktop 的显式调用**（输入框工具条的「技能」按钮）：选择某个技能后，自动把
  `/技能名 ` 插入当前草稿；DSH 内置 skill 机制会在该条消息中**强制加载**该技能全文，
  不依赖模型对 description 的概率性匹配（也支持 `user-invocable` 的“仅用户调用”技能）。
- **生态兼容层**：把 Claude Code 的工具名、`$ARGUMENTS`、`${CLAUDE_PLUGIN_ROOT}` 等约定转换为
  DSH 可用的形式，并保留技能目录作为资源基址（脚本、参考文件可继续按相对路径读取）。

> 内置 DSH 技能（`~/.dsh/skills`、`~/.agents/skills`、项目内 `.dsh/skills`、bundled skills）
> 仍由 DSH 原生 skill 机制提供，本插件只管理“外部生态技能库”，因此二者可以同时工作、互不覆盖。

## 功能

### 自动发现的技能来源

| 生态 | 自动发现位置 |
|---|---|
| Claude Code 用户技能 | `$CLAUDE_CONFIG_DIR`/`~/.claude/skills` |
| Claude Code 项目技能 | `<项目根>/.claude/skills` |
| Claude Code 插件技能（如 superpowers） | `~/.claude/plugins/**/skills/*/SKILL.md`（含 marketplaces/cache） |
| Claude Desktop 技能 | `~/Documents/Claude/Skills`、`~/Library/Application Support/Claude/skills`、`~/.config/Claude/skills`、`%APPDATA%/Claude/skills` |
| Codex 技能 | `$CODEX_HOME`/`~/.codex/skills` |
| Codex 项目技能 | `<项目根>/.codex/skills` |
| Codex 插件技能 | `~/.codex/plugins/**/skills/*/SKILL.md` |
| Codex 自定义提示词 | `~/.codex/prompts/*.md`（转换为可调用的技能） |
| Agent Skills 通用目录 | `~/.agents/skills`、`<项目根>/.agents/skills` |
| 托管技能库 | `$DSH_HOME/dsh-skill/skills`（本插件写入的唯一位置） |

项目级来源只在该会话拥有工作目录时参与发现；设置页也支持手动 “添加来源目录” 指向任意技能目录。

### 管理页（设置 → 技能）

- 顶部 “添加技能” 菜单：**从文件夹导入** / **添加来源目录** / **新建技能**。文件夹选择使用插件内置的
  浏览器式目录选择弹窗（面包屑 + 路径跳转 + 隐藏目录开关），因此在只提供 `browse` 目录能力的纯 Web
  profile 中也可用；桌面等具备原生选择器的组合会退回系统目录选择框。
- 自动检测到的来源一键启用；来源可整体启停、删除（手动添加的）。
- 技能列表支持搜索、全局启用开关、生态徽章、展开详情（路径、whenToUse、metadata、诊断）、
  查看模型实际看到的指令、删除导入项。
- 失败与解析诊断直接展示，不静默吞掉坏技能。

### Agent 工具 `skill_library`

模型也可以管理和查询技能库（与设置页调用同一套 Host 服务方法）：`list` / `add_source` /
`import_skill` / `create_skill` / `set_enabled` / `set_source_enabled` / `remove_source` /
`remove_skill` / `rescan`。适合“帮我接入 ~/.claude/plugins 里的 superpowers 技能”这类请求。

### 显式调用技能（输入框工具条，类 Claude Desktop 的「+」）

DSH 默认是**全局可用 + 按 description 自动路由**：已启用技能都进入技能目录，模型按需自动调用。
这与 Claude Desktop 的默认行为一致，但自动路由是概率性的。需要**确定性触发**时：

- 点输入框左侧的 **「技能」** 按钮 → 搜索/选择技能 → 自动在草稿光标处插入 `/技能名 `；
- 发送后，DSH 内置 skill 机制在本轮把该技能正文作为 instructions 注入，模型必然按该技能执行；
- 该方式对 `user-invocable` 的“仅用户调用”技能同样有效（这类技能不会被模型自动目录推荐）；
- 插入的 `/技能名` 是普通文本，可手动删除；也可直接手输 `/技能名`，与内置 `/` 菜单等价。

> 说明：v1 曾提供“按会话勾选可用技能集合”。该功能已移除——技能可用性统一由管理页的全局开关
> 控制，会话内的确定性控制改由上述显式调用完成。旧的 `sessions` 状态字段会在升级后自动丢弃。

## 技能保存在哪里（全局 / 项目级）

**手动添加、导入、新建的技能都只写“全局（用户级）托管库”**，不区分项目：

| 操作 | 文件动作 | 保存位置 | 作用范围 |
|---|---|---|---|
| 新建技能 | 写入 `SKILL.md` | `$DSH_HOME/dsh-skill/skills/<name>/SKILL.md` | 全局（所有会话） |
| 从文件夹导入 | 复制整个技能目录（+ 生态来源侧车 `.dsh-skill-origin.json`） | `$DSH_HOME/dsh-skill/skills/<name>/` | 全局 |
| 添加来源目录 | 不复制，只登记路径 | `$DSH_HOME/dsh-skill/state.json` 的 `sources` | 全局配置；技能文件留在原地只读扫描 |

`$DSH_HOME` 默认是 `~/.dsh`，即实际路径通常为：

```
~/.dsh/dsh-skill/
├── state.json          # 来源登记、自动来源启停、全局停用技能名
└── skills/             # 托管库（唯一由插件写入技能文件的位置）
    └── <skill-name>/
        ├── SKILL.md
        └── .dsh-skill-origin.json   # 导入时记录的生态来源（可选）
```

**项目级技能** 目前只支持“自动发现（只读）”，插件不会往项目目录写文件：

- 自动发现：`<项目根>/.claude/skills`、`<项目根>/.codex/skills`；
- 项目根 = 会话工作目录向上最近的含 `.git` 目录（否则 cwd 本身）；
- 仅在该会话有工作目录时参与发现：模型技能目录、输入框「技能」弹层可见；设置页（无会话上下文）只列用户级来源；
- 想让技能随项目走/进 git：直接把技能目录放进 `<项目>/.claude/skills/<name>/`（或 `.codex/skills/`）即可，插件自动发现，可在 UI 里按来源整体启停，但不能在 UI 中编辑/删除项目文件；
- 启停开关按来源 id（`claude-project` / `codex-project`）全局生效，不是每个项目单独配置。

另外，`~/.dsh/skills`、`~/.agents/skills`、`<项目>/.dsh/skills`、`<项目>/.agents/skills` 由 DSH 原生
skill 机制加载，本插件不接管（页面中不显示），但这些技能仍会在会话中可用。

同名技能优先级：托管库 > 自定义来源 > 项目来源 > 用户来源；被覆盖的副本在管理页标记为 shadowed。

## 安装

在本仓库目录执行（或通过 Web UI 的 Plugins 页面安装该目录）：

```bash
dsh plugin install /home/zhaodan/work/NodeJsProjects/dsh-skill
```

安装后行为：
- Host 半：技能库服务 + 全局 `ctx.skills` provider + `/api/dsh-skill/*` 路由。
- Web 半：`client.js` 由模块系统热挂载；已打开的页面会跟随 Host 图更新加载，
  必要时刷新一次页面。

无需修改 agent preset 或 profile 的 `cordis.patch.yml`：provider 注册在全局 registry 层，
所有现存/新建会话立即看到已启用的技能。

## 使用

1. 打开 **设置 → 技能**，确认自动发现的来源（例如 `~/.claude/plugins/.../superpowers`），按需启用/停用。
2. 平时直接对话即可：已启用技能进入模型技能目录，模型按 description 自动调用。
3. 需要强制使用某个技能时，点输入框左侧 **「技能」** 按钮选择它（或手输 `/技能名`），
   该条消息会加载该技能全文；这适合关键流程、规范类技能，以及“仅用户调用”的技能。
4. 管理页的全局开关决定“默认可用集合”；显式调用只影响当前这条消息，不改全局状态。

## 生态兼容性说明

- 支持 **Agent Skills 开放标准**：目录 + `SKILL.md` + YAML frontmatter（`name`、`description`、
  `metadata`），可附带 `scripts/`、`references/`、`assets/` 等资源；这些资源通过
  `resourceBase` 以技能目录为基址暴露给模型。
- 宽松解析 Claude Code 的扩展字段：`when_to_use`/`whenToUse`、`disable-model-invocation`、
  `user-invocable`、旧式 `disableModelInvocation`/`modelInvocable`/`userInvocable`、
  `allowed-tools`、`argument-hint` 等；缺失 `name` 时回退目录名，非法名字自动 kebab-case 化并记录诊断。
- 加载 Claude 技能时自动附加兼容说明：Claude 工具名 → DSH 工具名映射（Bash→bash、Read→read、
  Edit→edit、Write→write、Glob→glob、Grep→grep、WebFetch→web_fetch、WebSearch→web_search、
  Task→subagent、TodoWrite→todo_write、AskUserQuestion→ask_user_question、ExitPlanMode→exit_plan_mode、
  Skill→skill），`$ARGUMENTS`/`$1..$9`、`${CLAUDE_PLUGIN_ROOT}` 替换为真实插件根目录。
- Codex 自定义提示词（`~/.codex/prompts/*.md`）作为技能提供，并附带 `$ARGUMENTS` 等替换说明。

**已知限制**

- 只兼容技能（skills）；Claude Code 的 commands / hooks / agents / MCP 声明不会安装。
- `allowed-tools` 仅作为元数据展示，不据此限制 DSH 工具（DSH 的权限体系在会话层生效）。
- 未导入到托管库的来源以只读方式扫描；来源目录被删除后技能随之消失。
- 若两个来源含同名技能，按“托管库 > 自定义来源 > 项目来源 > 用户来源”的优先级取一个，其余在
  管理页标记为 shadowed。

## 架构

```
lib/state.js       状态文件、路径与错误模型
lib/skillfiles.js  托管库的导入/新建/删除（唯一写文件位置）
lib/frontmatter.js 无依赖 YAML 子集 frontmatter 解析 + 跨生态规范化
lib/discovery.js   Claude/Codex/DSH 生态来源发现与有界递归扫描
lib/compat.js      Claude/Codex 兼容前言与占位符替换
lib/library.js     扫描缓存、去重、全局启用、变更通知
lib/provider.js    全局 ctx.skills provider（可用性）
lib/tools.js       面向模型的 skill_library 管理工具
lib/api.js         /api/dsh-skill/{state,action,skill}（认证 fence 内）
index.js           Host 插件入口（注册全局 provider、工具与路由）
client.js          浏览器半：设置页 + 技能显式调用按钮（React，无构建步骤）
```

状态文件：`$DSH_HOME/dsh-skill/state.json`；托管技能：`$DSH_HOME/dsh-skill/skills/<name>/SKILL.md`。

## 本次实测结果

在安装该插件的工作机上（profile `web`，2026-10-20）：

- 自动发现 **52 个外部生态技能**（Claude Code 用户技能 + Claude 插件缓存/marketplace，含
  `claude-plugins:superpowers` 15 个）；按用户当前配置 **17 个已启用**，全局 provider 让所有会话
  立即看到这 17 个技能，已启用/停用变更会触发内置 `skill` 工具发布替换技能目录。
- 显式调用链路：`conversation.input.left` 槽位的 **`dsh-skill-invoke`**（order 40）在运行中的页面
  热加载成功（Settings 页 `skills` order 25 同时在线）；点击技能行会把 `/技能名 ` 插入草稿，
  由 DSH 内置 skill 机制在本轮注入技能全文。
- 旧「按会话选择」机制已移除：`setSessionSelection` action / 会话过滤 provider 均删除；旧
  `state.json` 的 `sessions` 字段在升级后读取时忽略、下一次保存时丢弃（实测状态文件从
  `version:1 + sessions` 迁移为 `version:2`，用户原有来源启停配置保留）。
- 端到端复核：创建临时托管技能 → 技能目录立即刷新 → 内置 `skill` 工具经全局 provider 成功加载
  → 删除后目录恢复；`/api/dsh-skill/*` 三条路由仍在认证 fence 内（未认证 401）。
- 仓库自带 **64 个 Host 单测/集成测试全部通过**；浏览器半 jsdom+React 18 测试台 **80 条断言全部通过**
  （过滤规则、搜索、插入 token/span、插入失败提示、缺少 inputActions 降级、API 错误重试、en/zh 149/149 对等）。

> 说明：本环境没有浏览器自动化能力，页面视觉效果（主题、排版、弹层位置）未做截图级验证；
> 槽位注册与客户端 bundle 热加载已在运行页面内核确认。

## 设置导航图标（宿主侧小改动）

DSH 设置面板左侧每个 section 的图标由宿主 `ui-settings-general` 的
`SettingsRoot.tsx#navIcon(id)` **按 id 硬编码**映射；插件通过 `settings.section` 注册时只能提供
`id/order/label`，没有图标字段，所以 `skills` 之前落到默认齿轮图标（与设置按钮相同）。
本仓库附带一个最小宿主补丁，把 `skills` 映射到宿主已有的 `IconSkillOutlineMedium`（文档+星芒）：

```bash
cd /home/zhaodan/work/NodeJsProjects/deepseek-harness
git apply /home/zhaodan/work/NodeJsProjects/dsh-skill/host-patches/0001-settings-nav-skill-icon.patch
pnpm --filter @deepseek-ai/dsh-client-ui-settings-general run bundle
# 宿主 HMR 会 stat-poll 该 client bundle 并自动刷新页面；必要时手动刷新
```

补丁文件：[host-patches/0001-settings-nav-skill-icon.patch](host-patches/0001-settings-nav-skill-icon.patch)。
升级 DSH checkout 后如该补丁丢失，重新 apply + bundle 即可恢复导航图标（插件功能本身不受影响）。

## 开发

```bash
cd /home/zhaodan/work/NodeJsProjects/dsh-skill
node --check index.js client.js lib/*.js
node --test test/          # 64 个测试（frontmatter/discovery/library/state/import）
```

安装方式为 `link:` 到当前 profile。改完 Host/Client 代码后让运行中的 profile 重新加载一次即可
（无需重启进程）：

在 Web 的 **Settings → Plugins** 里对 `@local/dsh-skill` 关闭再开启一次（插件管理器会做
recomposition 并按新文件重新加载），或让插件管理器工具执行 `set_bundle` 的 disable/enable。

客户端 bundle 由 Web 模块系统热更新；若页面没有出现新的 Skills 控件，刷新一次页面。

实现提示：provider 是全局的（`ctx.skills.registerProvider`），技能可用性对所有会话一致；
显式调用由 Web 端把 `/技能名 ` 插入草稿，Host 不自行向会话注入内容，保持会话日志只由内置
skill 机制写入。

`CONTRACT.md` 描述了内部模块接口、状态文件模式与 HTTP API，浏览器半与 Host 半据此解耦。

## 卸载

```bash
dsh plugin remove @local/dsh-skill
```

卸载不会删除 `$DSH_HOME/dsh-skill/`（状态与导入的技能保留，重新安装即可继续使用）。
