#!/usr/bin/env node
/**
 * dsh-wakeup 安装器 —— 把这一包装进本机的 DSH，并把家目录建起来。
 *
 * 目的是「丢进去就能跑」：跑一次这个脚本，插件的四处登记（插件目录、profile 的
 * package.json、bundle 列表、cordis.patch.yml）和家目录都替你办好，剩下只有
 * 一步要人动手 —— 重启 DSH。
 *
 * 为什么必须自己跑 pnpm：DSH 在 profile 里执行的是
 * `pnpm install --frozen-lockfile`（有锁文件的时候）。只往 package.json 里加一行
 * 依赖、不动 pnpm-lock.yaml，那次安装会直接失败。所以这里跑的是完整的一步。
 *
 * 用法:
 *   node install.mjs                        # 自动找 DSH 家目录和 profile；家建在桌面上
 *   node install.mjs --home D:\我的家        # 指定家目录（默认 <桌面>/dsh-home）
 *   node install.mjs --icon D:\形象图.png    # 指定形象图（默认找家目录里的 门面设定.png）
 *   node install.mjs --no-icon              # 不动桌面图标（家还是建在桌面）
 *   node install.mjs --profile desktop      # 指定装进哪个 profile
 *   node install.mjs --dsh-home <dir>       # 指定 DSH 家目录（默认 ~/.dsh；主要给测试用）
 *   node install.mjs --desktop <dir>        # 桌面在哪（默认自动探测；主要给测试用）
 *   node install.mjs --skip-pnpm            # 不跑 pnpm（自己另外装链接时用）
 *   node install.mjs --skip-test            # 不跑冒烟测试
 *   node install.mjs --dry-run              # 只说要做什么，一个字节都不写
 *
 * 家建在桌面上是有意的：新人第一次用最想找的就是「这个家在哪」，
 * 桌上一个看得见的文件夹比一句「在 <主目录>/dsh-home」管用。
 * 给了形象图（`门面设定.png`），安装器还会顺手把它做成那个文件夹的图标 ——
 * 桌面上于是坐着一张脸，不是一个黄文件夹。
 *
 * 幂等：重复跑不会重复写。改任何已有文件之前都会先备份一份 `.bak-wakeup-<时间戳>`。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_NAME = "dsh-wakeup";
const BUNDLE_ID = "wakeup";

// ------------------------------------------------------------------ 参数
function parseArgs(argv) {
  const out = { dryRun: false, skipPnpm: false, skipTest: false, icon: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--skip-pnpm") out.skipPnpm = true;
    else if (arg === "--skip-test") out.skipTest = true;
    else if (arg === "--no-icon") out.icon = false;
    else if (arg === "--home") out.home = argv[++i];
    else if (arg === "--icon") { out.icon = true; out.iconFile = argv[++i]; }
    else if (arg === "--desktop") out.desktop = argv[++i];
    else if (arg === "--profile") out.profile = argv[++i];
    else if (arg === "--dsh-home") out.dshHome = argv[++i];
    else if (arg === "-h" || arg === "--help") out.help = true;
    else out.unknown = arg;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const log = (...parts) => console.log(...parts);
const step = text => log(`\n== ${text}`);
const say = (mark, text) => log(`  ${mark} ${text}`);

if (args.help || args.unknown) {
  if (args.unknown) log(`不认识的参数: ${args.unknown}`);
  log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].split("\n").slice(2).join("\n"));
  process.exit(args.unknown ? 2 : 0);
}

const stamp = () => {
  const now = new Date();
  const pad = v => String(v).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

// ------------------------------------------------------------------ 桌面在哪
/**
 * 桌面路径。Windows 上先问 .NET —— OneDrive 把桌面挪走过、用户名是中文的机器，
 * 只有它能答对；问不出来（或非 Windows）就按常见位置猜。
 */
function findDesktop() {
  if (args.desktop) return resolve(args.desktop);
  if (process.platform === "win32") {
    const probe = spawnSync("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')",
    ], { encoding: "utf8", timeout: 30000 });
    const found = (probe.stdout || "").trim();
    if (probe.status === 0 && found && existsSync(found)) return found;
  }
  const guesses = [
    join(homedir(), "Desktop"),
    join(homedir(), "OneDrive", "Desktop"),
    join(homedir(), "桌面"),
  ];
  for (const candidate of guesses) if (existsSync(candidate)) return candidate;
  return join(homedir(), "Desktop");
}

