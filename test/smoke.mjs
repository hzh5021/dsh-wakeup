/**
 * dsh-wakeup 离线冒烟测试。
 *
 * 不启动 DSH，自己在临时目录里搭一个「夹具家」，用假的 ctx / agent 把
 * apply() 挂起来，验这些事：
 *   1. 读家：该读的读到、置顶那本排在最前、最近几节/几篇的顺序对；
 *   2. 模板：家里放 `家门.md` / `收尾.md` 就用它，没放就用内置的，`{home}` 会被换掉；
 *   3. 注入：新 agent 建起来正好注入一条；已起床的、subagent、忙着的都不塞；
 *   4. 截断：单文件上限、整包上限都拦得住；
 *   5. 抓候选：`记住…` / `<!-- 记: … -->` 抓得到，插件自己塞的消息不抓，同一条不塞两遍；
 *   6. 工作笔记（可选）：配了才带、只带最近几节，默认关着；
 *   7. 坏情况：家目录不存在就安静地不起床，不抛错。
 *
 * 跑法（用 DSH 自带的 node）：
 *   node test/smoke.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { apply, _internals } = await import("../lib/index.js");

/** 固定时刻：断言里不该出现「跑测试那一刻」。 */
const NOW = new Date("2026-01-02T03:04:05");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const passed = [];
const ok = label => { passed.push(label); console.log("  ok -", label); };

console.log("dsh-wakeup smoke\n");

// ---------------------------------------------------------------- 夹具家
const root = await mkdtemp(join(tmpdir(), "dsh-wakeup-smoke-"));
const home = join(root, "家");
await mkdir(join(home, "日记"), { recursive: true });
const write = (relative, text) => writeFile(join(home, relative), text, "utf8");

await write("README.md", "# 示例家\n\n这个家里放的是固定要读的账。\n");
await write("灵魂设定.md", "# 灵魂设定\n\n名字：小鱼。懒，但答应的事会做完。\n");
await write("说话的规矩.md", "# 说话的规矩\n\n短句，口语，说完就停。\n");
await write("错题集.md", "# 错题集\n\n## 2026-01-01\n\n- 把摘要当原文用了。\n");
await write("成长记录.md", `# 成长记录\n\n${"还没长好的：承诺要留痕。".repeat(60)}\n`);
await write(
  "长期记忆库.md",
  "# 长期记忆库\n\n## 2026-01-01 · 第一节\n\n第一天的事。\n\n"
    + "## 2026-01-02 · 第二节\n\n第二天的事。\n\n## 2026-01-03 · 第三节\n\n第三天的事。\n",
);
await write("日记/2026-01-01.md", "# 一月一日\n\n第一天。\n");
await write("日记/2026-01-02.md", "# 一月二日\n\n第二天。\n");
await write("日记/2026-01-03.md", "# 一月三日\n\n第三天。\n");
await write("家门.md", "【家门】\n- 家：{home}\n- 这是自己的模板\n");
await write("收尾.md", "【干活的时候】\n- 做完了说一声\n\n【开口之前的那一下】\n- 想说的才说\n");

// ------------------------------------------------------- 1. 选项与默认值
const options = _internals.resolveOptions({ home });
assert.equal(options.home, home);
assert.deepEqual(options.coreFiles, _internals.DEFAULT_CORE_FILES);
assert.equal(options.leadFile, "说话的规矩.md");
assert.equal(options.diaryDays, 3);
assert.equal(options.memoSections, 6);
assert.equal(options.capture, true);
assert.equal(options.diaryDir, "日记");
ok("resolveOptions：默认值");

// 没给 home 时：环境变量 DSH_WAKEUP_HOME 优先，否则落到主目录下的默认名
const noHome = _internals.resolveOptions({});
const envHome = (process.env.DSH_WAKEUP_HOME || "").trim();
if (envHome) {
  assert.equal(noHome.home, envHome, "设了 DSH_WAKEUP_HOME 就该用它");
} else {
  assert.ok(noHome.home.endsWith(_internals.DEFAULT_HOME_DIRNAME), "兜底家目录该在主目录下");
}
const viaEnv = _internals.resolveOptions({ home: "D:\\a" });
assert.equal(viaEnv.home, "D:\\a");
ok("resolveOptions：家目录兜底 / 显式覆盖");

