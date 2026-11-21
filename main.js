// filescout — Herdr 的 Files 面板增强版。
// 速度：Windows 本机列目录走 node（约 80ms），PowerShell 仅作兜底（约 1.4s）。
// 菜单：默认应用打开、复制相对/绝对路径、把 @路径 插入 agent 的输入行。
import { View, div, svg, image, list } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Input, InputState, Scrollbar, v_virtual_list } from "gpui-base";
import {
  spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, appHome,
  props, openOverlay, closeOverlay, run, notify, shared,
} from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
/** 宿主按「扩展名」找语法（Sublime / syntect 那套），这里只补它认不出的、或扩展名和语法名对不上的。
 *  认得出的原样传，认不出的退化到最接近的语法，总比整篇灰着强。 */
const LANG = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js",
  jsonc: "json", json5: "json", jsonl: "json", ndjson: "json", map: "json",
  svelte: "html", vue: "html", astro: "html", htm: "html",
  scss: "css", sass: "css", less: "css",
  toml: "yaml", tf: "yaml", tfvars: "yaml", lock: "yaml", service: "yaml",
  kt: "java", kts: "java", gradle: "groovy",
  mdx: "markdown", mkd: "markdown",
  ps1: "sh", env: "sh", dockerfile: "sh",
  cmake: "make", makefile: "make", mk: "make",
  csv: "properties", tsv: "properties", log: "txt",
  m: "c", mm: "cpp", sqlite3: "sql", gql: "js", graphql: "js",
};
const PER_FOLDER = 500, TOTAL = 5000;
// Zed 风格：按 git 状态给名字上色（文件和目录都算，目录取子树里最严重的那个）。
// 颜色不用主题里的 ansi 槽：亮色主题下 ansi3 是暗橄榄、ansi2 是墨绿，名字和球都发褐发脏。
// 固定两套 hex，按背景亮度挑；白底那套压到 600/700 档，黑底那套用 400 档。
const MARK_HEX = {
  light: { M: "#a16207", A: "#15803d", D: "#dc2626", U: "#7c3aed" },
  dark: { M: "#e3b341", A: "#3fb950", D: "#f85149", U: "#a371f7" },
};
const MARK_RANK = { M: 1, A: 2, D: 3, U: 4 };
/** 宿主给了 appearance / is_dark，直接问它；万一是老宿主没这字段，退回按背景亮度算。 */
const lightTheme = (t) => (t.is_dark === undefined ? luma(t.background) > 0.55 : !t.is_dark);
const _lumaCache = new Map();
function luma(color) {
  const bg = String(color ?? "");
  let v = _lumaCache.get(bg);
  if (v === undefined) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(bg);
    const [r, g, b] = m ? [1, 2, 3].map(i => parseInt(m[i], 16) / 255) : [0, 0, 0];
    v = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    _lumaCache.set(bg, v);
  }
  return v;
}
const markColor = (mark, t) => (lightTheme(t) ? MARK_HEX.light : MARK_HEX.dark)[mark];
/** 行尾的小球（Zed 那种）：文件 6px，目录 5px——目录的颜色是从子树卷上来的，小一号表示「里面有改动」。 */
const markBall = (mark, t, dir) => div().flex_none().size(dir ? 5 : 6).rounded(dir ? 2 : 3).bg(markColor(mark, t));
/** 平台不会中途变：第一次问宿主就记下来，渲染上万行时省掉上万次 window() 调用。
 *  窗口还没就绪时 window() 给不出 platform，这一帧别记，下一帧再问。 */
let _platform = null;
const platform = () => {
  if (!_platform) _platform = window()?.platform ?? null;
  return _platform ?? "linux";
};
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

/** .gitignore 命中的条目：集合里存去掉尾斜杠的仓库相对路径，自身或落在某个被忽略目录下都算。
 *  从自身往上一层一层查 Set（每行固定几次哈希）：被忽略的目录整体在集合里，
 *  所以祖先命中就等于落在它下面。以前逐条遍历，几千条的仓库一帧能跑出几秒。 */
const underIgnored = (set, rel) => {
  if (!set.size) return false;
  for (let p = rel;;) {
    if (set.has(p)) return true;
    const i = p.lastIndexOf("/");
    if (i <= 0) return false;
    p = p.slice(0, i);
  }
};

// ---------- diff：先把 unified diff 解析成行数据，渲染只负责画 ----------
/** 显示用：把制表符按 4 列对齐展开（Text 不画 tab）。 */
const untab = (text) => text.includes("\t")
  ? text.replace(/[^\t]*\t/g, s => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4))
  : text;

/** 一对增删行里真正变化的区间 = 公共前缀和公共后缀之外的那一段。 */
function changedSpan(a, b) {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let suffix = 0;
  while (suffix < max - p && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { p, suffix };
}

/** 把一行切成「没变 / 变了 / 没变」三段，mid 就是行内高亮的那一段；没有对照就整行算没变。 */
function span3(line, other) {
  if (other == null) return { pre: line, mid: "", suf: "", text: line };
  const { p, suffix } = changedSpan(line, other);
  return { pre: line.slice(0, p), mid: line.slice(p, line.length - suffix), suf: suffix ? line.slice(line.length - suffix) : "", text: line };
}

// 单文件 diff 里 `diff --git` / `index` / `---` / `+++` 没有信息量，直接丢掉；
// 其余 git 元信息（新文件、改名、模式变化…）留一行灰字。
const DIFF_NOISE = /^(diff --git |index |--- |\+\+\+ )/;
const DIFF_META = /^(new file|deleted file|old mode|new mode|similarity|rename |Binary )/;
const DIFF_CAP = 20000;

/** unified diff → 单栏用的行数组；分栏由 splitRows() 从这个结果再折一次。 */
function diffRows(lines) {
  const rows = [];
  let oldNo = 0, newNo = 0, i = 0;
  while (i < lines.length && rows.length < DIFF_CAP) {
    const raw = lines[i];
    if (raw.startsWith("@@")) {
      const m = /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@)(.*)$/.exec(raw);
      if (m) { oldNo = Number(m[2]); newNo = Number(m[3]); }
      rows.push({ kind: "hunk", header: m ? m[1] : raw, section: (m?.[4] ?? "").trim() });
      i++; continue;
    }
    if (DIFF_NOISE.test(raw)) { i++; continue; }
    if (DIFF_META.test(raw) || raw.startsWith("\\")) { rows.push({ kind: "meta", text: raw }); i++; continue; }
    if (raw.startsWith("-") || raw.startsWith("+")) {
      const start = i, dels = [], adds = [];
      while (i < lines.length && lines[i][0] === "-" && lines[i] !== "---") dels.push(untab(lines[i++].slice(1)));
      while (i < lines.length && lines[i][0] === "+" && lines[i] !== "+++") adds.push(untab(lines[i++].slice(1)));
      // 内容正好是 "--" / "++" 的增删行，在 diff 里长得和文件头（--- / +++）一模一样：
      // 上面两行一个字都没吃掉时就自己当增删行走，否则 i 原地打转，宿主会打断脚本。
      if (i === start) {
        const text = untab(raw.slice(1));
        rows.push(raw[0] === "-"
          ? { kind: "del", old: oldNo++, new: null, ...span3(text, null) }
          : { kind: "add", old: null, new: newNo++, ...span3(text, null) });
        i++;
      }
      // 一段删、一段增按序号配对：行内高亮要两边都看着才能算。
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k], a = adds[k];
        if (d != null) rows.push({ kind: "del", old: oldNo++, new: null, ...span3(d, a) });
        if (a != null) rows.push({ kind: "add", old: null, new: newNo++, ...span3(a, d) });
      }
      continue;
    }
    if (raw.startsWith(" ")) { const text = untab(raw.slice(1)); rows.push({ kind: "ctx", old: oldNo++, new: newNo++, ...span3(text, null) }); i++; continue; }
    i++;
  }
  return rows;
}