// ------------------------------------------------------------------ 探路
step("1/8 找 DSH、profile 和桌面");

const dshHome = resolve(args.dshHome || process.env.DSH_HOME || join(homedir(), ".dsh"));
if (!existsSync(dshHome)) {
  log(`找不到 DSH 家目录: ${dshHome}`);
  log("DSH 装过吗？装过的话用 --dsh-home 指一下它的位置（一般是 <用户主目录>/.dsh）。");
  process.exit(1);
}
say("ok", `DSH 家目录: ${dshHome}`);

const profilesDir = join(dshHome, "profiles");
if (!existsSync(profilesDir)) {
  log(`没有 profiles 目录: ${profilesDir} —— 这台机器上的 DSH 还没建过 profile？`);
  process.exit(1);
}
const profiles = readdirSync(profilesDir)
  .filter(name => existsSync(join(profilesDir, name, "package.json")))
  .sort();

let profileName = args.profile;
if (profileName && !profiles.includes(profileName)) {
  log(`指定的 profile 不存在: ${profileName}（这台机器上有: ${profiles.join(", ") || "无"}）`);
  process.exit(1);
}
if (!profileName) {
  if (profiles.includes("desktop")) profileName = "desktop";
  else if (profiles.length === 1) profileName = profiles[0];
  else {
    log(`这台机器上有多个 profile: ${profiles.join(", ")}`);
    log("用 --profile <名字> 指定装进哪个。");
    process.exit(1);
  }
}
const profileDir = join(profilesDir, profileName);
say("ok", `profile: ${profileName}  (${profileDir})`);

const pluginDir = join(dshHome, "plugins", PLUGIN_NAME);
const desktopDir = findDesktop();
const home = resolve(args.home || join(desktopDir, "dsh-home"));
say("ok", `桌面: ${desktopDir}`);
say("ok", `家目录: ${home}`);
say("ok", `插件将放在: ${pluginDir}`);
if (args.dryRun) say("--", "dry-run：下面只报告，不写盘");

// ------------------------------------------------------------------ 备份 + 写
const backups = [];
function backup(file) {
  if (!existsSync(file)) return;
  const target = `${file}.bak-wakeup-${stamp()}`;
  if (!args.dryRun) cpSync(file, target);
  backups.push(target);
  return target;
}

function writeJson(file, data) {
  backup(file);
  if (!args.dryRun) writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// ------------------------------------------------------------------ 2. 插件文件
step("2/8 放插件文件");

const sameDir = existsSync(pluginDir) && (() => {
  try {
    return realpathSync(pluginDir) === realpathSync(SELF_DIR);
  } catch {
    return false;
  }
})();

if (sameDir) {
  say("ok", "已经在位（就是从这儿跑的），跳过复制");
} else if (args.dryRun) {
  say("--", `会把 ${SELF_DIR} 复制到 ${pluginDir}`);
} else {
  mkdirSync(pluginDir, { recursive: true });
  cpSync(SELF_DIR, pluginDir, { recursive: true, force: true });
  say("ok", `已复制到 ${pluginDir}`);
}

const libEntry = join(pluginDir, "lib", "index.js");
if (!args.dryRun && !existsSync(libEntry)) {
  log(`复制完却找不到 ${libEntry} —— 包装全了吗？`);
  process.exit(1);
}

// ------------------------------------------------------------------ 3. profile/package.json
step("3/8 登记进 profile");

const pkgFile = join(profileDir, "package.json");
const pkg = readJson(pkgFile);
pkg.dependencies = pkg.dependencies || {};
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];

// 依赖写成相对 profile 的路径，别写死 ../../ —— 布局不一样也能对
let spec = relative(profileDir, pluginDir).replace(/\\/g, "/");
if (!spec.startsWith(".")) spec = `./${spec}`;

