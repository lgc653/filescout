// filescout — Herdr 的 Files 面板增强版。
// 速度：Windows 本机列目录走 node（约 80ms），PowerShell 仅作兜底（约 1.4s）。
// 菜单：默认应用打开、复制相对/绝对路径、把 @路径 插入 agent 的输入行。
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Input, InputState } from "gpui-base";
import {
  spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, appHome,
  props, openOverlay, closeOverlay, run, notify,
} from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
// Zed 风格：按 git 状态给名字上色（文件和目录都算，目录取子树里最严重的那个）。
const MARK_COLOR = { M: "ansi3", A: "ansi2", D: "ansi1", U: "ansi5" };
const MARK_RANK = { M: 1, A: 2, D: 3, U: 4 };
const markColor = (mark, t) => t[MARK_COLOR[mark]];
/** Herdr 的 cwd 在 Windows 上用反斜杠，git 给的是正斜杠：统一成一把尺子再比。 */
const slashed = (p) => (platform() === "windows" ? p.replace(/\\/g, "/") : p);

/** 把文件状态卷到每一层父目录：<相对目录, 最严重状态>。 */
function rollup(marks) {
  const dirs = new Map();
  for (const [rel, status] of Object.entries(marks)) {
    for (let i = rel.lastIndexOf("/"); i > 0; i = rel.lastIndexOf("/", i - 1)) {
      const dir = rel.slice(0, i), was = dirs.get(dir);
      if (!was || MARK_RANK[status] > MARK_RANK[was]) dirs.set(dir, status);
    }
  }
  return dirs;
}

const platform = () => window()?.platform ?? "linux";

// 能当图片预览的扩展名。拷贝放在 appHome 下的 filescout-cache/，不能放 mod 目录里：
// herdr 会盯着 mod 目录，往里写文件会触发 mod 重载，面板状态被重置（看起来像「闪一下回到列表」）。
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);

// 界面文案：布局里给这个 mod 的 props 加 {"lang":"en"} 切英文，默认中文。
const I18N = {
  zh: {
    files: n => `${n} 个改动`, split: "分栏", merge: "合并", preview: "预览", source: "源码",
    hideFiles: "隐藏", showFiles: "显示",
    onlyChanged: "只看改动", showAll: "显示全部",
    sortTip: "按名称排序，点击切换升序 / 降序", hideTip: "显示或隐藏以点开头的文件",
    onlyChangedTip: "只列出有 git 改动的文件和目录",
    splitTip: "单栏 / 分栏看 diff", mdTip: "渲染后的预览 / 看源码",
    search: "搜索文件名，回车搜全部", clearSearch: "清空搜索",
    searching: "正在搜索…", noResults: "没有匹配的文件",
    openFolder: "在文件管理器中打开", openApp: "用默认程序打开",
    reveal: "在文件管理器中定位", openIn: n => `用 ${n} 打开`, openWith: "用编辑器打开", termHere: "在这里开终端",
    copyRel: "复制相对路径", copyAbs: "复制绝对路径",
    insertRel: "把相对路径插入 agent", insertAbs: "把绝对路径插入 agent",
    diff: "查看 diff",
    noFiles: "没有文件", noFolder: "没有目录", loadingFiles: "正在读取…", loadingFile: "正在读取文件…", loadingDiff: "正在读取 diff…",
    limited: "每个目录最多 500 项，总计 5000 项",
    gone: "这个文件已经不在了", binary: "二进制文件，不预览", previewErr: "无法预览（二进制、过大或读不了）",
    noDiff: "没有可显示的改动", diffErr: "读不到 diff",
    openErr: p => `打不开 ${p}`, copied: w => `已复制${w}`, inserted: w => `已插入${w}`,
    relPath: "相对路径", absPath: "绝对路径", noAgent: "当前标签页里没有 agent 面板",
  },
  en: {
    files: n => `${n} files`, split: "Split", merge: "Unified", preview: "Preview", source: "Source",
    hideFiles: "Hide", showFiles: "Show",
    onlyChanged: "Changed", showAll: "Show all",
    sortTip: "Sort by name — click to switch between A→Z and Z→A", hideTip: "Show or hide dot-files",
    onlyChangedTip: "List only files and folders with Git changes",
    splitTip: "Unified or split diff view", mdTip: "Rendered preview or source",
    search: "Search file names, Enter searches all", clearSearch: "Clear search",
    searching: "Searching…", noResults: "No matching files",
    openFolder: "Open in file manager", openApp: "Open with default app",
    reveal: "Reveal in file manager", openIn: n => `Open in ${n}`, openWith: "Open with editor", termHere: "Open terminal here",
    copyRel: "Copy relative path", copyAbs: "Copy absolute path",
    insertRel: "Insert relative path into agent", insertAbs: "Insert absolute path into agent",
    diff: "View diff",
    noFiles: "No files", noFolder: "No folder", loadingFiles: "Loading files…", loadingFile: "Loading file…", loadingDiff: "Loading diff…",
    limited: "File list limited to 500 entries per folder and 5,000 total",
    gone: "This file is no longer available", binary: "Binary file · no text preview", previewErr: "Cannot preview this file (binary, too large, or unreadable)",
    noDiff: "No changes to show", diffErr: "Cannot read the diff",
    openErr: p => `Cannot open ${p}`, copied: w => `Copied ${w}`, inserted: w => `Inserted ${w}`,
    relPath: "relative path", absPath: "absolute path", noAgent: "No agent pane in this tab",
  },
};
const msg = (lang, key, ...args) => {
  const value = (I18N[lang] ?? I18N.zh)[key] ?? I18N.zh[key];
  return typeof value === "function" ? value(...args) : value;
};