/** 单栏行数组 → 分栏行数组：一对 -/+ 折成一行，配不上的对面留空（画成填充行）。 */
function splitRows(rows) {
  const out = [], side = (r, sign) => ({ no: sign === "-" ? r.old : r.new, sign, pre: r.pre, mid: r.mid, suf: r.suf, text: r.text });
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.kind === "ctx") { out.push({ kind: "row", left: side(r, " "), right: side(r, " ") }); i++; continue; }
    if (r.kind !== "del" && r.kind !== "add") { out.push(r); i++; continue; }
    const dels = [], adds = [];
    while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      out.push({ kind: "row", left: dels[k] ? side(dels[k], "-") : null, right: adds[k] ? side(adds[k], "+") : null });
    }
  }
  return out;
}

// 能当图片预览的扩展名。拷贝放在 appHome 下的 filescout-cache/，不能放 mod 目录里：
// herdr 会盯着 mod 目录，往里写文件会触发 mod 重载，面板状态被重置（看起来像「闪一下回到列表」）。
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);

// 界面文案：布局里给这个 mod 的 props 加 {"lang":"en"} 切英文，默认中文。
const I18N = {
  zh: {
    files: n => `${n} 个改动`, split: "分栏", merge: "合并", wrap: "换行", nowrap: "不换行", preview: "预览", source: "源码",
    hideFiles: "隐藏", showFiles: "显示",
    onlyChanged: "只看改动", showAll: "显示全部",
    sortTip: "按名称排序，点击切换升序 / 降序", hideTip: "显示或隐藏以点开头的文件",
    onlyChangedTip: "只列出有 git 改动的文件和目录",
    splitTip: "单栏 / 分栏看 diff", wrapTip: "长行折行显示 / 恢复截断（只影响单栏）", mdTip: "渲染后的预览 / 看源码",
    maxTip: "放大成浮窗（Enter）",
    search: "搜索文件名，回车搜全部", clearSearch: "清空搜索",
    searching: "正在搜索…", noResults: "没有匹配的文件",
    openFolder: "在文件管理器中打开", openApp: "用默认程序打开",
    reveal: "在文件管理器中定位", openIn: n => `用 ${n} 打开`, openWith: "用编辑器打开", termHere: "在这里开终端",
    copyRel: "复制相对路径", copyAbs: "复制绝对路径", view: "查看文件",
    insertRel: "把相对路径插入 agent", insertAbs: "把绝对路径插入 agent",
    diff: "查看 diff",
    chatArtifacts: "产物", chatTasks: "子任务", chatTurns: "轮", chatUntitled: "未命名对话",
    chatOther: "工作区外", chatNoAgent: "这个标签里没有在跑的 agent", chatOnlyCB: "只解析 CodeBuddy 的对话",
    chatNoSession: "这个目录还没有 CodeBuddy 会话", chatLoading: "正在解析…", chatFailed: "解析失败",
    chatEmpty: "这次对话还没有产物或子任务", chatJustNow: "刚刚", chatRefresh: "重新解析",
    noFiles: "没有文件", noFolder: "没有目录", listErr: "读不到这个目录", loadingFiles: "正在读取…", loadingFile: "正在读取文件…", loadingDiff: "正在读取 diff…",
    limited: "每个目录最多 500 项，总计 5000 项",
    gone: "这个文件已经不在了", binary: "二进制文件，不预览", previewErr: "无法预览（二进制、过大或读不了）",
    noDiff: "没有可显示的改动", diffErr: "读不到 diff",
    openErr: p => `打不开 ${p}`, copied: w => `已复制${w}`, inserted: w => `已插入${w}`,
    relPath: "相对路径", absPath: "绝对路径", noAgent: "当前标签页里没有 agent 面板",
  },
  en: {
    files: n => `${n} files`, split: "Split", merge: "Unified", wrap: "Wrap", nowrap: "No wrap", preview: "Preview", source: "Source",
    hideFiles: "Hide", showFiles: "Show",
    onlyChanged: "Changed", showAll: "Show all",
    sortTip: "Sort by name — click to switch between A→Z and Z→A", hideTip: "Show or hide dot-files",
    onlyChangedTip: "List only files and folders with Git changes",
    splitTip: "Unified or split diff view", wrapTip: "Wrap long lines or clip them (unified only)", mdTip: "Rendered preview or source",
    maxTip: "Enlarge into a floating window (Enter)",
    search: "Search file names, Enter searches all", clearSearch: "Clear search",
    searching: "Searching…", noResults: "No matching files",
    openFolder: "Open in file manager", openApp: "Open with default app",
    reveal: "Reveal in file manager", openIn: n => `Open in ${n}`, openWith: "Open with editor", termHere: "Open terminal here",
    copyRel: "Copy relative path", copyAbs: "Copy absolute path", view: "View file",
    insertRel: "Insert relative path into agent", insertAbs: "Insert absolute path into agent",
    diff: "View diff",
    chatArtifacts: "Artifacts", chatTasks: "Tasks", chatTurns: "turns", chatUntitled: "Untitled chat",
    chatOther: "Outside", chatNoAgent: "No agent running in this tab", chatOnlyCB: "Only CodeBuddy chats are read",
    chatNoSession: "No CodeBuddy chat in this folder yet", chatLoading: "Reading…", chatFailed: "Failed",
    chatEmpty: "Nothing written or planned in this chat yet", chatJustNow: "just now", chatRefresh: "Re-read",
    noFiles: "No files", noFolder: "No folder", listErr: "Cannot read this folder", loadingFiles: "Loading files…", loadingFile: "Loading file…", loadingDiff: "Loading diff…",
    limited: "File list limited to 500 entries per folder and 5,000 total",
    gone: "This file is no longer available", binary: "Binary file · no text preview", previewErr: "Cannot preview this file (binary, too large, or unreadable)",
    noDiff: "No changes to show", diffErr: "Cannot read the diff",
    openErr: p => `Cannot open ${p}`, copied: w => `Copied ${w}`, inserted: w => `Inserted ${w}`,
    relPath: "relative path", absPath: "absolute path", noAgent: "No agent pane in this tab",
  },
};
const msg = (lang, key, ...args) => {
  const value = (I18N[lang] ?? I18N.zh)[key] ?? I18N.zh[key];
  if (value == null) return key;
  return typeof value === "function" ? value(...args) : value;
};


// 放大/看 diff 的浮窗：不传 key，每次都由宿主居中打开；开新的先关旧的。
// 槽里存的 id 可能已经被用户按 Esc 关掉了，closeOverlay 一个过期 id 不能挡住后面的 openOverlay。
const opened = { big: null, diff: null };
const reopen = (slot, spec) => {
  const old = opened[slot];
  opened[slot] = null;
  if (old) { try { closeOverlay(old); } catch { /* 早就关了 */ } }
  opened[slot] = openOverlay(spec);
};

