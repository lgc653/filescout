// convo —— Herdr 右侧面板的 Chat 标签：把当前 CodeBuddy 会话的产物和子任务摊开看。
// 数据：~/.codebuddy/projects/<slug>/<sid>.jsonl 与 ~/.codebuddy/tasks/<sid>/*.json，
// 由同目录的 scan.js 解析（node 跑，首次全量约 0.2s，之后按 offset 增量）。
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  spaces, panes, focused, exec, appHome, theme, watchFolder, openOverlay, props,
} from "herdr";

const SCAN = `${appHome()}/mods/convo/scan.js`.replace(/\\/g, "/");

const T = {
  zh: {
    refresh: "重新解析", artifacts: "产物", tasks: "子任务", turns: "轮", now: "刚刚",
    untitled: "未命名对话", other: "工作区外",
    noAgent: "这个标签里没有在跑的 agent", onlyCodeBuddy: "只解析 CodeBuddy 的对话",
    noSession: "这个目录还没有 CodeBuddy 会话", loading: "正在解析…",
    failed: "解析失败", empty: "这次对话还没有产物或子任务",
  },
  en: {
    refresh: "Re-read", artifacts: "Artifacts", tasks: "Tasks", turns: "turns", now: "just now",
    untitled: "Untitled chat", other: "Outside",
    noAgent: "No agent running in this tab", onlyCodeBuddy: "Only CodeBuddy chats are read",
    noSession: "No CodeBuddy chat in this folder yet", loading: "Reading…",
    failed: "Failed", empty: "Nothing written or planned in this chat yet",
  },
};

// 文件图标借用 filescout 那套（Material，MIT），认不出的用通用文档图标。
const ICON = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "react", tsx: "react",
  ts: "typescript", mts: "typescript", cts: "typescript", vue: "vue", svelte: "svelte",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", rb: "ruby", php: "php",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", swift: "swift", lua: "lua",
  html: "html", htm: "html", css: "css", scss: "sass", less: "less",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",
  md: "markdown", mdx: "markdown", sh: "console", bash: "console", zsh: "console", ps1: "console",
  svg: "svg", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", ico: "image",
  pdf: "pdf", zip: "zip", lock: "lock",
};