const before = JSON.stringify(pkg);
if (pkg.dependencies[PLUGIN_NAME] !== `file:${spec}`) {
  pkg.dependencies[PLUGIN_NAME] = `file:${spec}`;
  say("ok", `dependencies["${PLUGIN_NAME}"] = "file:${spec}"`);
} else {
  say("ok", `dependencies 里已有 ${PLUGIN_NAME}（file:${spec}）`);
}
if (!pkg.dsh.profile.bundles.includes(PLUGIN_NAME)) {
  pkg.dsh.profile.bundles.push(PLUGIN_NAME);
  say("ok", `bundles 里加上 ${PLUGIN_NAME}`);
} else {
  say("ok", `bundles 里已有 ${PLUGIN_NAME}`);
}
if (JSON.stringify(pkg) !== before) writeJson(pkgFile, pkg);
else say("ok", "package.json 无需改动");

// ------------------------------------------------------------------ 4. cordis.patch.yml
step("4/8 写 profile 配置");

const patchFile = join(profileDir, "cordis.patch.yml");
const patchText = existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
const hasRow = new RegExp(`^\\s*-\\s*id:\\s*${BUNDLE_ID}\\s*$`, "m").test(patchText);
// home 一定写进去：家现在默认建在桌面，插件自己兜底的 <主目录>/dsh-home 对不上。
const row = [
  `- id: ${BUNDLE_ID}`,
  `  name: ${PLUGIN_NAME}`,
  "  config:",
  `    home: ${home}`,
  "",
].join("\n");

if (hasRow) {
  say("ok", "cordis.patch.yml 里已经有 wakeup 那行，不动它");
  say("--", `家在哪以那一行为准，这次要建的是 ${home} —— 对不上就自己改那一行的 home`);
} else if (args.dryRun) {
  say("--", `会往 ${patchFile} 追加:\n${row.split("\n").map(l => `       ${l}`).join("\n")}`);
} else {
  backup(patchFile);
  const head = patchText.trimEnd();
  const merged = `${head || "# dsh profile patch layer"}\n\n${row}`;
  writeFileSync(patchFile, merged, "utf8");
  say("ok", `已追加 wakeup 那行（home: ${home}）`);
}

// ------------------------------------------------------------------ 5. pnpm
step("5/8 装链接（pnpm install）");