const FILE_ICON = {
  ts: "typescript", tsx: "react", js: "javascript", jsx: "react", mjs: "javascript", cjs: "javascript",
  vue: "vue", svelte: "svelte", astro: "html", html: "html", htm: "html",
  css: "css", scss: "sass", sass: "sass", less: "less",
  json: "json", jsonc: "json", json5: "json", jsonl: "json", ndjson: "json", map: "json",
  md: "markdown", markdown: "markdown", mdx: "markdown", mkd: "markdown",
  yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",
  ini: "settings", cfg: "settings", conf: "settings", env: "settings", properties: "settings", editorconfig: "settings",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", gradle: "java",
  swift: "swift", rb: "ruby", gemspec: "ruby", php: "php", lua: "lua", hs: "haskell", r: "r",
  tf: "terraform", tfvars: "terraform", graphql: "graphql", gql: "graphql",
  c: "c", h: "c", m: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", mm: "cpp", cs: "csharp",
  sh: "console", bash: "console", zsh: "console", ps1: "console", bat: "console", cmd: "console",
  sql: "database", db: "database", sqlite: "database", sqlite3: "database",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", ico: "image", svg: "svg",
  avif: "image", tif: "image", tiff: "image", heic: "image",
  pdf: "pdf", zip: "zip", gz: "zip", tgz: "zip", tar: "zip", rar: "zip", "7z": "zip",
  bz2: "zip", xz: "zip", zst: "zip", jar: "zip", war: "zip",
  lock: "lock", txt: "document", text: "document", log: "document", srt: "document", vtt: "document",
  diff: "diff", patch: "diff",
  pem: "key", key: "key", crt: "key", cer: "key", p12: "key", pfx: "key", pub: "key",
  woff: "font", woff2: "font", ttf: "font", otf: "font", eot: "font",
  mp3: "audio", wav: "audio", flac: "audio", ogg: "audio", m4a: "audio", aac: "audio",
  mp4: "video", mkv: "video", mov: "video", avi: "video", webm: "video",
  ipynb: "notebook", cmake: "makefile",
  xlsx: "excel", xls: "excel", xlsm: "excel", xlsb: "excel", csv: "excel", tsv: "excel", ods: "excel",
  docx: "word", doc: "word", rtf: "word", odt: "word",
  pptx: "powerpoint", ppt: "powerpoint", odp: "powerpoint",
};

const NAME_ICON = {
  "package.json": "json", "tsconfig.json": "json", "jsconfig.json": "json", "composer.json": "php",
  "package-lock.json": "lock", "pnpm-lock.yaml": "lock", "yarn.lock": "lock", "cargo.lock": "lock", "composer.lock": "lock",
  ".gitignore": "git", ".gitattributes": "git", ".gitmodules": "git", ".gitkeep": "git",
  dockerfile: "docker", "docker-compose.yml": "docker", "docker-compose.yaml": "docker", ".dockerignore": "docker",
  makefile: "makefile", gnumakefile: "makefile", "cmakelists.txt": "makefile",
  license: "license", "license.md": "license", licence: "license", copying: "license", notice: "license",
  "readme.md": "markdown",
  "go.mod": "go", "go.sum": "go", "cargo.toml": "toml",
  "requirements.txt": "python", "pyproject.toml": "python", "setup.py": "python", pipfile: "python",
  gemfile: "ruby", rakefile: "ruby", procfile: "console",
  ".env": "settings", ".env.local": "settings", ".env.development": "settings", ".env.production": "settings", ".env.example": "settings",
  ".editorconfig": "settings", ".npmrc": "settings", ".nvmrc": "settings", ".prettierrc": "settings", ".babelrc": "settings", ".eslintrc": "settings",
};

/** 目录按名字上色：同一个文件夹轮廓，只换配色，风格统一；没命中的还是默认棕。 */
const FOLDER_ICON = {
  src: "folder-src", source: "folder-src", lib: "folder-src", libs: "folder-src", app: "folder-src", core: "folder-src",
  pkg: "folder-src", packages: "folder-src", modules: "folder-src", include: "folder-src",
  test: "folder-test", tests: "folder-test", spec: "folder-test", specs: "folder-test", __tests__: "folder-test", testing: "folder-test", e2e: "folder-test",
  doc: "folder-docs", docs: "folder-docs", documentation: "folder-docs", wiki: "folder-docs", guides: "folder-docs",
  config: "folder-config", configs: "folder-config", conf: "folder-config", cfg: "folder-config", settings: "folder-config",
  ".vscode": "folder-config", ".idea": "folder-config",
  script: "folder-script", scripts: "folder-script", bin: "folder-script", tools: "folder-script",
  ".github": "folder-git", ".gitlab": "folder-git",
  node_modules: "folder-deps", vendor: "folder-deps", deps: "folder-deps", ".venv": "folder-deps", venv: "folder-deps",
  build: "folder-build", dist: "folder-build", out: "folder-build", output: "folder-build", target: "folder-build", coverage: "folder-build",
  assets: "folder-assets", public: "folder-assets", static: "folder-assets", media: "folder-assets", images: "folder-assets", img: "folder-assets", icons: "folder-assets", resources: "folder-assets", fonts: "folder-assets",
  styles: "folder-style", style: "folder-style", css: "folder-style", scss: "folder-style", theme: "folder-style", themes: "folder-style",
  components: "folder-component", component: "folder-component", views: "folder-component", pages: "folder-component", ui: "folder-component", widgets: "folder-component", layouts: "folder-component",
  hooks: "folder-shared", composables: "folder-shared", utils: "folder-shared", util: "folder-shared", helpers: "folder-shared", common: "folder-shared", shared: "folder-shared",
  api: "folder-api", server: "folder-api", routes: "folder-api", router: "folder-api", controllers: "folder-api", services: "folder-api",
  models: "folder-model", model: "folder-model", entities: "folder-model", schema: "folder-model", schemas: "folder-model", migrations: "folder-model", data: "folder-model",
  i18n: "folder-i18n", locales: "folder-i18n", locale: "folder-i18n", lang: "folder-i18n", translations: "folder-i18n",
};

/** The row's icon: a folder by name, else a file by name, else by extension, else null. */
function iconOf(name, isDir) {
  const lower = name.toLowerCase();
  if (isDir) return `mods/filescout/icons/${FOLDER_ICON[lower] ?? "folder-base"}.svg`;
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
  // 列目录失败时把走过的每条路和各自的错误攒起来：面板底部只显示最后一句，
  // 光看「cannot run sh」看不出 node / powershell 为什么也没成。
  const why = [`platform=${platform()} on=${on}`];
  const powershellDirectory = async () => {
    // Fallback when node is not on PATH: ~1.4s per folder on a typical Windows box.
    let r;
    try { r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on }); }
    catch (e) { why.push("ps-exec:" + e); throw e; }
    if (r.code !== 0) { why.push("ps-code:" + r.code + ":" + String(r.stderr).slice(0, 300)); throw new Error(r.stderr || msg(lang, "listErr")); }
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  const windowsDirectory = async () => {
    // node starts in ~80ms and its stdio is UTF-8; the shell costs ~1.4s a call.
    const script = "const fs=require('fs'),p=process.argv[1],out=[];try{for(const e of fs.readdirSync(p,{withFileTypes:true})){if(e.name==='.git')continue;let dir=e.isDirectory();if(!dir&&e.isSymbolicLink()){try{dir=fs.statSync(p+'/'+e.name).isDirectory()}catch{}}out.push([e.name,dir?1:0]);if(out.length>=501)break}}catch(err){process.stderr.write(String((err&&err.message)||err));process.exit(1)}process.stdout.write(JSON.stringify(out))";
    let r;
    try { r = await exec("node", ["-e", script, path], { on }); }
    catch (e) { why.push("node-exec:" + e); return powershellDirectory(); }
    if (r.code !== 0) { why.push("node-code:" + r.code + ":" + String(r.stderr).slice(0, 300)); return powershellDirectory(); }
    return JSON.parse(r.stdout || "[]").map(([name, dir]) => ({ name, dir: dir === 1 }));
  };
  // Windows 先走 node（~80ms）：这台机器没有 sh，先试只会白撞一次宿主的
  // 「cannot run sh: program not found」。node 走不通（对端未必也是 Windows）再退 sh。
  if (platform() === "windows") {
    try { return await windowsDirectory(); } catch (e) { why.push("win:" + e); }
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    // sh 起不来，而上面那趟 node 还没试过：这台机器（或对端）其实是 Windows，用 node 再试一遍。
    if (platform() !== "windows" && /program not found/i.test(String(e))) return windowsDirectory();
    throw new Error(`${why.join(" | ")} :: ${e}`);
  }
  if (r.code !== 0) throw new Error(r.stderr || msg(lang, "listErr"));
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}