// ------------------------------------------------------------- 2. 读家
const block = await _internals.buildWake(options, NOW);
assert.ok(block, "起床包不该是空的");
assert.ok(block.startsWith("<dsh-wakeup>"));
assert.ok(block.trimEnd().endsWith("</dsh-wakeup>"), "闭标记该在整包最后");
assert.ok(block.includes("读于 2026-01-02 03:04"), "抬头该带上读的时刻");

const leadAt = block.indexOf("## 说话的规矩.md");
const soulAt = block.indexOf("## 灵魂设定.md");
assert.ok(block.includes("【每次开局，先看这一本】"), "缺少置顶小标题");
assert.ok(leadAt > -1 && leadAt < soulAt, "置顶那本该排在别的账前面");
assert.equal(block.split("## 说话的规矩.md").length - 1, 1, "置顶那本不该在正文里再出现一遍");

assert.ok(block.includes("【最近长出来的】"), "缺少「最近长出来的」那节");
assert.ok(block.includes("## 日记/2026-01-03.md"), "缺少最近一篇日记");
assert.equal(block.split("## 日记/").length - 1, 3, "默认该带三篇日记");
const diaryOrder = [3, 2, 1].map(day => block.indexOf(`## 日记/2026-01-0${day}.md`));
assert.ok(diaryOrder[0] < diaryOrder[1] && diaryOrder[1] < diaryOrder[2], "日记该新的在前");
ok("读家：置顶、最近几节、最近几篇（新的在前）");

// 长期记忆库取尾巴几节，且新的在前
const memoAll = _internals.recentMemoSections(
  "# 长期记忆库\n\n## 一\n\na\n\n## 二\n\nb\n\n## 三\n\nc\n",
  2,
);
assert.deepEqual(memoAll.map(entry => entry.split("\n")[0]), ["## 三", "## 二"], "取尾巴、新的在前");
assert.deepEqual(_internals.recentMemoSections("没有分节\n", 3), [], "没有 ## 分节就返回空");
assert.deepEqual(_internals.recentMemoSections("## 一\n\na\n", 0), [], "节数为 0 就不取");
ok("长期记忆库：只取尾巴几节，新的在前");

// -------------------------------------------- 2.5 工作笔记（可选，默认关）
const notePath = join(root, "工作笔记.md");
await writeFile(notePath, "## 一 · 老的事\n\n上个月的事。\n\n## 二 · 新的事\n\n昨天的事。\n", "utf8");
const withNote = _internals.resolveOptions({ home, worknoteFile: notePath, worknoteSections: 1 });
assert.equal(withNote.worknoteFile, notePath);
assert.equal(withNote.worknoteSections, 1);
const noteBlock = await _internals.buildWake(withNote, NOW);
assert.ok(noteBlock.includes("【工作笔记新长的】"), "配了工作笔记就该带那一节");
assert.ok(noteBlock.includes("昨天的事"), "该带最近一节");
assert.ok(!noteBlock.includes("上个月的事"), "只带最近一节，老的原样留在文件里");
assert.equal(_internals.resolveOptions({ home }).worknoteFile, "", "默认该是关的");
assert.ok(!block.includes("【工作笔记新长的】"), "没配就不该带工作笔记");
ok("工作笔记：默认关，配了才带、只带最近几节");

// ------------------------------------------------------- 3. 模板与 {home}
assert.ok(block.includes(`- 家：${home}`), "`{home}` 该换成真的家目录");
assert.ok(block.includes("- 这是自己的模板"), "该用家里的 家门.md");
assert.ok(!block.includes("家（账本）"), "用了自己的模板就不该再出现内置那份");
assert.ok(block.includes("- 做完了说一声"), "该用家里的 收尾.md");
assert.ok(!block.includes("- 动手前说一句要干什么"), "用了自己的模板就不该再出现内置那份");
const tailAt = block.lastIndexOf("【开口之前的那一下】");
assert.ok(tailAt > block.lastIndexOf("## "), "收尾那段该在所有文件小节之后");
ok("模板：家里的 家门.md / 收尾.md 生效，{home} 被替换");

