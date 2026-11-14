#!/usr/bin/env node
/**
 * 把墨观 Inkstone（https://github.com/Konata9/inkstone）的六个变体导出成
 * herdr 的主题文件。
 *
 *   node scripts/inkstone-themes.mjs                  # 克隆最新版，写到 ~/.config/herdr-app/themes
 *   node scripts/inkstone-themes.mjs --src ../inkstone # 用已有 checkout
 *   node scripts/inkstone-themes.mjs --dry-run         # 只打印，不落盘
 *
 * 色值不手抄：直接跑 inkstone 自己的 src/palette（soften() 的降彩计算在里面），
 * 拿到解析后的语义色板和 16 色 ANSI，再映射到 herdr 的颜色槽。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "https://github.com/Konata9/inkstone.git";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const dryRun = args.includes("--dry-run");
const outDir = flag("--out") ?? join(homedir(), ".config", "herdr-app", "themes");
let src = flag("--src");
let cleanup = null;

if (!src) {
  src = mkdtempSync(join(tmpdir(), "inkstone-"));
  console.error(`cloning ${REPO} -> ${src}`);
  execFileSync("git", ["clone", "--depth", "1", REPO, src], { stdio: "inherit" });
  cleanup = src;
}

try {
  if (!statSync(join(src, "src", "palette", "index.ts")).isFile()) {
    throw new Error(`${src} 不像 inkstone 仓库（缺 src/palette/index.ts）`);
  }

  // node 22+ 能直接跑 .ts（type stripping），不用装 tsx。
  const probe = join(src, "__dump-palette.mjs");
  writeFileSync(
    probe,
    'import { flavors } from "./src/palette/index.ts";\n' +
      "console.log(JSON.stringify(flavors));\n",
  );
  let json;
  try {
    json = execFileSync(process.execPath, ["--experimental-strip-types", probe], {
      cwd: src,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } finally {
    unlinkSync(probe);
  }

  const flavors = JSON.parse(json);
  if (!dryRun) mkdirSync(outDir, { recursive: true });

  for (const f of flavors) {
    const name = `inkstone-${f.meta.id}`;
    const theme = {
      background: f.surface.base,
      foreground: f.text.primary,
      selection: f.surface.selection,
      cursor: f.text.cursor,
      ansi: f.ansi,
      colors: {
        background: f.surface.base,
        canvas: f.surface.sunken,
        chrome: f.surface.alt,
        surface: f.surface.base,
        popover: f.surface.overlay,
        raised: f.surface.raised,
        hover: f.surface.hover,
        selected: f.surface.active,
        border: f.border.normal,
        input: f.border.strong,
        foreground: f.text.primary,
        muted: f.text.secondary,
        dim: f.text.faint,
        accent: f.action,
        accent_foreground: f.text.inverse,
        solid: f.action,
        solid_foreground: f.text.inverse,
        selection: f.surface.selection,
        working: f.status.warning,
        blocked: f.status.error,
        done: f.status.success,
        idle: f.text.muted,
        unknown: f.text.faint,
      },
    };
    const file = join(outDir, `${name}.json`);
    const text = JSON.stringify(theme, null, 2) + "\n";
    if (dryRun) {
      console.log(`${name} (${f.meta.appearance}) ${f.surface.base}`);
    } else {
      writeFileSync(file, text);
      console.log(`wrote ${file}`);
    }
  }

  console.log(`\n${flavors.length} themes -> ${dryRun ? "(dry run)" : outDir}`);
  console.log("在 herdr 设置里选；浅色变体要把 appearance 调成 light 才看得到。");
} finally {
  if (cleanup) rmSync(cleanup, { recursive: true, force: true });
}