// 放大/看 diff 的浮窗：不传 key，每次都由宿主居中打开；开新的先关旧的。
const opened = { big: null, diff: null };
const reopen = (slot, spec) => {
  if (opened[slot]) closeOverlay(opened[slot]);
  opened[slot] = openOverlay(spec);
};

const FILE_ICON = {
  ts: "typescript", tsx: "react", js: "javascript", jsx: "react", mjs: "javascript", cjs: "javascript",
  vue: "vue", svelte: "svelte", html: "html", htm: "html",
  css: "css", scss: "sass", sass: "sass", less: "less",
  json: "json", jsonc: "json", md: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  sh: "console", bash: "console", zsh: "console", ps1: "console", bat: "console", cmd: "console",
  sql: "database", db: "database", sqlite: "database",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", ico: "image", svg: "svg",
  pdf: "pdf", zip: "zip", gz: "zip", tgz: "zip", tar: "zip", rar: "zip", "7z": "zip",
  lock: "lock", txt: "document", log: "document",
  xlsx: "excel", xls: "excel", xlsm: "excel", csv: "excel",
  docx: "word", doc: "word", rtf: "word", odt: "word",
  pptx: "powerpoint", ppt: "powerpoint",
};

const NAME_ICON = {
  "package.json": "json", "tsconfig.json": "json", "jsconfig.json": "json",
  "package-lock.json": "lock", "pnpm-lock.yaml": "lock", "yarn.lock": "lock", "cargo.lock": "lock",
  ".gitignore": "git", ".gitattributes": "git", ".gitmodules": "git",
  dockerfile: "docker", "docker-compose.yml": "docker", "docker-compose.yaml": "docker",
  makefile: "makefile", license: "license", "license.md": "license", "readme.md": "markdown",
};

/** The row's icon: a Material file icon by name, else by extension, else null. */
function iconOf(name, isDir) {
  if (isDir) return "mods/filescout/icons/folder-base.svg";
  const lower = name.toLowerCase();
  const byName = NAME_ICON[lower];
  if (byName) return `mods/filescout/icons/${byName}.svg`;
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : lower;
  const icon = FILE_ICON[ext];
  return icon ? `mods/filescout/icons/${icon}.svg` : null;
}

/** 有专属图标的按原色画（Material 的配色在明暗主题下都够看）；没有的走掩码，颜色跟着主题前景色。 */
function iconEl(name, isDir, t) {
  const path = iconOf(name, isDir);
  return path
    ? image(path).size(14).flex_none()
    : svg("mods/filescout/file.svg").size(14).flex_none().text_color(t.muted);
}