// 没放模板 -> 回落到内置那份
const bare = join(root, "空家");
await mkdir(join(bare, "日记"), { recursive: true });
await writeFile(join(bare, "灵魂设定.md"), "# 灵魂设定\n\n只有这一本。\n", "utf8");
const bareBlock = await _internals.buildWake(_internals.resolveOptions({ home: bare }), NOW);
assert.ok(bareBlock.includes("【家门】"), "没模板该用内置的【家门】");
assert.ok(bareBlock.includes(`- 家（账本）：${bare}`), "内置那份也要替换 {home}");
assert.ok(bareBlock.includes("【干活的时候】"), "没模板该用内置的收尾");
assert.ok(bareBlock.includes("【开口之前的那一下】"));
ok("模板缺省：回落到内置那两份");

// 置顶关掉、日记关掉
const off = await _internals.buildWake(
  _internals.resolveOptions({ home, leadFile: "", diaryDays: 0, memoSections: 0 }),
  NOW,
);
assert.ok(!off.includes("【每次开局，先看这一本】"), "leadFile 空串该关掉置顶");
assert.ok(off.includes("## 说话的规矩.md"), "关掉置顶后它该回到普通账里");
assert.ok(!off.includes("## 日记/"), "diaryDays 0 该不带日记");
assert.ok(!off.includes("【最近长出来的】"), "memoSections 0 该不带最近几节");

// coreFiles 给空数组 = 一本账都不读（但置顶、记忆库、日记、收尾照旧）
const noBooks = _internals.resolveOptions({ home, coreFiles: [] });
assert.deepEqual(noBooks.coreFiles, [], "显式给空数组就该是空，不该退回默认");
const noBooksBlock = await _internals.buildWake(noBooks, NOW);
assert.ok(!noBooksBlock.includes("## README.md"), "coreFiles 空 -> 不读账");
assert.ok(noBooksBlock.includes("【每次开局，先看这一本】"), "coreFiles 空不影响置顶");
assert.ok(noBooksBlock.includes("【最近长出来的】"), "coreFiles 空不影响记忆库");
assert.ok(noBooksBlock.includes("## 日记/2026-01-03.md"), "coreFiles 空不影响日记");
assert.ok(noBooksBlock.includes("【干活的时候】"), "coreFiles 空不影响收尾");

// 一本都不给、置顶也关了、日记记忆库也关了 -> 这包没什么好塞的
assert.equal(
  await _internals.buildWake(
    _internals.resolveOptions({ home, coreFiles: [], leadFile: "", diaryDays: 0, memoSections: 0 }),
    NOW,
  ),
  null,
  "什么都没得读就该返回 null，而不是塞一条空包",
);
ok("开关：leadFile / coreFiles / diaryDays / memoSections 都能关");

// --------------------------------------------------------- 4. 精炼（2.0）
// 注意：fileMaxChars 下限 500、maxChars 下限 1000；比这更小的值会被夹回安全区。
const cut = await _internals.buildWake(
  _internals.resolveOptions({ home, fileMaxChars: 500 }),
  NOW,
);
assert.ok(cut.includes("被精炼过"), "超过单文件上限该留下精炼提示");
assert.ok(cut.includes("这里留了 500 字"), "单文件上限该是 500");
assert.ok(cut.length < block.length, "预算收紧后整包该更短");

// 2.0 的规矩：预算见底不丢书，在本内削到地板，包尾报一声。
const bigHome = join(root, "大账家");
await mkdir(bigHome, { recursive: true });
await writeFile(join(bigHome, "成长记录.md"), `# 成长记录\n\n${"长".repeat(3000)}`, "utf8");
await writeFile(join(bigHome, "灵魂设定.md"), "# 灵魂设定\n\n这一本永不削。\n", "utf8");
const bigBlock = await _internals.buildWake(
  _internals.resolveOptions({ home: bigHome, maxChars: 1000 }),
  NOW,
);
assert.ok(bigBlock.includes("【这轮精炼过的】"), "削过就该在包尾报一声");
assert.ok(bigBlock.includes("这一本永不削"), "身份那本不该被削");
assert.ok(bigBlock.length < 3000, `整包该被 maxChars 拦住，实得 ${bigBlock.length}`);

