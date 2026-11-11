# File Scout

Herdr 的 Files 面板增强版：Windows 上列目录从 ~1.4s 降到 ~80ms，并带右键菜单。

A drop-in Files panel for [Herdr](https://herdr.dev) with fast folder listing and a right-click menu.

## 为什么 / Why

官方 Files mod 在 Windows 本机用 `powershell -NoProfile -Command Get-ChildItem` 列每个目录，
一次约 1.3–1.5 秒；每 10 秒的全量刷新还会把已展开的目录再跑一遍。
filescout 改用 `node` 的 `readdirSync`（约 80ms），node 不在 PATH 时自动退回 PowerShell。

The shipped mod starts PowerShell for every folder it lists (~1.4s each on Windows).
filescout lists with node (~80ms) and falls back to the same PowerShell call when node is missing.

## 功能 / Features

- 惰性文件树、文本预览
- git 状态染色（Zed 风格）：修改=黄、新增=绿、删除=红、冲突=紫；文件名和目录名都上色，目录取子树里最严重的状态
- 标题栏显示 `N 个改动` 与 `+新增 / -删除` 行数
- Markdown 渲染预览（`.md` / `.markdown`），标题栏可在「源码 / 预览」之间切换
- 标题栏 ⤢ 把面板放大成浮窗，带上当前正在预览的文件
- 预览不出来（二进制、过大、读不了）时直接给一个**用默认程序打开**按钮，不用再回右键菜单
- 右键文件或目录：
  - **用默认程序打开** / **在文件管理器中打开**（Open with default app / Open in file manager）
  - **复制相对路径**（Copy relative path）
  - **复制绝对路径**（Copy absolute path）
  - **把相对路径插入 agent** —— 以 `@相对路径` 粘贴到当前标签页 agent 的输入行，不回车
  - **把绝对路径插入 agent**
  - **查看 diff**（有变更的文件才有）—— 浮窗里看可视化 diff，单栏/分栏可切换
- 菜单支持 ↑/↓、Enter、Esc
- VSCode 风格的文件类型图标（Material Icon Theme，MIT）


## 语言 / Language

界面文案默认中文。英文在**布局**里给这个 mod 加 `props.lang`，不用改代码。

### 示例：英文面板

`~/.config/herdr-app/layouts/<你的布局>.json` 里，原来是这样：

```json
{
  "id": "files",
  "type": "block",
  "content": { "mod": "filescout" }
}
```

加一行 `props` 就变成英文：

```json
{
  "id": "files",
  "type": "block",
  "content": {
    "mod": "filescout",
    "props": { "lang": "en" }
  }
}
```

### 取值

| `props.lang` | 界面 |
| --- | --- |
| 不写 | 中文（默认） |
| `"zh"` | 中文 |
| `"en"` | English |
| 其他值 | 中文 |

只影响这个面板自己的文案；放大浮窗、View diff 浮窗、右键菜单会继承当前语言，不会半中半英。
改完保存布局即可，mod 会重新加载。

## 安装 / Install

```sh
cp -r filescout ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/filescout
```

然后在布局里把 `"mod": "files"` 换成 `"mod": "filescout"`。**不要直接改官方 `main.json`**
（下次启动会被移到 `main-edited`），先克隆一份：

```sh
herdr-app do layout.clone '{"name":"main","as":"main-plus"}'
# 编辑 ~/.config/herdr-app/layouts/main-plus.json，把 files 换成 filescout
```

## 它会运行什么 / What it runs

| 场景 | 命令 |
| --- | --- |
| Windows 列目录 | `node -e "…readdirSync…"`；失败时 `powershell -NoProfile -Command Get-ChildItem` |
| macOS / Linux / 远程列目录 | `sh -c "…"` |
| git 标记 | `git rev-parse --show-toplevel`、`git status --porcelain=v1 -z` |
| 打开文件/目录 | Windows `cmd /c start`，macOS `open`，Linux `xdg-open` |
| 插入 agent | `herdr-app` 命令 `pane.focus` + `terminal.paste`（写系统剪贴板） |

## 限制 / Limits

- 每个目录最多 500 项，总计 5000 项（与官方一致）
- 展开后每 10 秒会重载所有已展开目录（官方行为，未改）
- 绝对路径在 Windows 上是 `@E:\...`，部分 CLI 不把它当文件引用，相对路径更稳

## 来源 / Credits

基于 Herdr 官方 `defaults/mods/files`（Apache-2.0）修改。图标来自 [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)（MIT）。
