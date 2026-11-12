# filescout 新增功能方案

参考社区里的「files 类」Herdr mod，挑出值得补进 filescout 的功能。本文件只是方案，**不含代码改动**。

## 进度

| 项 | 状态 |
| --- | --- |
| F6 排序 / 隐藏文件 / 面包屑 / tooltip | 已做 |
| F2 只看改动 | 已做 |
| F1 搜索框（即时过滤 + 回车全量搜索） | 已做 |
| F4 定位 / 编辑器打开（二级菜单）/ 在这里开终端 | 已做 |
| F5 预览跟随磁盘 | 已做（本机） |
| F3 图片预览 | 已做（本机，需 node） |
| 视图开关从标题栏挪到独立**工具栏** | 已做 |
| 浮窗 Esc 关闭 | 已做 |
| F7 发送到 agent（带指令） | 不做（用户确认不需要） |
| F8 新建文件 / 文件夹 / 重命名 | 不做（用户确认不需要） |


## 一、竞品对照

| Mod | 作者 | 值得借鉴的点 |
| --- | --- | --- |
| [Better Files](https://github.com/munza/herdr-mods/tree/main/better-files) | munza | 改动行内 diff（绿新增/黄修改/红线删除，点击就地展开旧行）、图片预览（走 cache 拷贝）、Markdown 渲染 + 单行本地图片、**Open in 编辑器**（Zed/VS Code/Cursor/…）、**Send to agent**（带指令）、`gutter` 开关回退官方编辑器 |
| [Files Plus](https://github.com/linziyanleo/herdr-mods/tree/main/files-plus) | linziyanleo | 多根工作区、**文件名/路径搜索**（全根、空格分词）、**右键文件管理**（新建文件/文件夹、重命名、复制粘贴、回收站）、`@` **拖拽到终端**、打开到 Tab/Pane/右侧面板、虚拟化树 + watchFolder 增量刷新 |
| [Preview Plus](https://github.com/linziyanleo/herdr-mods/tree/main/preview-plus) | linziyanleo | 本地文本**编辑**（Save/草稿/外部改动冲突）、Markdown **目录 + Mermaid**、**JSON 树 / CSV·TSV 表格**浏览、**图片/PDF 预览**（缩放/平移/翻页）、相对链接跳转 + 历史回退 |
| file-icons / File Icons（cybertron288、LaiqianDS、amster93） | — | 更全的图标主题 |
| [Open with](https://herdr.dev/mods)（jlopezlira）、Path menu（Lakris2407）、Open in VS Code（CacaoRick） | — | 用指定程序/编辑器打开、终端右键打开所在文件 |

**filescout 已有**：惰性树、文本预览 + 语法高亮、git 状态染色（名字/目录）、`N 个改动` 与 `+/-` 行数、Markdown 渲染与源码切换、放大浮窗、预览失败时的「用默认程序打开」、右键菜单（打开 / 复制相对·绝对路径 / 插入 `@` 到 agent / 查看 diff）、diff 浮窗（单栏·分栏）、Material 图标、中英文案。

**结论**：不追 Preview Plus 的编辑器/PDF/Mermaid 那种大工程；优先补「搜索、只看改动、图片预览、定位/编辑器/终端、预览跟随、排序与路径细节」，再加一个克制的文件管理子集（不做删除，见 §8）。

---

## 二、现状锚点（`main.js`）

| 位置 | 行 | 作用 |
| --- | --- | --- |
| `location()/key()/ctxKey()` | 11–17 / 212–218 | 面板上下文（cwd、远程机器、space）与定位键 |
| `directory(path, on, lang)` | 135–164 | 列目录：Windows 走 node，兜底 PowerShell；远程/Unix 走 `sh` |
| `refresh(cx)` | 229–278 | 拉目录 + `git status`/`numstat` → `marks`、`dirty`(rollup)、`stat` |
| `loadFolder` / `toggle` | 220–227 / 280–299 | 惰性加载、展开/折叠 |
| `rows()` | 445–461 | 递归画树（缩进、图标、git 上色） |
| `show(path, cx)` | 301–320 | 预览：`readTextFile` → 二进制拦截 → `EditorState` |
| `showDiff` / `diffView` | 395–412 / 323–392 | diff 浮窗（`git diff HEAD`，未跟踪整份算新增） |
| `rowMenu` / `menuItems` / `renderMenu` | 432–443 / 473–483 / 545–579 | 右键菜单（**popup 高度写死 190/221**） |
| 表头 `render()` | 598–613 | 标题、改动数、`+/-`、分栏切换、md 切换、放大/关闭 |
| `expand()` | 424–430 | 放大成浮窗 |
| `iconOf/iconEl` | 110–127 | Material 图标 |
| `I18N` | 42–73 | zh/en 文案 |
| `openPath` / `insertPath` | 497–538 | 默认程序打开 / 剪贴板 + `pane.focus` + `terminal.paste` 插入 `@` |

关键 API（来自 `herdr.d.ts` / `gpui-kit.d.ts`）：
- `exec(cmd, args, { cwd, on })`、`readTextFile`、`writeTextFile(path, text, expected)`、`watchFolder(dir)`、`pickFolder()`
- `run(name, args)`：`tab.new {folder, argv?}`、`terminal.open {folder, place}`、`pane.focus`、`terminal.paste`、`layout.select`
- `notify{...}`、`openOverlay/closeOverlay`、`props()`、`theme()`、`settings()`
- UI：`Input/InputState`（`InputState.new({placeholder,value})`、`.value()`、`.set_value()`、`.focus()`、`.on("change"|"submit")`）、`tooltip(text)`、`on_drop({paths})`、`image(path)` / `svg(path)`（**只读应用自己目录**，即 mod 文件夹内）

---

## 三、功能方案

### F1. 文件名过滤框（搜索）

**目标**：面板顶部能按名字快速过滤文件；回车做全递归搜索。

- 表头下加一条 30px 输入条（`Input.new(InputState.new({placeholder}))`），id `filescout-search`。
- **即时过滤（默认）**：对**已加载**的 `this.entries` 做内存过滤，零 exec 成本。
  - `this.filter` 存当前词；`rows()` 增加「子树是否有命中」判定：先递归算每个目录的命中集（Map<dir, count>），不命中的目录整枝隐藏，命中目录不论是否展开都显示其命中子项。
  - 过滤期间忽略 `this.folders` 的展开状态（用命中决定可见性），清空后恢复原展开状态。
- **全递归搜索（回车触发）**：
  - 有 git：`git ls-files --cached --others --exclude-standard`（天然排除忽略项，且快）。
  - 无 git：node 递归（复用 `directory()` 的 node 思路），跳过 `node_modules`、`.git`。
  - 空格分词，所有词都要出现在「相对路径」里（大小写不敏感、任意顺序）；取前 200 条。
  - 结果用 48px 两行行：basename + 相对路径，点击 `show(path)`。
- 交互：↑/↓ 选、Enter 打开、Esc 清空；输入框失焦不清空，切 space/machine 清空。
- **影响**：中。新增 state + 一个 render 分支 + 一个 exec（搜索）+ 复用 `rows()`。

### F2. 「只看改动」开关

**目标**：一键只显示有 git 改动的文件/目录，配合 agent 工作流。

- 表头加一个 chip（样式同现有分栏按钮），id `filescout-onlychanged`，`this.onlyChanged`。
- 打开时：`rows()` 只保留 `this.marks[path]`（文件）与 `this.dirty.get(path)`（目录），并把命中的目录自动展开。
- 与 F1 过滤可叠加（先按改动剪枝，再按名字过滤）。
- **前提**：`refresh()` 里的 `git status` 已按 `TOTAL` 截断，改动集合基本完整；若改动数 > TOTAL 需在标题栏提示。
- **影响**：小。

### F3. 图片预览

**目标**：点图片不再只显示「二进制文件」，而是画出图片。

- `image()` 只能读 mod 目录内文件 → 先把目标图拷进 `mods/filescout/cache/`。
- 拷贝：本机 Windows 用 node `fs.copyFileSync`（无 on 时）或 `sh -c 'cp'`；远程用 `sh -c 'cp'`。
  - 文件名 = `hash(绝对路径 + mtime + size)` + 原扩展名；同 key 已存在就跳过。
- 支持：png/jpg/jpeg/gif/webp/bmp/svg（`FILE_ICON` 里已按 `image`/`svg` 归类）。
- 渲染：`image(relCachePath).max_w_full().max_h_full()`；**待验证**：原生 image 的缩放/object-fit 行为（d.ts 无 `object_fit`），若不能等比适配则退化为按容器高度定 `size()`。
- 缓存清理：切换文件/上下文或 `close()` 时删旧 key（或达到阈值时清理）。
- 失败仍显示现有 `openButton`。
- **影响**：中。改 `show()` 的二进制分支；新增 cache 目录与拷贝逻辑。
- **注意**：`.gitignore` 增加 `cache/`。

### F4. 定位 / 编辑器打开 / 终端在此

**目标**：右键能「在资源管理器中定位」「用编辑器打开」「在此开终端」。

- **定位**（reveal & select）：
  - Windows `explorer /select,<abs>`；macOS `open -R <abs>`；Linux `xdg-open <dir>`。
  - 注意 Windows `explorer` 常返回非 0，忽略退出码。
  - 保留现有「在文件管理器中打开（打开整个目录）」作为另一项。
- **编辑器打开**：启动时探测一次并缓存（`where`/`which`）：`code`、`code-insiders`、`cursor`、`windsurf`、`zed`、`subl`、`idea`、`phpstorm`。
  - 文件：`code -g <abs>`；目录：`code <abs>`。菜单里每个已装编辑器一项。
- **终端在此**：目录项 `run("tab.new", { folder: absDir })`（或 `terminal.open {folder, place:"tab"}`）。
- 远程 `on` 非空时不显示本机编辑器/定位项（同 Better Files 取舍）；定位项对远程禁用。
- **影响**：中。集中在 `menuItems()` + 探测缓存；`insertPath`/`openPath` 已有先例。

### F5. 预览自动跟随改动

**目标**：预览的文件被 agent 改完后自动刷新，不用重新点。

- `show()` 成功后起一个跟随：`watchFolder(dir(root/path))` 循环（参考 `watch()` 199–209），或 2s `cx.timer` 比对 mtime/size。
- 文本变化才重建 `EditorState`（重建会丢滚动位置）——优先只在新旧文本不同时 `code.release()` 再 new；滚动位置保留暂不强求。
- 文件被删 → `fileError = L("gone")`。
- 只对**本机**做（远程 watchFolder 不适用 → 远程退回 10s 定时）。
- **影响**：中。改 `show()`；注意与根目录 `watch()` 不要重复。

### F6. 排序 / 隐藏文件 / 面包屑 / tooltip

**目标**：表格化细节补齐。

- **排序**：`this.sort = { key: "name", dir: 1 }`；表头加小按钮切名称升/降。目录始终优先。
  - 修改时间/大小需要 `directory()` 带出 `size`/`mtime`：node 版用 `statSync` 易加，`sh` 版麻烦 → **第一版只做名称升降序**，另两档列为后续。
- **隐藏文件开关**：`directory()` 目前已列出 dotfile（仅跳过 `.git`）→ 加 `this.showHidden`，`rows()` 里 `name.startsWith(".")` 时按开关过滤（`.git` 永远隐藏）。
- **面包屑**：表头右侧现在只显示 `file ?? root basename` → 改为可点击分段（`root / a / b / file`）：
  - 点目录段：把 `folders` 展开到该层并滚动/高亮；
  - 点文件段：`show(path)`；
  - 每段加 `tooltip(绝对路径)`。
- **tooltip**：树行 `.tooltip(绝对路径)`（截断名字/长路径可读全文）；表头文件名同样加。
- **影响**：小–中。集中在表头 + `rows()`。

### F7. 发送到 agent（带指令）

**目标**：右键「发送到 agent…」，先问要 agent 干什么，再把 `@路径 + 指令` 粘进终端（不回车）。

- 用一个小输入浮窗（复用 F8 的 dialog 分支，或独立 popup）收集指令。
- 发送 = 现有 `insertPath` 的机制：写剪贴板 → `pane.focus` → `terminal.paste`，内容为 `@<rel> <指令>`。
- 目标选择沿用 `insertPath` 的 `panes()` 过滤（当前 tab、优先有 status 的）。
- **影响**：中。依赖 F8 的输入弹窗。

### F8. 文件管理操作（新建 / 重命名，**不做删除**）

**目标**：右键能新建文件、新建文件夹、重命名。删除刻意不做（易误删，且属于编辑器职责）。

- 新增一个**输入对话框**分支：像现在 menu 那样，同一个 mod 用 `props.dialog` 打开（`openOverlay({mod:"filescout", kind:"dialog"|"popup", props:{dialog:{mode,root,path,on}}})`）。
  - `render()` 增加 `this.mode === "dialog"` 分支；`init` 里读 `props().dialog`。
- 操作与命令（统一优先 node，失败退回平台命令）：
  - 新建文件：`writeTextFile(abs, "", null)`（`expected=null` 只在不存在时创建）。
  - 新建文件夹：node `fs.mkdirSync` / Windows `cmd /c mkdir` / unix `mkdir`。
  - 重命名：node `fs.renameSync` / Windows `cmd /c ren` / unix `mv`。
- 校验：非空、不含路径分隔符、非 `.`/`..`、无控制字符、目标不存在（重命名还要防与原目录冲突，禁止重命名 workspace 根）。
- 成功后 `refresh()` 并展开/选中目标。
- **影响**：中大。新增 dialog 分支 + 写操作（**写操作是主要风险点，需二次确认文案**）。

---

## 四、实施顺序

1. **只读、低风险先做**（集中在 `rows()` / 表头）：
   F6 排序(名称)+隐藏文件开关+tooltip → F2 只看改动 → F1 过滤框(内存过滤) → F1 全递归搜索。
2. **预览增强**（集中在 `show()`）：F3 图片预览 → F5 预览跟随。
3. **菜单扩展**（集中在 `menuItems()`）：F4 定位/编辑器/终端。
4. **输入弹窗**：F8 输入对话框骨架 → F7 发送到 agent → F8 新建/重命名。

每步都能独立上线；1–3 步不改写操作，风险最低。

## 五、通用注意

- **i18n**：所有新文案（含 placeholder、tooltip、按钮）同时补 `I18N.zh` 与 `I18N.en`（42–73）。
- **右键菜单高度**：`rowMenu` 的 popup `height` 是写死的 `190/221`，菜单项变多需改成按 `menuItems().length` 计算；`renderMenu` 已按 `list.length` 渲染。
- **跨平台 / 远程**：`on` 非空时能力受限（无本机编辑器/定位、node 可能没有）——每条功能都要给出远程降级行为。
- **性能**：现有每 10s 全量刷新 + watchFolder；新增的搜索/跟随要避免叠加 exec 风暴（搜索手动触发；跟随用目录 watch 而非全量）。
- **写操作**：F8 涉及真实文件系统写入，需确认弹窗 + 失败提示（`notify({level:"error"})`）。
- **验证**：改完按 `AGENTS.md` 的流程 —— 先改 `~/.config/herdr-app/mods/filescout/` 看效果，`herdr-app check`、`herdr-app status`，确认后再拷回仓库。