// 按标题里的日期取最近几节：新节插在最前面也认得出来
const dated = _internals.recentMemoSections(
  "# 账\n\n## 2026-01-05 · 最新的\n\n五。\n\n## 2026-01-01 · 最旧的\n\n一。\n\n## 2026-01-03 · 中间\n\n三。\n",
  2,
);
assert.deepEqual(
  dated.map(entry => entry.split("\n")[0]),
  ["## 2026-01-05 · 最新的", "## 2026-01-03 · 中间"],
  "该按日期取最近两节，不按文件里的位置",
);
assert.ok(_internals.sectionDate("2026-01-05 · 最新的") > _internals.sectionDate("2026-01-03"));
assert.equal(_internals.sectionDate("没有日期"), null);
ok("精炼：单本上限、整包上限、削到地板留身份、包尾报账、按日期取节");

// 夹取区间：荒唐的小值 / 大值都退回安全区
const clamped = _internals.resolveOptions({
  home, fileMaxChars: 1, maxChars: 1, diaryDays: 99, memoSections: 99,
});
assert.equal(clamped.fileMaxChars, 500);
assert.equal(clamped.maxChars, 1_000);
assert.equal(clamped.diaryDays, 30);
assert.equal(clamped.memoSections, 50);
ok("截断：单文件上限、整包上限、夹取区间");

// --------------------------------------------------------- 5. 坏情况
const missing = await _internals.buildWake(
  _internals.resolveOptions({ home: join(root, "不存在的家") }),
  NOW,
);
assert.equal(missing, null, "家目录不存在该安静返回 null");
const empty = await _internals.buildWake(
  _internals.resolveOptions({ home: join(root, "空目录") }),
  NOW,
);
assert.equal(empty, null, "空目录（连内置模板都撑不起来）该返回 null");
await mkdir(join(root, "空目录"), { recursive: true });
assert.equal(
  await _internals.buildWake(_internals.resolveOptions({ home: join(root, "空目录") }), NOW),
  null,
  "目录在但一本账都没有 -> null",
);
ok("坏情况：家不在 / 家是空的，都不抛错");

// ---------------------------------------------------------- 6. 注入
function makeAgent({ origin = "user", history = [] } = {}) {
  return {
    status: "idle",
    session: { header: { origin }, ownEvents: () => history },
    inbox: {},
    injected: [],
    inject(message) { this.injected.push(message); },
  };
}
function makeCtx() {
  const listeners = new Map();
  const logs = [];
  return {
    listeners,
    logs,
    logger: { info: (...args) => logs.push(args.join(" ")) },
    on: (event, handler) => listeners.set(event, handler),
  };
}

const ctx = makeCtx();
apply(ctx, { home });
assert.ok(ctx.listeners.has("agent/created"), "没挂 agent/created");
assert.ok(ctx.listeners.has("session/event"), "没挂 session/event");
assert.ok(ctx.logs.some(line => line.includes("armed")), "挂上时该留一条 armed 日志");

const created = ctx.listeners.get("agent/created");
const first = makeAgent();
const ret = await created({ agent: first, source: "user" });
assert.equal(ret, undefined, "串行分发要求监听器 resolve 成 undefined");
assert.equal(first.injected.length, 1, "新会话应当正好注入一条");
assert.equal(first.injected[0].role, "user");
assert.equal(first.injected[0].source.kind, "plugin:dsh-wakeup");
assert.ok(first.injected[0].content[0].text.includes("灵魂设定.md"));

// 同一个 agent 再来一次（session-start 也响）不该重复注入
await created({ agent: first, source: "user" });
ctx.listeners.get("agent/session-start")({ agent: first });
await delay(30);
assert.equal(first.injected.length, 1, "同一个 agent 不该被注入两遍");

// 历史里已有起床包（resume / fork）不再灌
const resumeEvent = {
  type: "user/message",
  data: _internals.wakeMessage("<dsh-wakeup>老的一包</dsh-wakeup>"),
};
const resumed = makeAgent({ history: [resumeEvent] });
await created({ agent: resumed, source: "resume" });
assert.ok(_internals.alreadyWoke(resumed), "alreadyWoke 该认出历史里的标记");
assert.equal(resumed.injected.length, 0, "起过床的会话不该再灌一遍");

