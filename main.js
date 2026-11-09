// filescout — Herdr 的 Files 面板增强版。
// 速度：Windows 本机列目录走 node（约 80ms），PowerShell 仅作兜底（约 1.4s）。
// 菜单：默认应用打开、复制相对/绝对路径、把 @路径 插入 agent 的输入行。
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import {
  spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window,
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

// 界面文案：布局里给这个 mod 的 props 加 {"lang":"en"} 切英文，默认中文。
const I18N = {
  zh: {
    files: n => `${n} 个改动`, split: "分栏", merge: "合并", preview: "预览", source: "源码",
    openFolder: "在文件管理器中打开", openApp: "用默认程序打开",
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
    openFolder: "Open in file manager", openApp: "Open with default app",
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
};

const NAME_ICON = {
  "package.json": "json", "tsconfig.json": "json", "jsconfig.json": "json",
  "package-lock.json": "lock", "pnpm-lock.yaml": "lock", "yarn.lock": "lock", "cargo.lock": "lock",
  ".gitignore": "git", ".gitattributes": "git", ".gitmodules": "git",
  dockerfile: "docker", "docker-compose.yml": "docker", "docker-compose.yaml": "docker",
  makefile: "makefile", license: "license", "license.md": "license", "readme.md": "markdown",
};

/** The row's icon: a Material file icon by name, else by extension, else the plain file. */
function iconOf(name, isDir) {
  if (isDir) return "mods/filescout/icons/folder-base.svg";
  const lower = name.toLowerCase();
  const byName = NAME_ICON[lower];
  if (byName) return `mods/filescout/icons/${byName}.svg`;
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : lower;
  const icon = FILE_ICON[ext];
  return icon ? `mods/filescout/icons/${icon}.svg` : "mods/filescout/file.svg";
}

/** The path as the user would type it: backslashes on Windows. */
function absolute(root, path) {
  const full = path ? `${root}/${path}` : root;
  return platform() === "windows" ? full.replace(/\//g, "\\") : full;
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
    // Markdown 默认看渲染后的样子，可切回源码。
    this.mdView = true;
    // diff 默认单栏（面板窄），可切分栏。
    this.split = Boolean(p.wide);
    // 从别的实例点"放大"打开时，带走当前正在预览的文件。
    this.overlay = p.overlay ?? null;
    this.openedFile = p.file ?? null;
    this.diffFile = p.diff ?? null;
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
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
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
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.text = null; this.diff = false;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = this.L("gone"); return; }
        if (text.includes("\0")) { this.fileError = this.L("binary"); return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.text = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: this.text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = this.L("previewErr"); }
      finally { cx.notify(); }
    });
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
      // 有变更的文件多一条 View diff，菜单要跟着长高。
      height: this.marks[path] ? 221 : 190,
      props: { lang: this.lang, menu: { root: this.root, path, dir: isDir, on: this.on, mark: this.marks[path] ?? null } },
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      // 文件取自身状态，目录取子树里最严重的那个（Zed 会把状态卷到父目录）。
      const mark = entry.dir ? this.dirty.get(path) : this.marks[path];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (e, cx) => this.rowMenu(path, entry.dir, e, cx))
        .child(entry.dir ? svg(`mods/filescout/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(iconOf(entry.name, entry.dir)).size(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(mark ? markColor(mark, t) : t.foreground).child(entry.name)));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // ---------- menu ----------

  rel() {
    return this.menu.path || "./";
  }

  abs() {
    return absolute(this.menu.root ?? "", this.menu.path ?? "");
  }

  menuItems() {
    const open = this.L(this.menu.dir ? "openFolder" : "openApp");
    return [
      ...(this.menu.mark ? [[this.L("diff"), () => this.viewDiff()]] : []),
      [open, () => this.openTarget()],
      [this.L("copyRel"), (cx) => this.copyPath(this.rel(), this.L("relPath"), cx)],
      [this.L("copyAbs"), (cx) => this.copyPath(this.abs(), this.L("absPath"), cx)],
      [this.L("insertRel"), (cx) => this.insertPath("@" + (this.menu.path || "."), this.L("relPath"), cx)],
      [this.L("insertAbs"), (cx) => this.insertPath("@" + this.abs(), this.L("absPath"), cx)],
    ];
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

  async openTarget() {
    const path = this.abs(), p = platform();
    const [cmd, args] =
      p === "windows" ? ["cmd", ["/c", "start", "", path]]
      : p === "macos" ? ["open", [path]]
      : ["xdg-open", [path]];
    closeOverlay(props().overlay);
    try {
      const r = await exec(cmd, args, { on: this.menu.on });
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

  // ---------- render ----------

  render(cx) {
    if (this.mode === "menu") return this.renderMenu(cx);
    if (this.ctxKey() !== this.context?.key) this.refresh(cx);
    const t = theme(), count = Object.keys(this.marks).length;
    return v_flex().id("filescout").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("filescout-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("File Scout"))
        .when(count > 0, el => el.child(h_flex().h(18).px(6).items_center().rounded(5).bg(t.surface).text_size(11).text_color(t.dim).child(this.L("files", count))))
        .when(this.stat?.added > 0, el => el.child(div().text_size(11).text_color(t.ansi2).child(`+${this.stat.added}`)))
        .when(this.stat?.removed > 0, el => el.child(div().text_size(11).text_color(t.ansi1).child(`-${this.stat.removed}`)))
        .when(Boolean(this.diff), el => el.child(div().id("filescout-split").px(6).h(18).rounded(5).cursor_pointer().text_size(11).text_color(t.dim).hover(s => s.bg(t.hover)).on_click((_e, cx) => { this.split = !this.split; cx.notify(); }).child(this.L(this.split ? "merge" : "split"))))
        .when(this.isMd(), el => el.child(div().id("filescout-md-toggle").px(6).h(18).rounded(5).cursor_pointer().text_size(11).text_color(t.dim).hover(s => s.bg(t.hover)).on_click((_e, cx) => { this.mdView = !this.mdView; cx.notify(); }).child(this.L(this.mdView ? "source" : "preview"))))
        .when(!this.overlay, el => el.child(div().id("filescout-max").w(18).cursor_pointer().text_color(t.muted).on_click(() => this.expand()).child(svg("mods/filescout/icons/maximize.svg").size(13))))
        .when(Boolean(this.overlay), el => el.child(div().id("filescout-close").cursor_pointer().text_color(t.muted).on_click(() => closeOverlay(this.overlay)).child("✕")))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().id("filescout-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? this.L("loadingFiles") : this.root ? this.L("noFiles") : this.L("noFolder")))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child(this.L("limited"))))))
      .when(Boolean(this.file), el => el.child(
        this.mdView && this.isMd() && this.text != null
          ? div().id("filescout-md").flex_1().min_h(0).overflow_hidden().p(14)
              .child(TextView.markdown(`filescout-md-${this.file}`, this.text).selectable(true).scrollable(true))
          : this.diff ? (this.diffText ? this.diffView(t) : div().p(12).text_color(t.dim).child(this.fileError || this.L("loadingDiff")))
          : this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || this.L("loadingFile"))));
  }
}
