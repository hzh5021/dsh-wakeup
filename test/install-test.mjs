#!/usr/bin/env node
/**
 * 安装器的自测：在一台「假 DSH」上跑一遍 install.mjs，看它有没有按说的办。
 *
 * 不碰你真实的 DSH —— 全部动作都发生在临时目录里搭的假环境上，
 * 而且用 --skip-pnpm（真 pnpm 留给真实安装那一步）。
 *
 * 跑法:
 *   node test/install-test.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALLER = join(PACKAGE_DIR, "install.mjs");

const root = mkdtempSync(join(tmpdir(), "dsh-wakeup-install-"));
const fakeDsh = join(root, ".dsh");
const profileDir = join(fakeDsh, "profiles", "desktop");
const home = join(root, "我的家");
const desktop = join(root, "桌面");

mkdirSync(profileDir, { recursive: true });
mkdirSync(join(fakeDsh, "plugins"), { recursive: true });
mkdirSync(desktop, { recursive: true });

const pkgFile = join(profileDir, "package.json");
const patchFile = join(profileDir, "cordis.patch.yml");
const lockFile = join(profileDir, "pnpm-lock.yaml");

writeFileSync(pkgFile, `${JSON.stringify({
  name: "dsh-profile-desktop",
  private: true,
  dependencies: { "dsh-ops": "^0.3.0" },
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-ops"] } },
}, null, 2)}\n`, "utf8");
writeFileSync(patchFile, [
  "# 假 profile 的补丁层",
  "- id: ui-chat",
  "  name: \"@deepseek-ai/dsh-client-ui-chat\"",
  "  config:",
  "    performanceUsage: compact",
  "",
].join("\n"), "utf8");
writeFileSync(lockFile, "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n", "utf8");

/**
 * 跑一次安装器。
 *
 * 注意 stdio 用 inherit —— 沙箱里不允许「管道抓子进程输出」（会 EPERM），
 * 所以这个测试一个字都不抓它的输出，只看退出码和文件系统。
 */
const run = extra => spawnSync(process.execPath, [
  INSTALLER,
  "--dsh-home", fakeDsh,
  "--home", home,
  "--profile", "desktop",
  "--desktop", desktop,
  "--skip-pnpm",
  ...extra,
], { stdio: "inherit" });

const results = [];
const check = (label, fn) => {
  try {
    fn();
  } catch (error) {
    process.exitCode = 1;
    console.log(`  FAIL - ${label}: ${error.message}`);
    results.push(false);
    return;
  }
  console.log(`  ok - ${label}`);
  results.push(true);
};

console.log("dsh-wakeup install-test\n");

// ------------------------------------------------------------ dry-run 不写盘
const dry = run(["--dry-run"]);
check("dry-run 退出码 0", () => assert.equal(dry.status, 0, `status=${dry.status} ${dry.error?.message || ""}`));
check("dry-run 不复制插件", () => assert.ok(!existsSync(join(fakeDsh, "plugins", "dsh-wakeup"))));
check("dry-run 不改 package.json", () => {
  assert.ok(!JSON.parse(readFileSync(pkgFile, "utf8")).dependencies["dsh-wakeup"]);
});
check("dry-run 不建家目录", () => assert.ok(!existsSync(home)));

// ------------------------------------------------------------------ 真跑一遍
const first = run([]);
check("安装退出码 0", () => assert.equal(first.status, 0, `status=${first.status} ${first.error?.message || ""}`));
check("插件已复制到 plugins/dsh-wakeup", () => {
  assert.ok(existsSync(join(fakeDsh, "plugins", "dsh-wakeup", "lib", "index.js")));
  assert.ok(existsSync(join(fakeDsh, "plugins", "dsh-wakeup", "示例家", "灵魂设定.md")));
});

const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
check("dependencies 加了 dsh-wakeup（相对路径）", () => {
  assert.match(pkg.dependencies["dsh-wakeup"], /^file:\.\.\/\.\.\/plugins\/dsh-wakeup$/);
});
check("bundles 加了 dsh-wakeup", () => assert.ok(pkg.dsh.profile.bundles.includes("dsh-wakeup")));
check("原有依赖没被弄丢", () => assert.equal(pkg.dependencies["dsh-ops"], "^0.3.0"));
check("原有 bundles 没被弄丢", () => {
  assert.ok(pkg.dsh.profile.bundles.includes("@deepseek-ai/dsh-base"));
  assert.ok(pkg.dsh.profile.bundles.includes("dsh-ops"));
});

const patch = readFileSync(patchFile, "utf8");
check("cordis.patch.yml 追加了 wakeup 行", () => assert.match(patch, /^- id: wakeup$/m));
check("cordis.patch.yml 写上了 home", () => assert.ok(patch.includes(home)));
check("cordis.patch.yml 原有内容还在", () => assert.ok(patch.includes("- id: ui-chat")));

