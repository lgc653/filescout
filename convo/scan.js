// convo/scan.js —— 解析某个目录当前的 CodeBuddy 会话，给面板吐 JSON。
// 用法: node scan.js <cwd> [sessionFile] [offset]
// 增量: 传上次的 file + offset，只解析新增的完整行；返回的 offset 是下次的起点。
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = process.env.USERPROFILE || os.homedir();
const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, "");
const slash = (p) => String(p).replace(/\\/g, "/");

function headLine(file) {
  const fd = fs.openSync(file, "r");
  try {
    const b = Buffer.alloc(8192);
    const len = fs.readSync(fd, b, 0, b.length, 0);
    const i = b.indexOf(10);
    return b.slice(0, i > 0 ? i : len).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** 所有 CodeBuddy 会话文件，按修改时间新到旧。 */
function sessions() {
  const root = path.join(HOME, ".codebuddy", "projects");
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try {
      files = fs.readdirSync(path.join(root, d.name));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(root, d.name, f);
      try {
        const st = fs.statSync(full);
        if (st.size) out.push({ full, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 找到 cwd 对应的会话：目录名不可靠（中文、空格原样保留），读首行的 cwd 比。 */
function findSession(cwd) {
  for (const s of sessions()) {
    try {
      const first = JSON.parse(headLine(s.full));
      const c = first.cwd;
      if (c && norm(c) === norm(cwd)) return s;
    } catch {}
  }
  return null;
}

function readTasks(sid) {
  const dir = path.join(HOME, ".codebuddy", "tasks", sid);
  const out = [];
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!t || !t.subject) continue;
      out.push({
        id: String(t.id ?? f.replace(/\.json$/, "")),
        subject: t.subject,
        activeForm: t.activeForm ?? null,
        status: t.status ?? null,
        description: t.description ?? null,
        updatedAt: t.updatedAt ?? 0,
      });
    } catch {}
  }
  const rank = (t) => (t.status === "in_progress" ? 0 : t.status === "pending" ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || (Number(a.id) || 0) - (Number(b.id) || 0));
}

const cwd = path.resolve(process.argv[2] || ".");
const wantFile = process.argv[3] || "";
const from = Math.max(0, Number(process.argv[4]) || 0);

const found = wantFile ? { full: wantFile } : findSession(cwd);
if (!found) {
  process.stdout.write(JSON.stringify({ none: true }));
  process.exit(0);
}

let size = 0;
try {
  size = fs.statSync(found.full).size;
} catch {
  process.stdout.write(JSON.stringify({ none: true }));
  process.exit(0);
}

// 文件被换掉或变短了就从头来。
let start = from;
let reset = false;
if (!(from > 0 && from <= size)) {
  start = 0;
  reset = true;
}

const buf = Buffer.alloc(Math.max(0, size - start));
if (buf.length) {
  const fd = fs.openSync(found.full, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
}
// 只吃完整的行：末尾没写完的那行留到下次。
const cut = buf.lastIndexOf(10);
const text = cut >= 0 ? buf.slice(0, cut).toString("utf8") : "";
const offset = start + (cut >= 0 ? cut + 1 : 0);

const sid = path.basename(found.full).replace(/\.jsonl$/, "");
const acc = {
  sid,
  title: null,
  model: null,
  turns: 0,
  lastAt: 0,
  artifacts: new Map(),
  tasks: new Map(),
};

function touch(p, at, counted) {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const k = abs.toLowerCase();
  const rel = slash(path.relative(cwd, abs));
  const outside = rel.startsWith("..") || path.isAbsolute(rel);
  const e = acc.artifacts.get(k) || { path: abs, rel, edits: 0, last: 0, outside };
  if (counted) e.edits += 1;
  e.last = Math.max(e.last, at || 0);
  acc.artifacts.set(k, e);
}

for (const line of text.split("\n")) {
  if (!line) continue;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  if (r.timestamp) acc.lastAt = Math.max(acc.lastAt, r.timestamp);
  if (r.type === "ai-title" && r.aiTitle) acc.title = r.aiTitle;
  if (r.type === "message" && r.role === "user") acc.turns += 1;
  if (r.type === "function_call") {
    if (r.providerData && r.providerData.model) acc.model = r.providerData.model;
    let a = r.arguments;
    if (typeof a === "string") {
      try {
        a = JSON.parse(a);
      } catch {
        a = null;
      }
    }
    if (!a) continue;
    const p = a.file_path || a.notebook_path;
    if (p && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(r.name)) touch(p, r.timestamp, true);
    if (/^Task(Create|Update)$/.test(r.name)) {
      const id = String(a.taskId ?? a.id ?? "");
      const cur = acc.tasks.get(id) || {};
      acc.tasks.set(id, {
        id,
        subject: a.subject || cur.subject || "",
        status: a.status || cur.status || null,
        activeForm: a.activeForm || cur.activeForm || null,
        description: cur.description ?? null,
        updatedAt: r.timestamp || 0,
      });
    }
  }
  // 宿主自己记的「这次对话动过的文件」：PTC 下 Write/Edit 藏在代码字符串里，只有这份快照抓得到。
  // 快照每次都是全量列举，所以只借它发现路径，次数仍由工具调用算。
  const backups = r.type === "file-history-snapshot" && r.snapshot ? r.snapshot.trackedFileBackups : null;
  if (backups) for (const p of Object.keys(backups)) touch(p, r.timestamp, false);
}

const tasks = readTasks(sid);
const artifacts = [...acc.artifacts.values()].sort((a, b) => b.last - a.last);

process.stdout.write(
  JSON.stringify({
    reset,
    offset,
    size,
    session: {
      id: sid,
      file: found.full,
      title: acc.title,
      model: acc.model,
      turns: acc.turns,
      lastAt: acc.lastAt,
    },
    artifacts,
    tasks,
  }),
);