// ---------- Chat 标签 ----------

/** 当前窗口这个标签里在跑的 agent。点了右侧面板后 focused().pane 会变 null，
 *  但 tab 仍是窗口上下文，所以按 tab 找 pane。 */
function chatTarget() {
  const f = focused();
  const space = spaces().find((s) => s.active);
  const tab = f?.tab ?? null;
  const pane = tab ? panes().find((p) => p.tab === tab && p.app) ?? null : null;
  return {
    tab,
    cwd: pane?.cwd ?? f?.cwd ?? space?.folder ?? null,
    app: pane?.app ?? null,
    program: pane?.program?.name ?? pane?.app ?? null,
    status: pane?.status ?? null,
  };
}

/** 日期时间一律纯数字：当天 14:05、同年 11-17、更早 2025-11-03。 */
function chatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  const two = (n) => String(n).padStart(2, "0");
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const md = `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

const CHAT_STATUS = (s) =>
  s === "working" ? "#42a5f5" : s === "blocked" ? "#ef5350" : s === "done" ? "#66bb6a" : "#9e9e9e";

const chatExt = (p) => {
  const name = String(p).split(/[\\/]/).pop() ?? "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/** Chat：读当前标签里 CodeBuddy 的会话日志，列这次对话动过的文件与它的任务。
 *  和 Files 共用图标、主题与右键菜单（右键产物直接弹 Files 的 menu overlay）。 */
class Chat extends View {
  /** 不用 init：View 构造函数会自动调 init(props, cx)，这里得由 Filescout 传角色参数，另起一个入口。 */
  start(p, cx) {
    this.lang = p.lang === "en" ? "en" : "zh";
    this.handle = cx.focus_handle();
    this.data = null;
    this.reason = null;
    this.error = null;
    this.loading = true;
    this.expanded = false;
    this.file = null;
    this.offset = 0;
    this.busy = false;
    this.again = false;
    this.watching = null;
    this.target = chatTarget();
    this.signature = this.sigOf(this.target);
    this.load(cx, true);
    // agent 换标签 / 换目录 / 状态变化：定时看，watch 只看得到文件。
    cx.timer.every(4000, (cx) => this.follow(cx));
  }

  L(key) {
    return msg(this.lang, key);
  }

  sigOf(t) {
    return `${t.tab}|${t.cwd}|${t.app}`;
  }

  follow(cx) {
    const next = chatTarget();
    const moved = this.sigOf(next) !== this.signature;
    const statusChanged = next.status !== this.target?.status;
    this.target = next;
    if (moved) {
      this.signature = this.sigOf(next);
      this.data = null;
      this.reason = null;
      this.error = null;
      this.loading = true;
      this.load(cx, true);
      return;
    }
    if (statusChanged && !this.loading) cx.notify();
  }

  async load(cx, reset) {
    const tg = this.target;
    if (!tg.cwd) {
      this.data = null;
      this.reason = "chatNoAgent";
      this.loading = false;
      cx.notify();
      return;
    }
    if (!/codebuddy/i.test(tg.app ?? "")) {
      this.data = null;
      this.reason = "chatOnlyCB";
      this.loading = false;
      cx.notify();
      return;
    }
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    this.loading = true;
    if (reset) {
      this.file = null;
      this.offset = 0;
    }
    try {
      const script = `${appHome()}/mods/filescout/scan.js`.replace(/\\/g, "/");
      const r = await exec("node", [script, tg.cwd, this.file ?? "", String(this.offset)], { timeout: 20000 });
      if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
      const d = JSON.parse(r.stdout);
      this.error = null;
      if (d.none) {
        this.data = null;
        this.reason = "chatNoSession";
      } else {
        this.absorb(d, reset);
        this.watchSession(cx);
      }
    } catch (e) {
      this.error = String(e?.message ?? e);
    } finally {
      this.busy = false;
      this.loading = false;
      if (this.again) {
        this.again = false;
        this.load(cx, false);
      }
      cx.notify();
    }
  }

  absorb(d, reset) {
    this.reason = null;
    const s = d.session;
    if (reset || !this.data || this.data.session.id !== s.id) {
      this.data = { session: { ...s }, artifacts: new Map(), tasks: d.tasks ?? [] };
    } else {
      const cur = this.data.session;
      cur.title = s.title || cur.title;
      cur.model = s.model || cur.model;
      cur.turns += s.turns;
      cur.lastAt = Math.max(cur.lastAt, s.lastAt);
    }
    for (const a of d.artifacts ?? []) {
      const k = a.path.toLowerCase();
      const old = this.data.artifacts.get(k);
      this.data.artifacts.set(k, old ? { ...old, edits: old.edits + a.edits, last: Math.max(old.last, a.last) } : a);
    }
    if (d.tasks) this.data.tasks = d.tasks;
    this.file = s.file;
    this.offset = d.offset;
  }

  watchSession(cx) {
    const file = this.file;
    if (!file) return;
    const i = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
    const dir = i > 0 ? file.slice(0, i) : null;
    if (!dir || dir === this.watching) return;
    this.watching = dir;
    const sig = this.signature;
    cx.spawn(async (cx) => {
      try {
        while (this.signature === sig && this.watching === dir) {
          await watchFolder(dir);
          if (this.signature === sig) this.load(cx, false);
        }
      } catch {
        if (this.watching === dir) this.watching = null;
      }
    });
  }

  /** filescout 的菜单按 root + 相对路径找文件；工作区外的把它的目录当根。 */
  locate(a) {
    const cwd = String(this.target?.cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const p = String(a.path).replace(/\\/g, "/");
    if (!a.outside && cwd && p.toLowerCase().startsWith(cwd.toLowerCase() + "/")) {
      return { root: cwd, file: p.slice(cwd.length + 1) };
    }
    const i = p.lastIndexOf("/");
    return i > 0 ? { root: p.slice(0, i), file: p.slice(i + 1) } : { root: cwd, file: p };
  }

  /** 独立打开：不切 Files 面板，直接开一个 Files 的预览浮窗。 */
  preview(a) {
    const { root, file } = this.locate(a);
    openOverlay({
      mod: "filescout", kind: "window", frame: "none", key: "filescout-preview",
      width: 0.86, height: 0.8,
      props: { lang: this.lang, root, on: null, file },
    });
  }

  /** 右键：复用 Files 面板那一组菜单（查看 / diff / 默认程序 / 文件管理器 / 复制 / 插入 agent）。 */
  openMenu(a) {
    const { root, file } = this.locate(a);
    openOverlay({
      mod: "filescout", kind: "popup", width: 280,
      props: {
        lang: this.lang,
        menu: { root, path: file, dir: false, on: null, mark: null, diff: true, view: true, editors: null },
      },
    });
  }

  ago(ts) {
    return ts && Date.now() - ts < 60000 ? this.L("chatJustNow") : chatTime(ts);
  }

  emptyText() {
    if (this.error) return `${this.L("chatFailed")}: ${this.error}`;
    if (this.reason === "chatNoAgent") return this.L("chatNoAgent");
    if (this.reason === "chatOnlyCB") return this.L("chatOnlyCB");
    if (this.reason === "chatNoSession") return this.L("chatNoSession");
    return this.L("chatLoading");
  }

  header(t) {
    const n = this.data ? this.data.artifacts.size : 0;
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Chat"))
      .when(n > 0, (el) => el.child(h_flex().h(18).px(6).items_center().rounded(5).bg(t.surface)
        .text_size(11).text_color(t.dim).child(String(n))))
      .child(div().flex_1())
      .when(Boolean(this.target?.status), (el) => el.child(div().size(6).rounded(3).bg(CHAT_STATUS(this.target.status))))
      .child(div().id("filescout-chat-refresh").w(18).cursor_pointer().text_color(t.muted).tooltip(this.L("chatRefresh"))
        .on_click((_e, cx) => { cx.stop_propagation(); this.load(cx, true); }).child("↻"));
  }

  card(t, s) {
    return v_flex().gap(4).p(9).rounded(7).bg(t.surface)
      .child(div().truncate().font_semibold().child(s.title || this.L("chatUntitled")))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .when(Boolean(this.target?.program), (el) => el.child(div().child(this.target.program)))
        .when(Boolean(s.model), (el) => el.child(div().child(s.model)))
        .child(div().child(`${s.turns} ${this.L("chatTurns")}`))
        .child(div().flex_1())
        .child(div().child(this.ago(s.lastAt))))
      .child(div().text_size(11).text_color(t.dim).truncate().tooltip(s.file).child(this.target?.cwd ?? ""));
  }

  /** 产物：文件名亮、目录暗，图标直接用 Files 那一套（90 多条扩展名映射）。 */
  artifactRow(t, a, i) {
    const icon = FILE_ICON[chatExt(a.path)] ?? "document";
    const cut = a.rel.lastIndexOf("/");
    const name = cut >= 0 ? a.rel.slice(cut + 1) : a.rel;
    const dir = cut >= 0 ? a.rel.slice(0, cut) : "";
    return h_flex().id(`filescout-chat-a-${i}`).h(38).px(6).gap(9).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(a.path)
      .on_click((_e, cx) => { cx.stop_propagation(); this.preview(a); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(a); })
      .child(svg(`mods/filescout/icons/${icon}.svg`).size(15).flex_none())
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(5).items_center()
          .child(div().min_w(0).truncate().text_color(a.outside ? t.muted : t.foreground).child(name))
          .when(a.edits > 1, (el) => el.child(div().text_size(10).text_color(t.dim).child(`×${a.edits}`))))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir || this.target?.cwd || "")))
      .child(div().text_size(10).text_color(t.dim).child(this.ago(a.last)));
  }

  taskRow(t, task, i) {
    const done = task.status === "completed", run = task.status === "in_progress";
    return h_flex().id(`filescout-chat-t-${i}`).h(26).px(6).gap(8).items_center().rounded(6)
      .when(Boolean(task.description), (el) => el.tooltip(task.description))
      .when(done, (el) => el.child(svg("mods/workspace-chrome/circle-check.svg").size(13).flex_none().text_color("#66bb6a")))
      .when(run, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color("#ffb74d").spin(900)))
      .when(!done && !run, (el) => el.child(h_flex().w(13).flex_none().items_center().justify_center()
        .child(div().size(7).rounded(4).border_1().border_color(t.dim))))
      .child(div().flex_1().min_w(0).truncate()
        .text_color(done ? t.muted : t.foreground)
        .child(task.subject || task.activeForm || ""));
  }

  content(t, cx) {
    if (!this.data) {
      return v_flex().flex_1().min_h(0).items_center().justify_center().p(16)
        .child(div().text_size(12).text_color(t.muted).child(this.emptyText()));
    }
    const d = this.data;
    const arts = [...d.artifacts.values()];
    const inner = arts.filter((a) => !a.outside).sort((a, b) => b.last - a.last);
    const outer = arts.filter((a) => a.outside).sort((a, b) => b.last - a.last);
    const tasks = d.tasks ?? [];
    const done = tasks.filter((x) => x.status === "completed").length;
    const rows = [this.card(t, d.session)];
    if (inner.length > 0) {
      rows.push(this.section(t, `${this.L("chatArtifacts")} ${inner.length}`, inner.map((a, i) => this.artifactRow(t, a, i))));
    }
    if (outer.length > 0) {
      const head = h_flex().h(22).items_center().gap(4).cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); this.expanded = !this.expanded; cx.notify(); })
        .child(svg(`mods/filescout/chevron-${this.expanded ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().text_size(11).text_color(t.dim).child(`${this.L("chatOther")} ${outer.length}`));
      const box = v_flex().gap(1).child(head);
      if (this.expanded) box.children(outer.map((a, i) => this.artifactRow(t, a, 1000 + i)));
      rows.push(box);
    }
    if (tasks.length > 0) {
      rows.push(this.section(t, `${this.L("chatTasks")} ${done}/${tasks.length}`, tasks.map((x, i) => this.taskRow(t, x, i))));
    }
    if (arts.length === 0 && tasks.length === 0) {
      rows.push(div().text_size(12).text_color(t.dim).child(this.L("chatEmpty")));
    }
    return v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(12).children(rows);
  }

  section(t, title, rows) {
    return v_flex().gap(1)
      .child(h_flex().h(22).items_center().child(div().text_size(11).text_color(t.dim).child(title)))
      .children(rows);
  }

  render(cx) {
    const t = theme();
    return v_flex().id("filescout-chat").size_full().min_h(0).rounded(10).overflow_hidden().track_focus(this.handle)
      .bg(t.background).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .child(this.content(t, cx));
  }
}

