// filescout — Herdr 的 Files 面板增强版。
// 速度：Windows 本机列目录走 node（约 80ms），PowerShell 仅作兜底（约 1.4s）。
// 菜单：默认应用打开、复制相对/绝对路径、把 @路径 插入 agent 的输入行。
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
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

const platform = () => window()?.platform ?? "linux";

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

async function directory(path, on) {
  const powershellDirectory = async () => {
    // Fallback when node is not on PATH: ~1.4s per folder on a typical Windows box.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
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
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Filescout extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    const p = props() ?? {};
    if (p.menu) {
      // The right-click menu is this same mod, opened as a popup overlay.
      this.mode = "menu";
      this.menu = p.menu;
      this.at = 0;
      this.handle.focus();
      return;
    }
    this.mode = "browser";
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
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

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
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
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
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
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rowMenu(path, isDir, event, cx) {
    cx.stop_propagation();
    openOverlay({
      mod: "filescout",
      kind: "popup",
      at: { x: event.position.x, y: event.position.y },
      width: 280,
      height: 190,
      props: { menu: { root: this.root, path, dir: isDir, on: this.on } },
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (e, cx) => this.rowMenu(path, entry.dir, e, cx))
        .child(entry.dir ? svg(`mods/filescout/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(iconOf(entry.name, entry.dir)).size(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
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
    const open = this.menu.dir ? "Open in file manager" : "Open with default app";
    return [
      [open, () => this.openTarget()],
      ["Copy relative path", (cx) => this.copyPath(this.rel(), "relative path", cx)],
      ["Copy absolute path", (cx) => this.copyPath(this.abs(), "absolute path", cx)],
      ["Insert relative path into agent", (cx) => this.insertPath("@" + (this.menu.path || "."), "relative path", cx)],
      ["Insert absolute path into agent", (cx) => this.insertPath("@" + this.abs(), "absolute path", cx)],
    ];
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
      notify({ title: `Cannot open ${path}`, body: String(e), level: "error" });
    }
  }

  copyPath(text, what, cx) {
    cx.write_to_clipboard(text);
    closeOverlay(props().overlay);
    notify({ title: `Copied ${what}`, body: text, level: "success", timeout: 2500 });
  }

  /** Types the path on the tab agent's prompt line without submitting it. */
  insertPath(text, what, cx) {
    const f = focused();
    const candidates = panes().filter((p) => p.terminal && (!f?.tab || p.tab === f.tab));
    const target = candidates.find((p) => p.status) ?? candidates[0];
    closeOverlay(props().overlay);
    if (!target) {
      notify({ title: "No agent pane in this tab", level: "warning" });
      return;
    }
    // There is no typed-text send in the command set: clipboard, focus, paste.
    // Bracketed paste leaves the line unsubmitted for the person to edit.
    cx.write_to_clipboard(text);
    run("pane.focus", { pane: target.pane });
    run("terminal.paste");
    notify({ title: `Inserted ${what}`, body: text, level: "success", timeout: 2000 });
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
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("filescout").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("filescout-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("File Scout"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().id("filescout-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