// inbox 里排着的那条也算
assert.ok(_internals.alreadyWoke({
  session: { header: {}, ownEvents: () => [] },
  inbox: { nextTurn: [_internals.wakeMessage("x")] },
}), "inbox 里待消费的起床包也算起过床");

const child = makeAgent({ origin: "subagent" });
await created({ agent: child, source: "subagent" });
assert.equal(child.injected.length, 0, "subagent 不该被叫起床");

const busy = makeAgent();
busy.status = "running";
await created({ agent: busy, source: "user" });
assert.equal(busy.injected.length, 0, "忙着的 agent 不该被塞消息");
ok("注入：正好一条 / 不重复 / 跳过 subagent 与忙着的");

// ------------------------------------------------------- 7. 抓候选
const marked = _internals.pickCandidates({
  role: "assistant",
  content: [{ type: "text", text: "说到这儿。<!-- 记: 对方点破了「光看不做」 -->" }],
});
assert.equal(marked.length, 1, "我自己标的该被抓到");
assert.ok(marked[0].text.includes("光看不做"));
assert.equal(_internals.pickCandidates({
  role: "assistant",
  content: [{ type: "reasoning", text: "<!-- 记: 写在思考里的，不算 -->" }],
}).length, 0, "思考块不算，只有 text block 算");
assert.equal(_internals.pickCandidates({
  role: "user",
  content: [{ type: "text", text: "记住：别把测试数据写进正式记忆" }],
}).length, 1, "带「记住」的话该被抓到");
assert.equal(_internals.pickCandidates({
  role: "user",
  content: [{ type: "text", text: "记住：这条是插件塞的" }],
  source: { kind: "plugin:dsh-wakeup-capture" },
}).length, 0, "插件塞的消息不该被抓，否则会抓到自己转圈");
assert.equal(_internals.pickCandidates({
  role: "user",
  content: [{ type: "text", text: "今天天气不错" }],
}).length, 0, "没命中的话不该被抓");
ok("抓候选：标记 / 命中词 / 去重规则");

const captureHome = join(root, "抓取家");
await mkdir(captureHome, { recursive: true });
await writeFile(join(captureHome, "灵魂设定.md"), "# 灵魂设定\n", "utf8");
const ctx2 = makeCtx();
apply(ctx2, { home: captureHome });
const agent2 = makeAgent();
agent2.session.id = "s-1";
await ctx2.listeners.get("agent/created")({ agent: agent2, source: "user" });
agent2.injected = [];

const sessionEvent = ctx2.listeners.get("session/event");
const hisMessage = {
  type: "user/message",
  seq: 7,
  data: { role: "user", content: [{ type: "text", text: "记住：别把测试数据写进正式记忆" }] },
};
sessionEvent({ id: "s-1" }, hisMessage);
await delay(60);
assert.equal(agent2.injected.length, 1, "抓完该往会话里塞一条提示");
assert.equal(agent2.injected[0].source.kind, _internals.CAPTURE_KIND);
assert.ok(agent2.injected[0].content[0].text.includes("别把测试数据写进正式记忆"), "提示里该带上原文");
assert.deepEqual(await readdir(captureHome), ["灵魂设定.md"], "抓完不该落任何中转文件");

sessionEvent({ id: "s-1" }, hisMessage);
await delay(60);
assert.equal(agent2.injected.length, 1, "同一个 seq 不该塞第二遍");
ok("抓候选：塞提示、带原文、不落中转、同 seq 不重复");

// capture: false 时干脆不挂这个监听
const ctx3 = makeCtx();
apply(ctx3, { home: captureHome, capture: false });
assert.ok(!ctx3.listeners.has("session/event"), "关掉抓取就不该挂 session/event");
assert.ok(ctx3.listeners.has("agent/created"), "关掉抓取不影响起床");
ok("开关：capture: false 只关抓取，不影响起床");

await rm(root, { recursive: true, force: true });

console.log(`\nOK —— ${passed.length} 项全过。`);
console.log("（测试用的是自己搭的夹具家，不碰你的真实家目录。）");