export default class Filescout extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    const p = props() ?? {};
    // 同一个 mod 的第二种角色：右侧 Chat 标签（看当前会话的产物与子任务）。
    if (p.role === "chat") { this.chat = new Chat(); this.chat.start(p, cx); return; }
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
    this.searchSeq = 0;
    // 搜索框聚焦时回车要提交搜索，不能被面板的「Enter 放大」抢走。
    this.typing = false;
    this.search.on("focus", () => { this.typing = true; });
    this.search.on("blur", () => { this.typing = false; });
    this.search.on("change", (_e, cx) => { this.filter = this.search.value(); this.results = null; this.treeVer++; cx.notify(); });
    this.search.on("submit", (_e, cx) => this.searchAll(cx));
    // Markdown 默认看渲染后的样子，可切回源码。
    this.mdView = true;
    // diff 默认单栏（面板窄），可切分栏；长行默认截断，跟 VSCode 一致，可切换行。
    this.split = Boolean(p.wide);
    this.diffWrap = false;
    this.diffRows = null;
    this.diffStat = null;
    // 从别的实例点"放大"打开时，带走当前正在预览的文件。
    this.overlay = p.overlay ?? null;
    this.openedFile = p.file ?? null;
    this.diffFile = p.diff ?? null;
    // 别的面板（Chat）通过 shared 请我打开文件，记下处理过的那个时间戳。
    this.openAt = 0;
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
    // 刷新是「攒改动 + 跑一趟」：busy 表示有趟在跑，again 表示这趟跑完还得补一趟；
    // changed 是攒下来的改动路径，null 表示全量（没人盯目录时只能全量）。
    this.busy = false;
    this.again = false;
    this.changed = new Set();
    // 树的扁平化结果缓存：treeVer 变一次就重建，平时直接给上一帧那份。
    this.treeVer = 0;
    this.marks = {};
    this.dirty = new Map();
    this.ignored = new Set();
    this.refresh(cx);
    // 本机有 watch 顶着，定时这趟只补个根目录（深处的改动 watch 会报）；
    // 远端 watch 不生效，定时这趟就是唯一的全量。
    cx.timer.every(10000, cx => this.refresh(cx, this.watched ? [] : null));
  }

  // ---------- browser ----------

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { const changed = await watchFolder(root); if (this.current(context)) this.refresh(cx, changed); } }
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
    this.treeVer++;
  }

  /** 重列这几个目录；folders 为 null 就是全量（首次进来、切目录、远端定时兜底）。
   *  已经在列的那几个不排队：一份正要回来的新列表就是答案。 */
  async reloadFolders(folders, context) {
    for (const path of folders ?? ["", ...this.folders]) {
      if (!this.current(context)) return;
      if (this.pending.has(path)) continue;
      this.pending.add(path);
      try { await this.loadFolder(path, context); }
      finally { if (this.context === context) this.pending.delete(path); }
    }
  }

  /** watch 报的绝对路径 → 真正要重列的目录：改动自己，加它每一层祖先里展开着的那些。
   *  批次里出现根目录（或面板目录之外的东西）就返回 null，整棵重来。 */
  foldersFor(paths) {
    const win = platform() === "windows", root = slashed(this.root ?? "").replace(/\/+$/, "");
    const base = win ? root.toLowerCase() : root, out = new Set([""]);
    for (const p of paths) {
      const rel = slashed(p).replace(/\/+$/, ""), low = win ? rel.toLowerCase() : rel;
      if (!base || low === base || !low.startsWith(`${base}/`)) return null;
      for (let dir = rel.slice(root.length + 1);;) {
        if (this.folders.has(dir)) out.add(dir);
        const cut = dir.lastIndexOf("/");
        if (cut < 0) break;
        dir = dir.slice(0, cut);
      }
    }
    return [...out];
  }

  /** git 的三样东西：改动标记、被忽略的条目、增删行数。不在仓库里就都是空的。 */
  async gitStatus({ cwd, on }) {
    const marks = {}, ignored = new Set();
    let added = 0, removed = 0;
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
    if (top?.code !== 0) return { marks, ignored, added, removed };
    // 键用相对面板目录的路径，省掉绝对路径的斜杠差异。
    const base = slashed(top.stdout.trim()) + "/", root = slashed(cwd) + "/";
    // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
    const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
    if (status?.code === 0) {
      for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
        const full = base + entry.slice(3), xy = entry.slice(0, 2);
        if (!full.startsWith(root)) continue;
        marks[full.slice(root.length)] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
      }
    }
    // .gitignore 命中的条目 git status 不报，单独列一份：渲染时压暗，对齐 Zed 的 Ignored 色。
    const ls = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { cwd, on }).catch(() => null);
    if (ls?.code === 0) for (const p of ls.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
      const full = base + p.replace(/\/$/, "");
      if (full.startsWith(root)) ignored.add(full.slice(root.length));
    }
    const numstat = await exec("git", ["--no-optional-locks", "diff", "HEAD", "--numstat"], { cwd, on }).catch(() => null);
    if (numstat?.code === 0) for (const line of numstat.stdout.split("\n")) {
      const [plus, minus] = line.split("\t");
      if (/^\d+$/.test(plus)) added += Number(plus);
      if (/^\d+$/.test(minus)) removed += Number(minus);
    }
    return { marks, ignored, added, removed };
  }

  /** 刷新：一趟 = 重列受影响的目录 + 重取 git 状态。changed 只有 watch 给，
   *  是那批改动的绝对路径；没给就是全量重列。正在跑的那趟跑完会补上这一趟攒下的改动。 */
  refresh(cx, changed) {
    const { cwd, on } = this.fixed ?? location(), next = this.ctxKey();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.dirty = new Map(); this.ignored = new Set(); this.show(null); this.watched = null; this.error = null; this.limited = false;
      // 换了目录：正在跑的那趟自己会退出，状态归零，这一趟必须全量。
      this.loading = false; this.busy = false; this.again = false; this.changed = null; this.treeVer++;
      if (saved?.file) this.show(saved.file, cx);
      if (this.openedFile) { this.show(this.openedFile, cx); this.openedFile = null; }
      if (this.diffFile) { this.showDiff(this.diffFile, cx); this.diffFile = null; }
    }
    if (!cwd) return;
    this.limited = false;
    if (!changed) this.changed = null;
    else if (this.changed) for (const p of changed) this.changed.add(p);
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    this.loading = true;
    const context = this.context;
    cx.spawn(async cx => {
      for (;;) {
        const paths = this.changed; this.changed = new Set(); this.again = false;
        if (!this.current(context)) break;
        try {
          await this.reloadFolders(paths ? this.foldersFor(paths) : null, context);
          if (!this.current(context)) break;
          const git = await this.gitStatus(context);
          if (!this.current(context)) break;
          this.marks = git.marks; this.dirty = rollup(git.marks); this.ignored = git.ignored; this.stat = { added: git.added, removed: git.removed };
          this.error = null; this.watch(context.cwd, cx);
          if (this.onlyChanged) this.ensureChangedFolders(cx);
          this.treeVer++;
        } catch (e) { if (this.current(context)) this.error = String(e); break; }
        if (!this.again) break;
      }
      if (this.context === context) { this.busy = false; this.loading = false; }
      cx.notify();
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
    this.treeVer++;
    cx.notify();
  }

  /** Chat 面板点了产物：shared 里带时间戳，只处理一次。工作区外的路径不归这棵树管。 */
  syncOpen(cx) {
    const req = shared("filescout.open");
    if (!req || req.at === this.openAt) return;
    this.openAt = req.at;
    const root = slashed(this.root ?? "").replace(/\/+$/, "");
    const p = slashed(req.path ?? "");
    if (!root || !req.path || !p.toLowerCase().startsWith(root.toLowerCase() + "/")) return;
    this.show(p.slice(root.length + 1), cx);
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.text = null; this.image = null; this.diff = false;
    this.diffRows = null; this.diffStat = null;
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
    const t = theme(), name = path.slice(path.lastIndexOf("/") + 1);
    const ext = (name.includes(".") ? name.split(".").pop() : name).toLowerCase();
    this.text = raw.length > 400000 ? raw.slice(0, 400000) + "\n… (file truncated)" : raw;
    this.code?.release();
    this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
      value: this.text,
      font_family: settings().font_family, font_size: 12,
      syntax: {
        keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3,
        number: t.ansi1, constant: t.ansi6, boolean: t.ansi1, variable: t.foreground,
        operator: t.muted, punctuation: t.muted, "string.escape": t.ansi3,
      } });
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
    // 看 diff 时重算 diff；看文本时重读文件。
    if (this.diff) {
      try {
        const text = await this.diffTextFor(path, context);
        if (this.file !== path || this.context !== context || !this.diff) return;
        if (!text) {
          if (this.diffText) { this.diffText = null; this.diffRows = null; }
          this.fileError = this.L("noDiff"); cx.notify(); return;
        }
        if (text !== this.diffText) { this.setDiff(text); cx.notify(); }
      } catch { /* 读不到就先不动 */ }
      return;
    }
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

  /** 画 diff：VSCode 风格 —— 左边缘变更色条、灰底 gutter 行号、两层底色（整行 + 行内变化段）。 */
  diffView(t) {
    const mono = settings().font_family;
    const wrap = this.diffWrap && !this.split;
    const rows = (this.diffRows && (this.split ? this.diffRows.split : this.diffRows.unified)) ?? [];
    if (!rows.length) return this.fallback(t, this.fileError || this.L("noDiff"));
    // 主题色的一层浅底（整行）+ 一层深底（行内变化的那几个字），和 IDE 一样分两层。
    const tone = {
      add: { bar: t.ansi2, bg: t.ansi2 + "1f", mid: t.ansi2 + "4d" },
      del: { bar: t.ansi1, bg: t.ansi1 + "1f", mid: t.ansi1 + "4d" },
    };
    const bar = color => div().w(3).flex_none().self_stretch().when(Boolean(color), el => el.bg(color));
    const num = n => div().w(34).flex_none().text_right().pr(6).text_color(t.dim).child(n == null ? "" : String(n));
    const sign = (s, color) => div().w(14).flex_none().text_center().text_color(color ?? t.dim).child(s);
    // 折行时行高不定，行号跟着第一行文字走，不要竖着居中。
    const gutter = cells => h_flex().flex_none().self_stretch().bg(t.surface).border_r(1).border_color(t.border)
      .when(wrap, el => el.items_start().pt(2)).when(!wrap, el => el.items_center()).children(cells);
    const rowEl = (bg, children) => h_flex().w_full().flex_none().font_family(mono).text_size(11.5)
      .when(wrap, el => el.items_start().py(2)).when(!wrap, el => el.h(18).items_center())
      .when(Boolean(bg), el => el.bg(bg)).children(children);
    /** 正文：换行时整行折行；否则切成「没变 / 变了 / 没变」三段，中间那段加底色。 */
    const body = (side, hl) => {
      if (!side) return div().flex_1();
      if (wrap) return div().flex_1().min_w(0).whitespace_normal().px(6).child(side.text);
      return h_flex().flex_1().min_w(0).items_center().overflow_hidden()
        .child(div().flex_none().whitespace_nowrap().pl(6).child(side.pre))
        .when(Boolean(side.mid), el => el.child(div().flex_none().rounded(2).bg(hl).child(side.mid)))
        .child(div().flex_1().min_w(0).truncate().child(side.suf));
    };
    /** 一栏里的四块：色条（占位也要有，不然左右错位）、行号、变号、正文。 */
    const cell = (side, tn) => [
      bar(side ? tn.bar : null),
      gutter([num(side ? side.no : null)]),
      sign(side ? side.sign : "", tn.bar),
      body(side, tn.mid),
    ];
    /** 分栏里的一侧；side 为 null 就是「对面没有对应行」的填充位。 */
    const pane = side => {
      const tn = !side || side.sign === " " ? { bar: null, mid: null } : side.sign === "+" ? tone.add : tone.del;
      const bg = !side ? t.surface : tn.bg ?? null;
      return h_flex().flex_1().min_w(0).when(Boolean(bg), el => el.bg(bg)).children(cell(side, tn));
    };

    const view = r => {
      if (r.kind === "hunk") return rowEl(t.raised, [
        div().flex_none().pl(10).text_color(t.ansi4).child(r.header),
        div().flex_1().min_w(0).truncate().pl(8).text_color(t.muted).child(r.section),
      ]);
      if (r.kind === "meta") return rowEl(null, [div().flex_1().min_w(0).truncate().pl(10).text_color(t.dim).child(r.text)]);
      if (this.split) return rowEl(null, [pane(r.left), div().w(1).flex_none().self_stretch().bg(t.border), pane(r.right)]);
      const tn = r.kind === "add" ? tone.add : r.kind === "del" ? tone.del : { bar: null, bg: null, mid: null };
      return rowEl(tn.bg, [
        bar(tn.bar),
        gutter([num(r.old), num(r.new)]),
        sign(r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ", tn.bar),
        body(r, tn.mid),
      ]);
    };

    // 行数可能上万：只画看得见的那几十行。换行时行高不定，交给 GPUI 自己量。
    const id = this.split ? "filescout-diff-split" : "filescout-diff-unified";
    const rowKey = i => String(i);
    return v_flex().id("filescout-diff").flex_1().min_h(0).relative().overflow_hidden()
      .child(wrap
        ? list(id, rows.length, rowKey, i => view(rows[i]))
        : div().size_full().child(v_virtual_list(id, rows.length, 18, rowKey, range => rows.slice(range.start, range.end).map(view)).size_full()))
      .child(wrap ? Scrollbar.vertical(id).absolute().inset_0() : Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
  }

  /** git diff HEAD 的原始文本；未跟踪的文件整份按新增造一份。 */
  async diffTextFor(path, context) {
    const { cwd: root, on } = context;
    // --no-color：用户 gitconfig 里若写了 color.diff=always，ANSI 码会混进解析器。
    const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "diff", "HEAD", "--no-color", "--unified=3", "--", path], { cwd: root, on }).catch(() => null);
    const text = r?.code === 0 ? r.stdout : "";
    if (text) return text;
    const body = await readTextFile(`${root}/${path}`, { on });
    if (body == null) return "";
    const lines = body.replace(/\n$/, "").split("\n");
    return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)].join("\n");
  }

  /** 解析结果一次写完：渲染看到 diffText 时 rows 一定在，画不出半截。 */
  setDiff(text) {
    const all = text.split("\n"), unified = diffRows(all);
    this.diffRows = { unified, split: splitRows(unified) };
    this.diffStat = {
      added: all.filter(l => l[0] === "+" && !l.startsWith("+++")).length,
      removed: all.filter(l => l[0] === "-" && !l.startsWith("---")).length,
    };
    this.diffText = text;
    this.fileError = null;
  }

  /** 在同一个预览区显示这个文件的改动：git diff HEAD，未跟踪的文件整份算新增。 */
  showDiff(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.text = null; this.image = null; this.diffText = null; this.fileError = null; this.diff = true; this.mdView = false;
    this.diffRows = null; this.diffStat = null;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        const text = await this.diffTextFor(path, context);
        if (!this.current(context) || this.file !== path) return;
        if (!text) { this.fileError = this.L("noDiff"); return; }
        this.setDiff(text);
        // 文件被改了就重算，和预览文本一条路。
        this.watchFile(cx);
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

  rows(prefix, depth, out) {
    if (depth === 0) this.matchCache = this.filter.trim() ? this.buildMatches() : null;
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      if (!this.showHidden && entry.name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      // 文件取自身状态，目录取子树里最严重的那个（Zed 会把状态卷到父目录）；
      // 被 gitignore 的压暗（真实改动优先，所以放在 mark 之后）。
      const mark = entry.dir ? this.dirty.get(path) : this.marks[path];
      if (this.onlyChanged && !mark) continue;
      if (this.matchCache && !(entry.dir ? this.matchCache.dirs.has(path) : this.matchCache.files.has(path))) continue;
      out.push({ path, name: entry.name, dir: entry.dir, depth, open, mark: mark ?? null, ignored: !mark && underIgnored(this.ignored, path) });
      if (entry.dir && (open || this.onlyChanged || this.matchCache)) this.rows(path, depth + 1, out);
    }
    return out;
  }

  /** 树的扁平化结果：虚拟列表每帧都要这数组，以前每帧都重走一遍整棵树、
   *  还顺手重建一份 treeMap。entries / 展开状态 / 标记 / 过滤 / 排序变了才重建
   *  （那些地方都会 treeVer++），平时直接给上一帧那份。 */
  treeRows() {
    if (this.rowCache && this.treeVer === this.rowVer) return this.rowCache;
    const rows = this.rows("", 0, []);
    this.rowCache = rows; this.rowVer = this.treeVer;
    this.treeMap = new Map(rows.map(r => [r.path, r]));
    return rows;
  }

  /** 树的一行。虚拟列表的渲染器里挂不了 handler（宿主直接抛），
   *  所以这里只有样式，点击和右键交给列表上的 on_item_click / on_item_secondary_click。 */
  treeRow(r, t) {
    const color = r.mark ? markColor(r.mark, t) : r.ignored ? t.dim : t.foreground;
    return h_flex().h(28).flex_none().pl(14 + r.depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
      .hover(s => s.bg(t.hover)).tooltip(absolute(this.root ?? "", r.path))
      .child(r.dir ? svg(`mods/filescout/chevron-${r.open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(iconEl(r.name, r.dir, t))
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(r.name))
      .when(Boolean(r.mark), el => el.child(markBall(r.mark, t, r.dir)));
  }

  /** 树那一格：搜索结果、空状态那几句话、普通树。树走虚拟列表——
   *  一万行也只画看得见的那几十行，行数再多也不会把一帧撑爆。 */
  treeArea(t, rows) {
    const hint = (text, size = 12) => div().flex_none().p(8).text_size(size).text_color(t.dim).child(text);
    if (this.results) return v_flex().id("filescout-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
      .when(this.results.length === 0, el => el.child(hint(this.L("noResults"))))
      .children(this.resultRows(t));
    const id = "filescout-tree-list";
    return v_flex().id("filescout-tree").flex_1().min_h(0)
      .child(div().flex_1().min_h(0).relative().overflow_hidden()
        .child(v_virtual_list(id, rows.length, 28, i => rows[i].path, range => rows.slice(range.start, range.end).map(r => this.treeRow(r, t)))
          .on_item_click((key, cx) => this.openRow(key, cx))
          .on_item_secondary_click((key, event, cx) => this.rowMenuOf(key, event, cx)))
        .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0()))
      .when(Boolean(this.error), el => el.child(hint(this.error)))
      .when(!this.error && this.searching, el => el.child(hint(this.L("searching"))))
      .when(!this.error && !this.entries.get("")?.length, el => el.child(hint(this.loading ? this.L("loadingFiles") : this.root ? this.L("noFiles") : this.L("noFolder"))))
      .when(this.limited, el => el.child(hint(this.L("limited"), 11)));
  }

  /** 列表回来的是 key（就是路径）：目录就展开/收起，文件就预览。 */
  openRow(key, cx) {
    const r = this.treeMap?.get(key);
    if (!r) return;
    if (r.dir) this.toggle(r.path, cx);
    else { this.show(r.path, cx); cx.notify(); }
  }

  rowMenuOf(key, event, cx) {
    const r = this.treeMap?.get(key);
    if (r) this.rowMenu(r.path, r.dir, event, cx);
  }

  // ---------- tree controls ----------

  /** 目录优先，再按名称；方向由表头切换。 */
  order(list) {
    return list.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name) * this.sortDir);
  }

  toggleSort(cx) {
    this.sortDir = -this.sortDir;
    for (const list of this.entries.values()) this.order(list);
    this.treeVer++;
    cx.notify();
  }

  toggleHidden(cx) {
    this.showHidden = !this.showHidden;
    this.treeVer++;
    cx.notify();
  }

  toggleChanged(cx) {
    this.onlyChanged = !this.onlyChanged;
    if (this.onlyChanged) this.ensureChangedFolders(cx);
    this.treeVer++;
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
    this.treeVer++;
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
      if (this.diff) out.push(this.chip("filescout-wrap", this.L(this.diffWrap ? "nowrap" : "wrap"), this.L("wrapTip")).on_click((_e, cx) => { this.diffWrap = !this.diffWrap; cx.notify(); }));
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
    this.searchSeq++;
    this.searching = false;
    this.search.set_value("");
    this.filter = "";
    this.results = null;
    this.treeVer++;
    cx.notify();
  }

  /** 回车：搜整个目录（git 仓库走 ls-files，否则 node 递归）。 */
  async searchAll(cx) {
    if (!this.filterTerms().length) return;
    const terms = this.filterTerms(), query = this.filter, seq = ++this.searchSeq;
    const context = this.context, root = this.root, on = this.on;
    this.results = null; this.searching = true; this.error = null; cx.notify();
    let paths;
    try {
      const git = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, on }).catch(() => null);
      paths = git?.code === 0 ? git.stdout.split("\n").filter(Boolean) : await this.walkFiles(root, on);
    } catch (e) { if (this.current(context)) this.error = String(e); paths = []; }
    // 搜到一半用户清了搜索框、改了词或返回了树：这次的结果已经没人要，丢掉。
    if (seq !== this.searchSeq || !this.current(context)) return;
    if (this.filter !== query) { this.searching = false; cx.notify(); return; }
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
          .child(div().truncate().text_size(11).text_color(t.dim).child(dir)))
        .when(Boolean(mark), el => el.child(markBall(mark, t, false)));
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
    this.treeVer++;
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
    // 别的面板（Chat）也会用这个菜单：它会传 view / diff，让「查看」「diff」总在。
    if (m.view) out.push([this.L("view"), () => this.viewFile()]);
    if (m.mark || m.diff) out.push([this.L("diff"), () => this.viewDiff()]);
    out.push([this.L(m.dir ? "openFolder" : "openApp"), () => this.openTarget()]);
    // 远程 space 上没有本机的文件管理器和编辑器，那几项就不出现。
    if (!m.on) {
      out.push([this.L("reveal"), () => this.revealTarget()]);
      const editors = m.editors ?? globalThis.__filescoutEditors ?? [];
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

  /** 菜单里的「查看文件」：单独开一个预览浮窗，不用先切回 Files 面板。 */
  viewFile() {
    const { root, path, on } = this.menu;
    closeOverlay(props().overlay);
    reopen("view", {
      mod: "filescout", kind: "window", frame: "none",
      width: 0.86, height: 0.8,
      props: { lang: this.lang, root, on, file: path },
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
    // 渲染里抛出的异常会变成窗口顶上那条 "This view could not be re-rendered" 红条，
    // 并且一直挂在面板上；自己接住，改成在面板里画一句提示，下一次重绘就能恢复。
    try { return this.paint(cx); }
    catch (e) { return v_flex().size_full().p(12).gap(6).bg(theme().background).text_color(theme().foreground).child("渲染出错（面板没画完）").child(String(e && e.message || e)); }
  }

  paint(cx) {
    if (this.chat) return this.chat.render(cx);
    if (this.mode === "menu") return this.renderMenu(cx);
    if (this.ctxKey() !== this.context?.key) this.refresh(cx);
    this.syncOpen(cx);
    const t = theme(), count = Object.keys(this.marks).length;
    const tools = this.tools(t, count);
    // 看 diff 时表头给的是这个文件的行数，比整个仓库的总数有用。
    const stat = this.diff ? this.diffStat : this.stat;
    return v_flex().id("filescout").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        // 浮窗（放大 / 看 diff）自己拿键盘：Esc 关掉。
        if (this.overlay) { if (e.key === "escape") closeOverlay(this.overlay); return; }
        // 搜索框里打字时别抢键（回车还要提交搜索）。
        if (this.typing) return;
        // 正在看文件（预览 / 图片 / diff）时，回车 = 点标题栏那个 ⤢ 放大。
        if (e.key === "enter" && this.file) { cx.stop_propagation(); this.expand(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("filescout-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("File Scout"))
        .when(count > 0, el => el.child(h_flex().h(18).px(6).items_center().rounded(5).bg(t.surface).text_size(11).text_color(t.dim).child(this.L("files", count))))
        .when(stat?.added > 0, el => el.child(div().text_size(11).text_color(t.ansi2).child(`+${stat.added}`)))
        .when(stat?.removed > 0, el => el.child(div().text_size(11).text_color(t.ansi1).child(`-${stat.removed}`)))
        .when(!this.overlay, el => el.child(div().id("filescout-max").w(18).cursor_pointer().text_color(t.muted).tooltip(this.L("maxTip")).on_click(() => this.expand()).child(svg("mods/filescout/icons/maximize.svg").size(13))))
        .when(Boolean(this.overlay), el => el.child(div().id("filescout-close").cursor_pointer().text_color(t.muted).on_click(() => closeOverlay(this.overlay)).child("✕")))
        .child(this.crumbs(t)))
      .when(tools.length > 0, el => el.child(h_flex().id("filescout-tools").h(30).flex_none().px(9).gap(6).items_center().children(tools)))
      .when(!this.file, el => el.child(this.treeArea(t, this.results ? null : this.treeRows())))
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