const extOf = (p) => {
  const name = String(p).split(/[\\/]/).pop() ?? "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/** 日期时间一律纯数字：当天给 14:05，同年给 11-17，更早给 2025-11-03。 */
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  const two = (n) => String(n).padStart(2, "0");
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const md = `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

const statusColor = (s) =>
  s === "working" ? "#42a5f5" : s === "blocked" ? "#ef5350" : s === "done" ? "#66bb6a" : "#9e9e9e";

/** 当前窗口这个标签里在跑的 agent。点了右侧面板后 focused().pane 会变 null，
 *  但 tab 仍是窗口上下文，所以按 tab 找 pane。 */
function target() {
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

export default class Convo extends View {
  init(_p, cx) {
    const p = props() ?? {};
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
    this.target = target();
    this.signature = this.sigOf(this.target);
    this.load(cx, true);
    // agent 换标签 / 换目录 / 状态变化：定时看，watch 只看得到文件。
    cx.timer.every(4000, (cx) => this.follow(cx));
  }

  T(key) {
    return T[this.lang][key] ?? T.zh[key] ?? key;
  }

  /** 一分钟内算「刚刚」，之后按纯数字日期走。 */
  ago(ts) {
    return ts && Date.now() - ts < 60000 ? this.T("now") : fmtTime(ts);
  }

  sigOf(t) {
    return `${t.tab}|${t.cwd}|${t.app}`;
  }

  follow(cx) {
    const next = target();
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
      this.reason = "noAgent";
      this.loading = false;
      cx.notify();
      return;
    }
    if (!/codebuddy/i.test(tg.app ?? "")) {
      this.data = null;
      this.reason = "onlyCodeBuddy";
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
      const r = await exec("node", [SCAN, tg.cwd, this.file ?? "", String(this.offset)], { timeout: 20000 });
      if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
      const d = JSON.parse(r.stdout);
      this.error = null;
      if (d.none) {
        this.data = null;
        this.reason = "noSession";
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

  // ---------- 交互 ----------

  /** 独立打开：不切 Files 面板，直接开一个 filescout 预览浮窗。 */
  preview(a) {
    const { root, file } = this.locate(a);
    openOverlay({
      mod: "filescout", kind: "window", frame: "none", key: "convo-preview",
      width: 0.86, height: 0.8,
      props: { lang: this.lang, root, on: null, file },
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

  // ---------- 视图 ----------

  header(t) {
    const n = this.data ? this.data.artifacts.size : 0;
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Chat"))
      .when(n > 0, (el) => el.child(h_flex().h(18).px(6).items_center().rounded(5).bg(t.surface)
        .text_size(11).text_color(t.dim).child(String(n))))
      .child(div().flex_1())
      .when(Boolean(this.target?.status), (el) => el.child(div().size(6).rounded(3).bg(statusColor(this.target.status))))
      .child(div().id("convo-refresh").w(18).cursor_pointer().text_color(t.muted).tooltip(this.T("refresh"))
        .on_click((_e, cx) => { cx.stop_propagation(); this.load(cx, true); }).child("↻"));
  }

  emptyText() {
    if (this.error) return `${this.T("failed")}: ${this.error}`;
    if (this.reason === "noAgent") return this.T("noAgent");
    if (this.reason === "onlyCodeBuddy") return this.T("onlyCodeBuddy");
    if (this.reason === "noSession") return this.T("noSession");
    return this.T("loading");
  }

  card(t, s) {
    return v_flex().gap(4).p(9).rounded(7).bg(t.surface)
      .child(div().truncate().font_semibold().child(s.title || this.T("untitled")))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .when(Boolean(this.target?.program), (el) => el.child(div().child(this.target.program)))
        .when(Boolean(s.model), (el) => el.child(div().child(s.model)))
        .child(div().child(`${s.turns} ${this.T("turns")}`))
        .child(div().flex_1())
        .child(div().child(this.ago(s.lastAt))))
      .child(div().text_size(11).text_color(t.dim).truncate().tooltip(s.file).child(this.target?.cwd ?? ""));
  }

  artifactRow(t, a, i) {
    const icon = ICON[extOf(a.path)] ?? "document";
    return h_flex().id(`convo-a-${i}`).h(24).px(6).gap(7).items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(a.path)
      .on_click((_e, cx) => { cx.stop_propagation(); this.preview(a); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(a); })
      .child(svg(`mods/filescout/icons/${icon}.svg`).size(13).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_color(a.outside ? t.muted : t.foreground).child(a.rel))
      .when(a.edits > 1, (el) => el.child(div().text_size(10).text_color(t.dim).child(`×${a.edits}`)))
      .child(div().text_size(10).text_color(t.dim).child(this.ago(a.last)));
  }

  taskRow(t, task, i) {
    const c = task.status === "completed" ? "#66bb6a" : task.status === "in_progress" ? "#ffb74d" : t.dim;
    return h_flex().id(`convo-t-${i}`).h(24).px(6).gap(7).items_center().rounded(5)
      .when(Boolean(task.description), (el) => el.tooltip(task.description))
      .child(div().size(6).flex_none().rounded(3).bg(c))
      .child(div().flex_1().min_w(0).truncate()
        .text_color(task.status === "completed" ? t.muted : t.foreground)
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
      rows.push(this.section(t, `${this.T("artifacts")} ${inner.length}`, inner.map((a, i) => this.artifactRow(t, a, i))));
    }
    if (outer.length > 0) {
      const head = h_flex().h(22).items_center().gap(4).cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); this.expanded = !this.expanded; cx.notify(); })
        .child(svg(`mods/filescout/chevron-${this.expanded ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().text_size(11).text_color(t.dim).child(`${this.T("other")} ${outer.length}`));
      const box = v_flex().gap(1).child(head);
      if (this.expanded) box.children(outer.map((a, i) => this.artifactRow(t, a, 1000 + i)));
      rows.push(box);
    }
    if (tasks.length > 0) {
      rows.push(this.section(t, `${this.T("tasks")} ${done}/${tasks.length}`, tasks.map((x, i) => this.taskRow(t, x, i))));
    }
    if (arts.length === 0 && tasks.length === 0) {
      rows.push(div().text_size(12).text_color(t.dim).child(this.T("empty")));
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
    return v_flex().id("convo").size_full().min_h(0).rounded(10).overflow_hidden().track_focus(this.handle)
      .bg(t.background).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .child(this.content(t, cx));
  }
}