/** The path as the user would type it: backslashes on Windows. */
function absolute(root, path) {
  const full = path ? `${root}/${path}` : root;
  return platform() === "windows" ? full.replace(/\//g, "\\") : full;
}

// 能打开文件的编辑器：启动后探测一次，结果给所有面板副本共用。
const EDITOR_BINS = [
  ["code", "VS Code"], ["code-insiders", "VS Code Insiders"], ["cursor", "Cursor"],
  ["windsurf", "Windsurf"], ["zed", "Zed"], ["subl", "Sublime Text"],
  ["idea", "IntelliJ IDEA"], ["phpstorm", "PhpStorm"],
];
async function detectEditors() {
  const found = [];
  for (const [bin, name] of EDITOR_BINS) {
    try {
      const r = await exec(platform() === "windows" ? "where" : "which", [bin]);
      if (r.code === 0) found.push([bin, name]);
    } catch { /* 没装 */ }
  }
  return found;
}

async function directory(path, on, lang) {
  const powershellDirectory = async () => {
    // Fallback when node is not on PATH: ~1.4s per folder on a typical Windows box.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || msg(lang, "listErr"));
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  const windowsDirectory = async () => {
    // node starts in ~80ms and its stdio is UTF-8; the shell costs ~1.4s a call.
    const script = "const fs=require('fs'),p=process.argv[1],out=[];try{for(const e of fs.readdirSync(p,{withFileTypes:true})){if(e.name==='.git')continue;let dir=e.isDirectory();if(!dir&&e.isSymbolicLink()){try{dir=fs.statSync(p+'/'+e.name).isDirectory()}catch{}}out.push([e.name,dir?1:0]);if(out.length>=501)break}}catch(err){process.stderr.write(String((err&&err.message)||err));process.exit(1)}process.stdout.write(JSON.stringify(out))";
    let r;
    try { r = await exec("node", ["-e", script, path], { on }); }
    catch { return powershellDirectory(); }
    if (r.code !== 0) return powershellDirectory();
    return JSON.parse(r.stdout || "[]").map(([name, dir]) => ({ name, dir: dir === 1 }));
  };
  if (!on && platform() === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || msg(lang, "listErr"));
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Filescout extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    const p = props() ?? {};
    this.lang = p.lang === "en" ? "en" : "zh";
    if (p.menu) {
      // The right-click menu is this same mod, opened as a popup overlay.
      this.mode = "menu";
      this.menu = p.menu;
      this.at = 0;
      this.handle.focus();
      return;
    }
    this.mode = "browser";
    // 名称升序；隐藏文件默认列出（与旧行为一致），表头可收起。
    this.sortDir = 1;
    this.showHidden = true;
    this.onlyChanged = false;
    // 工具栏里的搜索框：输入即时过滤已加载的树，回车搜整个目录。
    this.filter = "";
    this.results = null;
    this.search = InputState.new({ placeholder: this.L("search") });
    this.search.on("change", (_e, cx) => { this.filter = this.search.value(); this.results = null; cx.notify(); });
    this.search.on("submit", (_e, cx) => this.searchAll(cx));
    // Markdown 默认看渲染后的样子，可切回源码。
    this.mdView = true;
    // diff 默认单栏（面板窄），可切分栏。
    this.split = Boolean(p.wide);
    // 从别的实例点"放大"打开时，带走当前正在预览的文件。
    this.overlay = p.overlay ?? null;
    this.openedFile = p.file ?? null;
    this.diffFile = p.diff ?? null;
    // 浮窗（放大 / 看 diff）自己拿键盘，Esc 关掉它。
    if (this.overlay) this.handle.focus();
    // 编辑器只探测一次，所有面板副本共用同一份结果。
    if (!globalThis.__filescoutEditors) {
      const list = [];
      globalThis.__filescoutEditors = list;
      detectEditors().then(found => list.push(...found)).catch(() => {});
    }
    this.editors = globalThis.__filescoutEditors;
    this.fixed = p.root ? { cwd: p.root, on: p.on ?? null } : null;
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.dirty = new Map();
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  // ---------- browser ----------

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  /** 面板的定位键：浮窗固定在被放大时的目录，普通面板跟着焦点走。 */
  ctxKey() {
    return this.fixed ? `fixed:${this.fixed.cwd}` : key();
  }

  current(context) {
    return this.context === context && this.ctxKey() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on, this.lang);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, this.order(entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = this.fixed ?? location(), next = this.ctxKey();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.dirty = new Map(); this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
      if (this.openedFile) { this.show(this.openedFile, cx); this.openedFile = null; }
      if (this.diffFile) { this.showDiff(this.diffFile, cx); this.diffFile = null; }
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        let added = 0, removed = 0;
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) {
            // 键用相对面板目录的路径，省掉绝对路径的斜杠差异。
            const base = slashed(top.stdout.trim()) + "/", root = slashed(cwd) + "/";
            for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
              const full = base + entry.slice(3), xy = entry.slice(0, 2);
              if (!full.startsWith(root)) continue;
              marks[full.slice(root.length)] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
            }
          }
          const numstat = await exec("git", ["--no-optional-locks", "diff", "HEAD", "--numstat"], { cwd, on }).catch(() => null);
          if (numstat?.code === 0) for (const line of numstat.stdout.split("\n")) {
            const [plus, minus] = line.split("\t");
            if (/^\d+$/.test(plus)) added += Number(plus);
            if (/^\d+$/.test(minus)) removed += Number(minus);
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.dirty = rollup(marks); this.stat = { added, removed }; this.error = null; this.watch(cwd, cx);
        if (this.onlyChanged) this.ensureChangedFolders(cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.text = null; this.image = null; this.diff = false;
    this.watchedFile = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
    if (IMAGE_EXT.has(ext)) {
      cx.spawn(async cx => {
        try {
          const key = await this.cacheImage(`${root}/${path}`);
          if (this.file !== path || !this.current(context)) return;
          this.image = `filescout-cache/${key}`;
        } catch { if (this.file === path && this.current(context)) this.fileError = this.L("previewErr"); }
        finally { cx.notify(); }
      });
      return;
    }
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = this.L("gone"); return; }
        if (text.includes("\0")) { this.fileError = this.L("binary"); return; }
        this.setText(text, path);
        this.watchFile(cx);
      } catch { if (this.file === path && this.current(context)) this.fileError = this.L("previewErr"); }
      finally { cx.notify(); }
    });
  }

  /** 读到的文本画成只读编辑器；首次打开和磁盘刷新都走这里。 */
  setText(raw, path) {
    const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
    this.text = raw.length > 400000 ? raw.slice(0, 400000) + "\n… (file truncated)" : raw;
    this.code?.release();
    this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
      value: this.text,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  /** 盯住正在预览的文件，磁盘一改就重读（只在本机）。 */
  watchFile(cx) {
    const path = this.file;
    if (!path || this.on || this.watchedFile === path) return;
    this.watchedFile = path;
    const context = this.context, full = `${this.root}/${path}`, folder = full.slice(0, full.lastIndexOf("/"));
    cx.spawn(async cx => {
      try {
        while (this.file === path && this.context === context) {
          await watchFolder(folder);
          if (this.file !== path || this.context !== context) return;
          await this.reloadFile(cx);
        }
      } catch { if (this.watchedFile === path) this.watchedFile = null; }
    });
  }

  /** 重读当前文件：内容真变了才重建编辑器。 */
  async reloadFile(cx) {
    const path = this.file, context = this.context;
    if (!path) return;
    try {
      const text = await readTextFile(`${this.root}/${path}`, { on: this.on });
      if (this.file !== path || this.context !== context) return;
      if (text === null) { this.fileError = this.L("gone"); cx.notify(); return; }
      if (text.includes("\0")) return;
      const next = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
      if (next !== this.text) { this.setText(text, path); cx.notify(); }
    } catch { /* 读不到就先不动 */ }
  }

  /** 把图片拷进 appHome/filescout-cache/：image() 只能读应用目录里的文件，
   *  名字里带上 mtime 和大小，同一个文件只拷一次，改了就换一份新的。 */
  async cacheImage(src) {
    const dir = `${appHome()}/filescout-cache`.replace(/\\/g, "/");
    const script = "const fs=require('fs'),path=require('path'),crypto=require('crypto');const src=process.argv[1],dir=process.argv[2];const st=fs.statSync(src);const key=crypto.createHash('sha1').update(src+':'+st.mtimeMs+':'+st.size).digest('hex').slice(0,16)+path.extname(src);const dst=path.join(dir,key);fs.mkdirSync(dir,{recursive:true});if(!fs.existsSync(dst))fs.copyFileSync(src,dst);process.stdout.write(key)";
    const r = await exec("node", ["-e", script, src, dir], { on: this.on });
    if (r.code !== 0) throw new Error(r.stderr || "copy failed");
    return r.stdout.trim();
  }

  /** 把 unified diff 画成带底色和行号的表：合并（单栏）或分栏。 */
  diffView(t) {
    const mono = settings().font_family, rows = [], CAP = 3000;
    const lines = this.diffText.split("\n");
    const num = n => div().w(34).flex_none().text_right().pr(6).text_color(t.dim).child(n == null ? "" : String(n));
    const sign = (s, color) => div().w(14).flex_none().text_color(color).child(s);
    const line = (bg, children) => h_flex().w_full().h(18).flex_none().font_family(mono).text_size(11.5).items_center()
      .when(Boolean(bg), el => el.bg(bg)).children(children);
    const ADD = "#98c37926", DEL = "#e06c7526";
    let oldNo = 0, newNo = 0, i = 0;
    while (i < lines.length && rows.length < CAP) {
      const raw = lines[i];
      if (raw.startsWith("@@")) {
        const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
        rows.push(line(t.surface, [div().flex_1().px(8).truncate().text_color(t.ansi4).child(raw)]));
        i++; continue;
      }
      if (/^(diff |index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |Binary )/.test(raw)) {
        rows.push(line(null, [div().flex_1().px(8).truncate().text_color(t.muted).child(raw)]));
        i++; continue;
      }
      if (raw.startsWith("-")) {
        const dels = [];
        while (i < lines.length && lines[i].startsWith("-") && !lines[i].startsWith("---")) dels.push(lines[i++]);
        const adds = [];
        while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) adds.push(lines[i++]);
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
          const d = dels[k], add = adds[k];
          if (this.split) rows.push(line(null, [
            h_flex().flex_1().min_w(0).when(Boolean(d), el => el.bg(DEL)).children(d
              ? [num(oldNo++), sign("-", t.ansi1), div().flex_1().min_w(0).truncate().child(d.slice(1))]
              : [num(null), sign("", t.dim), div().flex_1()]),
            div().w(1).flex_none().self_stretch().bg(t.border),
            h_flex().flex_1().min_w(0).when(Boolean(add), el => el.bg(ADD)).children(add
              ? [num(newNo++), sign("+", t.ansi2), div().flex_1().min_w(0).truncate().child(add.slice(1))]
              : [num(null), sign("", t.dim), div().flex_1()]),
          ]));
          else {
            if (d) rows.push(line(DEL, [num(oldNo++), num(null), sign("-", t.ansi1), div().flex_1().min_w(0).truncate().child(d.slice(1))]));
            if (add) rows.push(line(ADD, [num(null), num(newNo++), sign("+", t.ansi2), div().flex_1().min_w(0).truncate().child(add.slice(1))]));
          }
        }
        continue;
      }
      if (raw.startsWith("+")) {
        while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) {
          const text = lines[i++].slice(1);
          if (this.split) rows.push(line(null, [
            h_flex().flex_1().min_w(0).children([num(null), sign("", t.dim), div().flex_1()]),
            div().w(1).flex_none().self_stretch().bg(t.border),
            h_flex().flex_1().min_w(0).bg(ADD).children([num(newNo++), sign("+", t.ansi2), div().flex_1().min_w(0).truncate().child(text)]),
          ]));
          else rows.push(line(ADD, [num(null), num(newNo++), sign("+", t.ansi2), div().flex_1().min_w(0).truncate().child(text)]));
        }
        continue;
      }
      if (raw.startsWith(" ")) {
        const text = raw.slice(1);
        if (this.split) rows.push(line(null, [
          h_flex().flex_1().min_w(0).children([num(oldNo++), sign(" ", t.dim), div().flex_1().min_w(0).truncate().child(text)]),
          div().w(1).flex_none().self_stretch().bg(t.border),
          h_flex().flex_1().min_w(0).children([num(newNo++), sign(" ", t.dim), div().flex_1().min_w(0).truncate().child(text)]),
        ]));
        else rows.push(line(null, [num(oldNo++), num(newNo++), sign(" ", t.dim), div().flex_1().min_w(0).truncate().child(text)]));
        i++; continue;
      }
      i++;
    }
    return v_flex().id("filescout-diff").flex_1().min_h(0).overflow_y_scrollbar().overflow_x_hidden().py(4).children(rows);
  }

  /** 在同一个预览区显示这个文件的改动：git diff HEAD，未跟踪的文件整份算新增。 */
  showDiff(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.text = null; this.diffText = null; this.fileError = null; this.diff = true; this.mdView = false;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "diff", "HEAD", "--", path], { cwd: root, on }).catch(() => null);
        let text = r?.code === 0 ? r.stdout : "";
        if (!text) {
          const body = await readTextFile(`${root}/${path}`, { on });
          text = body == null ? "" : body.split("\n").map(line => `+${line}`).join("\n");
        }
        if (!this.current(context) || this.file !== path) return;
        if (!text) { this.fileError = this.L("noDiff"); return; }
        this.diffText = text;
      } catch { if (this.current(context) && this.file === path) this.fileError = this.L("diffErr"); }
      finally { cx.notify(); }
    });
  }

  L(key, ...args) {
    return msg(this.lang, key, ...args);
  }

  /** 当前文件是否按 Markdown 渲染（只有 .md/.markdown 有这条路）。 */
  isMd() {
    return Boolean(!this.diff && this.file && /\.(md|markdown)$/i.test(this.file));
  }

  /** 把面板放大成一个浮窗：同一个 mod，换一块更大的地方画。 */
  expand() {
    reopen("big", {
      mod: "filescout", kind: "window", frame: "none",
      width: 0.9, height: 0.86,
      props: { lang: this.lang, root: this.root, on: this.on, file: this.file ?? null },
    });
  }

  rowMenu(path, isDir, event, cx) {
    cx.stop_propagation();
    openOverlay({
      mod: "filescout",
      kind: "popup",
      at: { x: event.position.x, y: event.position.y },
      width: 280,
      props: { lang: this.lang, menu: { root: this.root, path, dir: isDir, on: this.on, mark: this.marks[path] ?? null, editors: this.editors, at: { x: event.position.x, y: event.position.y } } },
    });
  }

  rows(prefix, depth, out, t) {
    if (depth === 0) this.matchCache = this.filter.trim() ? this.buildMatches() : null;
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      if (!this.showHidden && entry.name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      // 文件取自身状态，目录取子树里最严重的那个（Zed 会把状态卷到父目录）。
      const mark = entry.dir ? this.dirty.get(path) : this.marks[path];
      if (this.onlyChanged && !mark) continue;
      if (this.matchCache && !(entry.dir ? this.matchCache.dirs.has(path) : this.matchCache.files.has(path))) continue;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover)).tooltip(absolute(this.root ?? "", path))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (e, cx) => this.rowMenu(path, entry.dir, e, cx))
        .child(entry.dir ? svg(`mods/filescout/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(iconEl(entry.name, entry.dir, t))
        .child(div().flex_1().min_w(0).truncate().text_color(mark ? markColor(mark, t) : t.foreground).child(entry.name)));
      if (entry.dir && (open || this.onlyChanged || this.matchCache)) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // ---------- tree controls ----------

  /** 目录优先，再按名称；方向由表头切换。 */
  order(list) {
    return list.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name) * this.sortDir);
  }

  toggleSort(cx) {
    this.sortDir = -this.sortDir;
    for (const list of this.entries.values()) this.order(list);
    cx.notify();
  }

  toggleHidden(cx) {
    this.showHidden = !this.showHidden;
    cx.notify();
  }

  toggleChanged(cx) {
    this.onlyChanged = !this.onlyChanged;
    if (this.onlyChanged) this.ensureChangedFolders(cx);
    cx.notify();
  }

  /** 「只看改动」时，把每个有改动的目录都展开并加载，否则深处的改动看不见。 */
  ensureChangedFolders(cx) {
    const context = this.context;
    for (const dir of this.dirty.keys()) {
      this.folders.add(dir);
      if (this.entries.has(dir) || this.pending.has(dir)) continue;
      this.pending.add(dir);
      cx.spawn(async cx => {
        try { await this.loadFolder(dir, context); }
        catch (e) { if (this.current(context)) this.error = String(e); }
        finally { if (this.context === context) this.pending.delete(dir); cx.notify(); }
      });
    }
    cx.notify();
  }

  /** 表头里的小开关：标签是「点了会做什么」，和 分栏 / 预览 一致。 */
  chip(id, label, tip) {
    const t = theme();
    return div().id(id).h(18).flex_none().px(6).rounded(5).cursor_pointer().text_size(11)
      .text_color(t.dim).tooltip(tip).hover(s => s.bg(t.hover))
      .child(label);
  }

  /** 表头下那一条工具栏：开关都放这儿，标题只留名字、统计和面包屑。 */
  tools(t, count) {
    const out = [];
    if (this.file) {
      if (this.diff) out.push(this.chip("filescout-split", this.L(this.split ? "merge" : "split"), this.L("splitTip")).on_click((_e, cx) => { this.split = !this.split; cx.notify(); }));
      if (this.isMd()) out.push(this.chip("filescout-md-toggle", this.L(this.mdView ? "source" : "preview"), this.L("mdTip")).on_click((_e, cx) => { this.mdView = !this.mdView; cx.notify(); }));
      return out;
    }
    out.push(this.searchBox(t));
    if (this.filter) out.push(this.chip("filescout-search-clear", "✕", this.L("clearSearch")).on_click((_e, cx) => this.clearSearch(cx)));
    if (count > 0 || this.onlyChanged) out.push(this.chip("filescout-onlychanged", this.onlyChanged ? this.L("showAll") : this.L("onlyChanged"), this.L("onlyChangedTip")).on_click((_e, cx) => this.toggleChanged(cx)));
    out.push(this.chip("filescout-sort", this.sortDir === 1 ? "AZ" : "ZA", this.L("sortTip")).on_click((_e, cx) => this.toggleSort(cx)));
    out.push(this.chip("filescout-hidden", this.showHidden ? this.L("hideFiles") : this.L("showFiles"), this.L("hideTip")).on_click((_e, cx) => this.toggleHidden(cx)));
    return out;
  }

  /** 搜索词：空格分隔，全都要出现在相对路径里才算命中。 */
  filterTerms() {
    return this.filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  /** 已加载的树里，命中的文件和需要展开的祖先目录。 */
  buildMatches() {
    const terms = this.filterTerms(), files = new Set(), dirs = new Set();
    const walk = (prefix) => {
      let any = false;
      for (const entry of this.entries.get(prefix) ?? []) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.dir) { if (walk(path)) { dirs.add(path); any = true; } }
        else if (terms.every(w => path.toLowerCase().includes(w))) { files.add(path); any = true; }
      }
      return any;
    };
    walk("");
    return { files, dirs };
  }

  searchBox(t) {
    return div().id("filescout-search").flex_1().min_w(0).h(22).px(8).flex().items_center().rounded(6)
      .bg(t.input).border_1().border_color(t.border).cursor_text()
      .child(Input.new(this.search).w_full().text_size(12).text_color(t.foreground));
  }

  clearSearch(cx) {
    this.search.set_value("");
    this.filter = "";
    this.results = null;
    cx.notify();
  }

  /** 回车：搜整个目录（git 仓库走 ls-files，否则 node 递归）。 */
  async searchAll(cx) {
    if (!this.filterTerms().length) return;
    const terms = this.filterTerms(), context = this.context, root = this.root, on = this.on;
    this.results = null; this.searching = true; this.error = null; cx.notify();
    let paths;
    try {
      const git = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, on }).catch(() => null);
      paths = git?.code === 0 ? git.stdout.split("\n").filter(Boolean) : await this.walkFiles(root, on);
    } catch (e) { if (this.current(context)) this.error = String(e); paths = []; }
    if (!this.current(context)) return;
    const hits = [];
    for (const path of paths) {
      const low = path.toLowerCase();
      if (terms.every(w => low.includes(w))) { hits.push(path); if (hits.length >= 200) break; }
    }
    this.results = hits; this.searching = false;
    cx.notify();
  }

  /** 没有 git 时的兜底：node 递归列文件，跳过 node_modules 和 .git。 */
  async walkFiles(root, on) {
    const script = "const fs=require('fs'),path=require('path'),root=process.argv[1],out=[],skip=new Set(['.git','node_modules']);(function walk(d){let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}for(const e of es){if(skip.has(e.name))continue;const p=path.join(d,e.name);if(e.isDirectory())walk(p);else out.push(path.relative(root,p).split(path.sep).join('/'));if(out.length>=20000)return}})(root);process.stdout.write(JSON.stringify(out))";
    const r = await exec("node", ["-e", script, root], { on }).catch(() => null);
    if (!r || r.code !== 0) return [];
    try { return JSON.parse(r.stdout || "[]"); } catch { return []; }
  }

  /** 全量搜索的结果：两行一行，文件名 + 所在目录。 */
  resultRows(t) {
    return this.results.map(path => {
      const name = path.split("/").pop(), dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const mark = this.marks[path];
      return h_flex().id(`file-${path}`).h(40).flex_none().px(10).pr(8).gap(8).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover)).tooltip(absolute(this.root ?? "", path))
        .on_click((_e, cx) => { this.results = null; this.show(path, cx); cx.notify(); })
        .child(iconEl(name, false, t))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_color(mark ? markColor(mark, t) : t.foreground).child(name))
          .child(div().truncate().text_size(11).text_color(t.dim).child(dir)));
    });
  }

  /** 表头面包屑的段：根目录名 + 当前文件的每一段。 */
  crumbSegs() {
    const base = this.root ? this.root.split(/[\\/]/).filter(Boolean).pop() ?? this.root : "";
    const segs = [{ name: base, path: "" }];
    if (this.file) {
      let acc = "";
      for (const part of this.file.split("/")) { acc = acc ? `${acc}/${part}` : part; segs.push({ name: part, path: acc }); }
    }
    return segs;
  }

  /** 表头右侧：可点的路径分段，窄面板只留末几段。 */
  crumbs(t) {
    const segs = this.crumbSegs();
    const shown = segs.length > 4 ? [{ name: "…", path: null }, ...segs.slice(-3)] : segs;
    return h_flex().flex_1().min_w(0).justify_end().gap(4).overflow_hidden().text_size(12)
      .children(shown.flatMap((seg, i) => {
        const tail = this.file ? seg.path === this.file : i === shown.length - 1;
        const crumb = div().id(`filescout-crumb-${i}`).flex_none().text_color(tail ? t.muted : t.dim)
          .when(seg.path != null, el => el.cursor_pointer().hover(s => s.text_color(t.foreground))
            .tooltip(absolute(this.root ?? "", seg.path ?? ""))
            .on_click((_e, cx) => this.gotoCrumb(seg, cx)))
          .child(seg.name);
        return i ? [div().flex_none().text_color(t.dim).child("/"), crumb] : [crumb];
      }));
  }

  /** 面包屑点击：当前文件那一段不动，目录段展开到该层并回到树。 */
  gotoCrumb(seg, cx) {
    if (this.file && seg.path === this.file) return;
    this.expandTo(seg.path, cx);
    this.show(null);
    cx.notify();
  }

  /** 展开到某个相对目录：沿途每一层都补上，没加载过的补加载。 */
  expandTo(rel, cx) {
    const context = this.context;
    let acc = "";
    for (const part of (rel ? rel.split("/") : [])) {
      acc = acc ? `${acc}/${part}` : part;
      this.folders.add(acc);
      if (this.entries.has(acc) || this.pending.has(acc)) continue;
      this.pending.add(acc);
      cx.spawn(async cx => {
        try { await this.loadFolder(acc, context); }
        catch (e) { if (this.current(context)) this.error = String(e); }
        finally { if (this.context === context) this.pending.delete(acc); cx.notify(); }
      });
    }
    cx.notify();
  }

  // ---------- menu ----------

  rel() {
    return this.menu.path || "./";
  }

  abs() {
    return absolute(this.menu.root ?? "", this.menu.path ?? "");
  }

  menuItems() {
    const m = this.menu, out = [];
    // 编辑器二级菜单：只列编辑器。
    if (m.kind === "editors") {
      for (const [bin, name] of m.editors ?? []) out.push([name, () => this.openTargetIn(bin)]);
      return out;
    }
    if (m.mark) out.push([this.L("diff"), () => this.viewDiff()]);
    out.push([this.L(m.dir ? "openFolder" : "openApp"), () => this.openTarget()]);
    // 远程 space 上没有本机的文件管理器和编辑器，那几项就不出现。
    if (!m.on) {
      out.push([this.L("reveal"), () => this.revealTarget()]);
      const editors = m.editors ?? [];
      if (editors.length === 1) out.push([this.L("openIn", editors[0][1]), () => this.openTargetIn(editors[0][0])]);
      else if (editors.length > 1) out.push([this.L("openWith") + " ›", () => this.openEditorsMenu()]);
    }
    if (m.dir) out.push([this.L("termHere"), () => this.openTerminal()]);
    out.push([this.L("copyRel"), (cx) => this.copyPath(this.rel(), this.L("relPath"), cx)]);
    out.push([this.L("copyAbs"), (cx) => this.copyPath(this.abs(), this.L("absPath"), cx)]);
    out.push([this.L("insertRel"), (cx) => this.insertPath("@" + (m.path || "."), this.L("relPath"), cx)]);
    out.push([this.L("insertAbs"), (cx) => this.insertPath("@" + this.abs(), this.L("absPath"), cx)]);
    return out;
  }

  /** 编辑器多的收进二级菜单，菜单右边弹出，别把一级菜单撑长。 */
  openEditorsMenu() {
    const { root, path, dir, on, editors, at } = this.menu;
    closeOverlay(props().overlay);
    openOverlay({
      mod: "filescout", kind: "popup",
      at: at ? { x: at.x + 286, y: at.y } : "pointer",
      width: 200,
      props: { lang: this.lang, menu: { root, path, dir, on, kind: "editors", editors, at } },
    });
  }

  /** 在浮窗里看这个文件的改动（未跟踪的文件整份按新增显示）。 */
  viewDiff() {
    const { root, path, on } = this.menu;
    closeOverlay(props().overlay);
    reopen("diff", {
      mod: "filescout", kind: "window", frame: "none",
      width: 0.72, height: 0.8,
      props: { lang: this.lang, root, on, diff: path, wide: true },
    });
  }

  /** 用系统默认程序打开一个路径：右键菜单和预览失败时的按钮共用。 */
  async openPath(path, on) {
    const p = platform();
    const [cmd, args] =
      p === "windows" ? ["cmd", ["/c", "start", "", path]]
      : p === "macos" ? ["open", [path]]
      : ["xdg-open", [path]];
    try {
      const r = await exec(cmd, args, { on });
      if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
    } catch (e) {
      notify({ title: this.L("openErr", path), body: String(e), level: "error" });
    }
  }

  async openTarget() {
    closeOverlay(props().overlay);
    await this.openPath(this.abs(), this.menu.on);
  }

  revealTarget() {
    closeOverlay(props().overlay);
    this.revealPath(this.abs(), this.menu.on);
  }

  openTargetIn(bin) {
    closeOverlay(props().overlay);
    this.openIn(bin, this.abs());
  }

  openTerminal() {
    const dir = this.abs();
    closeOverlay(props().overlay);
    run("tab.new", { folder: dir });
  }

  /** 在系统文件管理器里定位并选中它，而不是只把目录打开。 */
  async revealPath(path, on) {
    const p = platform(), dir = path.replace(/[\\/][^\\/]*$/, "") || path;
    const [cmd, args] = p === "windows" ? ["explorer", [`/select,${path}`]]
      : p === "macos" ? ["open", ["-R", path]]
      : ["xdg-open", [dir]];
    try { await exec(cmd, args, { on }); }
    catch (e) { notify({ title: this.L("openErr", path), body: String(e), level: "error" }); }
  }

  /** 用某个编辑器打开（code / cursor / zed …）。 */
  async openIn(bin, path) {
    try {
      const r = await exec(bin, [path]);
      if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
    } catch (e) {
      notify({ title: this.L("openErr", path), body: String(e), level: "error" });
    }
  }

  copyPath(text, what, cx) {
    cx.write_to_clipboard(text);
    closeOverlay(props().overlay);
    notify({ title: this.L("copied", what), body: text, level: "success", timeout: 2500 });
  }

  /** Types the path on the tab agent's prompt line without submitting it. */
  insertPath(text, what, cx) {
    const f = focused();
    const candidates = panes().filter((p) => p.terminal && (!f?.tab || p.tab === f.tab));
    const target = candidates.find((p) => p.status) ?? candidates[0];
    closeOverlay(props().overlay);
    if (!target) {
      notify({ title: this.L("noAgent"), level: "warning" });
      return;
    }
    // There is no typed-text send in the command set: clipboard, focus, paste.
    // Bracketed paste leaves the line unsubmitted for the person to edit.
    cx.write_to_clipboard(text);
    run("pane.focus", { pane: target.pane });
    run("terminal.paste");
    notify({ title: this.L("inserted", what), body: text, level: "success", timeout: 2000 });
  }

  choose(index, cx) {
    const item = this.menuItems()[index];
    if (item) item[1](cx);
  }

  renderMenu(cx) {
    const t = theme();
    const list = this.menuItems();
    return v_flex()
      .id("filescout-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map(([label], i) =>
          h_flex()
            .id(`filescout-mi-${i}`)
            .h(31)
            .px(8)
            .rounded(7)
            .items_center()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(div().flex_1().child(label)),
        ),
      );
  }

  /** 预览不出来时那一格里的「用默认程序打开」按钮。 */
  openButton(t) {
    return h_flex().id("filescout-open-app").h(26).px(10).gap(6).flex_none().rounded(6).items_center()
      .bg(t.surface).border_1().border_color(t.border).cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.openPath(absolute(this.root, this.file), this.on); })
      .child(div().text_size(12).text_color(t.foreground).child(this.L("openApp")));
  }

  /** 预览区里没有内容可画时的样子：一句话，加一个能打开它的按钮。 */
  fallback(t, text) {
    return v_flex().p(12).gap(10).items_start().text_color(t.dim)
      .child(text)
      .when(Boolean(this.fileError), el => el.child(this.openButton(t)));
  }

  // ---------- render ----------

  render(cx) {
    if (this.mode === "menu") return this.renderMenu(cx);
    if (this.ctxKey() !== this.context?.key) this.refresh(cx);
    const t = theme(), count = Object.keys(this.marks).length;
    const tools = this.tools(t, count);
    return v_flex().id("filescout").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .when(Boolean(this.overlay), el => el.track_focus(this.handle).on_key_down(e => { if (e.key === "escape") closeOverlay(this.overlay); }))
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("filescout-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("File Scout"))
        .when(count > 0, el => el.child(h_flex().h(18).px(6).items_center().rounded(5).bg(t.surface).text_size(11).text_color(t.dim).child(this.L("files", count))))
        .when(this.stat?.added > 0, el => el.child(div().text_size(11).text_color(t.ansi2).child(`+${this.stat.added}`)))
        .when(this.stat?.removed > 0, el => el.child(div().text_size(11).text_color(t.ansi1).child(`-${this.stat.removed}`)))
        .when(!this.overlay, el => el.child(div().id("filescout-max").w(18).cursor_pointer().text_color(t.muted).on_click(() => this.expand()).child(svg("mods/filescout/icons/maximize.svg").size(13))))
        .when(Boolean(this.overlay), el => el.child(div().id("filescout-close").cursor_pointer().text_color(t.muted).on_click(() => closeOverlay(this.overlay)).child("✕")))
        .child(this.crumbs(t)))
      .when(tools.length > 0, el => el.child(h_flex().id("filescout-tools").h(30).flex_none().px(9).gap(6).items_center().children(tools)))
      .when(!this.file, el => el.child(v_flex().id("filescout-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.results ? this.resultRows(t) : this.rows("", 0, [], t))
        .when(Boolean(this.error), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error)))
        .when(!this.error && this.searching, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.L("searching"))))
        .when(!this.error && !this.searching && this.results && this.results.length === 0, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.L("noResults"))))
        .when(!this.error && !this.results && !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.loading ? this.L("loadingFiles") : this.root ? this.L("noFiles") : this.L("noFolder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child(this.L("limited"))))))
      .when(Boolean(this.file), el => el.child(
        this.image
          ? v_flex().id("filescout-img").flex_1().min_h(0).overflow_hidden().items_center().justify_center().p(10)
              .child(image(this.image).max_w_full().max_h_full())
          : this.mdView && this.isMd() && this.text != null
          ? div().id("filescout-md").flex_1().min_h(0).overflow_hidden().p(14)
              .child(TextView.markdown(`filescout-md-${this.file}`, this.text).selectable(true).scrollable(true))
          : this.diff ? (this.diffText ? this.diffView(t) : this.fallback(t, this.fileError || this.L("loadingDiff")))
          : this.code ? Editor.new(this.code).flex_1().min_h(0) : this.fallback(t, this.fileError || this.L("loadingFile"))));
  }
}