check("pnpm-lock.yaml 一个字没动（该由 pnpm 自己改）", () => {
  assert.equal(readFileSync(lockFile, "utf8"), "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n");
});
check("家目录建起来了", () => {
  assert.ok(existsSync(join(home, "灵魂设定.md")));
  assert.ok(existsSync(join(home, "说话的规矩.md")));
  assert.ok(existsSync(join(home, "日记")));
});
check("家的 README 里有「接入还没做完」标记", () => {
  assert.ok(readFileSync(join(home, "README.md"), "utf8").includes("【接入还没做完】"));
});
check("插件自己还能跑（冒烟测试退出码 0）", () => {
  const smoke = spawnSync(process.execPath, [join(fakeDsh, "plugins", "dsh-wakeup", "test", "smoke.mjs")], {
    cwd: join(fakeDsh, "plugins", "dsh-wakeup"),
    stdio: "inherit",
  });
  assert.equal(smoke.status, 0, `status=${smoke.status}`);
});
check("改过的文件都有备份", () => {
  const backups = readdirSync(profileDir).filter(n => n.includes(".bak-wakeup-"));
  assert.ok(backups.length >= 2, `只找到 ${backups.length} 个备份`);
});

// ------------------------------------------------------------------ 再跑一遍
const second = run([]);
check("重复安装仍然退出码 0", () => assert.equal(second.status, 0, `status=${second.status}`));
const pkg2 = JSON.parse(readFileSync(pkgFile, "utf8"));
check("重复安装没有塞第二份依赖", () => {
  assert.equal(pkg2.dsh.profile.bundles.filter(b => b === "dsh-wakeup").length, 1);
});
const patch2 = readFileSync(patchFile, "utf8");
check("重复安装没有塞第二行 wakeup", () => {
  assert.equal((patch2.match(/^- id: wakeup$/gm) || []).length, 1);
});
check("家的 README 标记没被写两遍", () => {
  const text = readFileSync(join(home, "README.md"), "utf8");
  assert.equal(text.split("【接入还没做完】").length - 1, 1);
});

// -------------------------------------------------------- 家目录有东西时不覆盖
if (!existsSync(home)) mkdirSync(home, { recursive: true });
writeFileSync(join(home, "灵魂设定.md"), "# 灵魂设定\n\n这是主人自己写的，别动。\n", "utf8");
const third = run([]);
check("家目录已有内容时不覆盖", () => {
  assert.ok(readFileSync(join(home, "灵魂设定.md"), "utf8").includes("这是主人自己写的"));
});

// ------------------------------------------------------ 桌面图标（家在桌面时）
// 一张 1×1 的合法 PNG，够喂给缩放那一步
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const deskHome = join(desktop, "dsh-home");
mkdirSync(deskHome, { recursive: true });
writeFileSync(join(deskHome, "门面设定.png"), Buffer.from(PNG_1PX, "base64"));

const withIcon = run(["--home", deskHome]);
check("家在桌面时安装仍退出码 0", () => assert.equal(withIcon.status, 0, `status=${withIcon.status}`));
check("形象图做成了图标", () => {
  assert.ok(existsSync(join(deskHome, "门面图标.ico")), "没生成 门面图标.ico");
});
check("桌面那个文件夹的图标指过去了（desktop.ini）", () => {
  const ini = join(deskHome, "desktop.ini");
  assert.ok(existsSync(ini), "没生成 desktop.ini");
  assert.ok(readFileSync(ini, "utf16le").includes("门面图标.ico"), "desktop.ini 里没指向图标");
});

const noIconHome = join(desktop, "no-icon-home");
mkdirSync(noIconHome, { recursive: true });
writeFileSync(join(noIconHome, "门面设定.png"), Buffer.from(PNG_1PX, "base64"));
run(["--home", noIconHome, "--no-icon"]);
check("--no-icon 时一个图标文件都不写", () => {
  assert.ok(!existsSync(join(noIconHome, "门面图标.ico")));
  assert.ok(!existsSync(join(noIconHome, "desktop.ini")));
});

const noFaceHome = join(desktop, "no-face-home");
mkdirSync(noFaceHome, { recursive: true });
const noFace = run(["--home", noFaceHome]);
check("家里没有形象图时不硬造图标", () => {
  assert.equal(noFace.status, 0, `status=${noFace.status}`);
  assert.ok(!existsSync(join(noFaceHome, "门面图标.ico")));
});

// 目录被 attrib +r 过了，清场前先把只读摘掉，不然删不掉
if (process.platform === "win32") {
  spawnSync("attrib", ["-r", deskHome], { stdio: "ignore" });
  spawnSync("attrib", ["-s", "-h", join(deskHome, "desktop.ini")], { stdio: "ignore" });
}

rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? "\n有失败项。" : "\nOK —— 安装器自测全过（用的是假 DSH，没碰你真实的）。");