function findRuntime(dsh, kind) {
  // DSH 自带了 node / pnpm，优先用它们，省得要求用户装
  const runtimes = join(dsh, "dsh-runtimes");
  if (!existsSync(runtimes)) return null;
  for (const name of readdirSync(runtimes).sort().reverse()) {
    const base = join(runtimes, name, "dependencies");
    const candidate = kind === "pnpm"
      ? join(base, "pnpm", "bin", "pnpm.mjs")
      : join(base, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const pnpmMjs = findRuntime(dshHome, "pnpm");
const nodeExe = findRuntime(dshHome, "node");

if (args.skipPnpm) {
  say("--", "按要求跳过 pnpm。记得自己补一步: pnpm install（在 profile 目录里）");
} else if (args.dryRun) {
  say("--", `会在 ${profileDir} 里跑 pnpm install`);
} else if (pnpmMjs && nodeExe) {
  say("ok", `用 DSH 自带的 pnpm: ${pnpmMjs}`);
  const result = spawnSync(nodeExe, [pnpmMjs, "install"], {
    cwd: profileDir,
    stdio: "inherit",
    timeout: 10 * 60 * 1000,
  });
  if (result.status === 0) say("ok", "pnpm install 成功");
  else {
    say("!!", `pnpm install 退出码 ${result.status ?? result.error?.message}`);
    log(`     自己在 profile 目录里补一次: cd "${profileDir}" && pnpm install`);
  }
} else {
  const result = spawnSync("pnpm", ["install"], { cwd: profileDir, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status === 0) say("ok", "pnpm install 成功（用的 PATH 里的 pnpm）");
  else {
    say("!!", "没找到可用的 pnpm（DSH 自带的和 PATH 里的都没有）");
    log(`     装好 pnpm 后在这个目录里跑一次: cd "${profileDir}" && pnpm install`);
  }
}

// ------------------------------------------------------------------ 6. 家目录
step("6/8 建家目录");

// 模板优先用已就位的（真跑完复制之后）；dry-run / 原地跑时就用自己这份
const templateDir = existsSync(join(pluginDir, "示例家"))
  ? join(pluginDir, "示例家")
  : join(SELF_DIR, "示例家");
const homeExists = existsSync(home);
const homeHasContent = homeExists && readdirSync(home).length > 0;
let fresh = false;

if (!homeExists) {
  if (!args.dryRun) mkdirSync(home, { recursive: true });
  if (existsSync(templateDir)) {
    if (!args.dryRun) cpSync(templateDir, home, { recursive: true, force: true });
    say("ok", `家目录已建好，用 示例家/ 起了个头: ${home}`);
    fresh = true;
  } else {
    say("--", `家目录建好了，但没找到模板: ${templateDir}`);
  }
} else if (!homeHasContent) {
  if (existsSync(templateDir)) {
    if (!args.dryRun) cpSync(templateDir, home, { recursive: true, force: true });
    say("ok", `家目录是空的，用 示例家/ 起了个头: ${home}`);
    fresh = true;
  }
} else {
  say("--", `家目录里已经有东西，一个字没动: ${home}`);
}

// 刚起的头，就在 README 里留一段「接入还没做完」——
// README 在起床清单里，所以每开一段新对话 AI 都会看到它，自己接着把采访做完。
const homeReadme = join(home, "README.md");
const marker = "【接入还没做完】";
if (fresh && existsSync(homeReadme) && !args.dryRun) {
  const text = readFileSync(homeReadme, "utf8");
  if (!text.includes(marker)) {
    const block = [
      "",
      "---",
      "",
      `${marker} 这个家现在还是模板，人格一个字没填。`,
      "",
      `请 AI 读 ${join(pluginDir, "接入问答.md")}，**一次只问主人一道题**，`,
      "把答案写进 灵魂设定.md / 说话的规矩.md / 错题集.md 等文件，写完把这一段删掉。",
      "别替主人编答案；答不上来的跳过。",
      "",
    ].join("\n");
    writeFileSync(homeReadme, `${text.trimEnd()}\n${block}`, "utf8");
    say("ok", "已在家的 README 里留下「接入还没做完」，重启后 AI 自己会接着做");
  }
}

// ------------------------------------------------------------------ 7. 桌面图标
step("7/8 给桌面那个家换张脸");

/**
 * 把一张图做成 .ico。
 *
 * Windows 上先借 PowerShell + System.Drawing 缩到 256×256 再存 —— 缩放和透明交给系统，
 * 这是正经做法。跑不动（没 PowerShell / 被沙箱拦）就退回自己拼一个 PNG-in-ICO：
 * ICO 目录项里塞一段 PNG 数据，Vista 之后的 Windows 认这个格式。
 */
function makeIcon(source, icoPath) {
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Drawing",
      "$src=[System.Drawing.Image]::FromFile($env:DSH_WAKEUP_PNG)",
      "$size=256",
      "$bmp=New-Object System.Drawing.Bitmap($size,$size)",
      "$g=[System.Drawing.Graphics]::FromImage($bmp)",
      "$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
      "$g.Clear([System.Drawing.Color]::Transparent)",
      "$g.DrawImage($src,0,0,$size,$size)",
      "$g.Dispose()",
      "$ico=[System.Drawing.Icon]::FromHandle($bmp.GetHicon())",
      "$fs=[System.IO.File]::Create($env:DSH_WAKEUP_ICO)",
      "$ico.Save($fs)",
      "$fs.Close()",
      "$src.Dispose();$bmp.Dispose()",
    ].join("; ");
    const done = spawnSync("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ], {
      stdio: "ignore",
      timeout: 60 * 1000,
      env: { ...process.env, DSH_WAKEUP_PNG: source, DSH_WAKEUP_ICO: icoPath },
    });
    if (done.status === 0 && existsSync(icoPath)) return "系统缩放";
  }
  const png = readFileSync(source);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  writeFileSync(icoPath, Buffer.concat([header, entry, png]));
  return "PNG 直接嵌";
}

/** 家是不是就建在桌面上（决定「改文件夹图标」还是只留个 ico）。 */
const homeInDesktop = (() => {
  const rel = relative(desktopDir, home);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
})();

const iconCandidates = [
  args.iconFile ? resolve(args.iconFile) : null,
  join(home, "门面设定.png"),
  join(home, "门面设定.jpg"),
  join(home, "门面设定.jpeg"),
  join(home, "门面设定.webp"),
].filter(Boolean);
const iconSource = iconCandidates.find(candidate => existsSync(candidate)) || null;
const icoPath = join(home, "门面图标.ico");

if (!args.icon) {
  say("--", "按要求不动图标（--no-icon）");
} else if (!iconSource) {
  say("--", "家里没有形象图。放一张 门面设定.png 进去，再跑一次 install.mjs，桌面那个家就有脸了");
} else if (args.dryRun) {
  say("--", `会拿 ${iconSource} 做图标 → ${icoPath}`);
  if (homeInDesktop) say("--", `会给它写 desktop.ini，把 ${home} 的图标指过去`);
} else {
  const how = makeIcon(iconSource, icoPath);
  say("ok", `图标做好了（${how}）: ${icoPath}`);
  if (process.platform !== "win32") {
    say("--", "文件夹换图标这套只有 Windows 认；图标文件放好了，别的系统自己指");
  } else if (homeInDesktop) {
    const ini = join(home, "desktop.ini");
    const text = `[.ShellClassInfo]\r\nIconResource=${icoPath},0\r\n`;
    // desktop.ini 用 UTF-16LE + BOM：路径里带中文时，Explorer 也读得对
    writeFileSync(ini, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    spawnSync("attrib", ["+s", "+h", ini], { stdio: "ignore" });
    spawnSync("attrib", ["+r", home], { stdio: "ignore" });
    say("ok", `桌面那个家的图标指过去了: ${home}`);
    say("--", "资源管理器按 F5 刷新一下；还是黄文件夹就换张方的、大一点的图重跑");
  } else {
    say("--", `家不在桌面（${home}），图标只留在家目录里`);
    say("--", "想让它出现在桌面：用 --home 指到桌面重建，或者右键文件夹 → 属性 → 自定义 → 改图标");
  }
  if (fresh) say("--", "那张形象图留在家里（门面设定.png）别删 —— AI 画自己的时候照着它来");
}

// ------------------------------------------------------------------ 8. 冒烟测试
step("8/8 验一下");

if (args.skipTest || args.dryRun) {
  say("--", "跳过测试");
} else {
  const runner = nodeExe || process.execPath;
  const result = spawnSync(runner, [join(pluginDir, "test", "smoke.mjs")], {
    cwd: pluginDir,
    stdio: "inherit",
    timeout: 2 * 60 * 1000,
  });
  say(result.status === 0 ? "ok" : "!!", `冒烟测试退出码 ${result.status}`);
}

// ------------------------------------------------------------------ 收尾
log("\n--------------------------------------------");
if (args.dryRun) {
  log("dry-run 结束，什么都没写。");
} else {
  log("装完了。剩下两步：");
  log("");
  log("  1) 重启 DSH —— 这一步必须有人动手（重启会断开当前对话）。");
  log("  2) 重启后新开一段对话。如果家里还是模板，开头的起床包里会出现");
  log("     「【接入还没做完】」，照着那段把采访做完就行。");
  log("");
  log(`  家目录：${home}`);
  if (args.icon && iconSource && process.platform === "win32" && homeInDesktop) {
    log("  桌面那个家的图标已经换成你给的图了（没变就在桌面按一下 F5）。");
  } else if (args.icon && !iconSource) {
    log("  想让桌面那个家有一张脸：把形象图存成 门面设定.png 丢进家目录，再跑一次 install.mjs。");
  }
  log("");
  log(`  备份（改过的文件都留了一份）: ${backups.length ? backups.join(", ") : "无（没有改动已有文件）"}`);
  log(`  出问题要卸掉：把 ${pluginDir} 删掉，再从 profile 的 package.json 里`);
  log(`  去掉 "${PLUGIN_NAME}" 两处（dependencies 和 bundles），最后在`);
  log(`  ${profileDir} 里跑一次 pnpm install。`);
}
log("--------------------------------------------");