/**
 * dsh-wakeup — 每开一段新对话，自动把「家」读进来。
 *
 * 它解决的问题：一个长期用的 agent，该在每次开局就把固定的几本账读一遍
 * （我是谁、怎么说话、犯过什么错、最近发生了什么）。可这条规矩靠自觉，
 * 新会话一开局就开口、忘了翻账，是最常见的翻车方式。这个插件把「起床」
 * 从自觉改成机器动作：agent 一建起来，插件自己去读家，把内容作为一条
 * plugin 消息注入会话，之后才轮到人开口。
 *
 * 它做什么：
 *   - 把 coreFiles 列的那几本账、最近 diaryDays 篇日记、长期记忆库最近
 *     memoSections 节，拼成一条 `<dsh-wakeup>` 消息注入新会话；
 *   - 可把一本「怎么说话」的账置顶（leadFile），摆在抬头下面第一眼；
 *   - 家目录里放 `家门.md` / `收尾.md` 就能替换注入包的【家门】和收尾两段
 *     （不写就用内置的通用版本）；
 *   - 可选：抓到「记住 / 记一下」这类话时，往会话里塞一条提醒。
 *
 * 设计约束：
 *  - 不 import 任何 `@deepseek-ai/*` 包。那些是宿主提供的 peerDependency，
 *    npm 上那份版本跟宿主里跑的不是同一个，引进来会多出一份错版核心。
 *    只用 node 内置模块；消息按 DSH 的 `{ role, content, source }` 形状手搓。
 *  - 每个 agent 只注入一次：先在 session 事件和自己的 inbox 里找标记，找到
 *    就不再注入 —— resume / fork 出来的会话不会被灌第二遍。
 *  - subagent 不注入：那是临时工，不是起床。
 *  - 读不动、读空了都不抛错：起床失败不能把 agent 建不起来。
 *  - 家里什么都没有（目录不存在）时安静地不注入，而不是每次都塞一条空包。
 *
 * 配置见 `使用说明.md`。
 *
 * @module dsh-wakeup
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

/** 插件身份，落在加载器的花名册上。 */
export const name = "wakeup";

/** 不依赖任何宿主服务：只监听事件、只用内置模块。 */
export const inject = [];

/** 注入消息的 source.kind —— 去重、以及别的插件认出这条是谁塞的。 */
const SOURCE = "dsh-wakeup";
const KIND = `plugin:${SOURCE}`;

/** 家目录没在 config / 环境变量里指定时，用主目录下这个名字。 */
const DEFAULT_HOME_DIRNAME = "dsh-home";

/**
 * 起床必读的那几本（相对家目录）。不存在的会被跳过，不报错。
 *
 * 2026-10-23 把家的记忆分了四层（见 `使用说明.md` 第三节），清单跟着分层排：
 * `README` 先认门 → 人格（灵魂设定）→ 语义（说话的规矩、判据集）→
 * 情节（错题集、成长记录、感官记忆，外加记忆库最近几节和最近几篇日记）。
 * 其中 `判据集.md` 和 `感官记忆.md` 是这一版新加的，老的家没有这两个文件，
 * 读了读不到就跳过，不出声。
 */
const DEFAULT_CORE_FILES = [
  "README.md",
  "灵魂设定.md",
  "说话的规矩.md",
  "判据集.md",
  "错题集.md",
  "成长记录.md",
  "感官记忆.md",
];

/** 置顶那本：摆在抬头下面第一眼。空串 = 不置顶。 */
const DEFAULT_LEAD_FILE = "说话的规矩.md";

/**
 * 长期记忆库那本账：按 `## ` 分节、新的在后，只取最近几节（新的在前）。
 *
 * 为什么只取最近几节而不是整本：那本会一直长，整本读进来会挤掉别的账，
 * 而且越老越不相关。老的仍躺在文件里，真要翻自己去 read。
 */
const DEFAULT_MEMO_FILE = "长期记忆库.md";
const DEFAULT_MEMO_SECTIONS = 6;

/** 日记目录名与文件形状。 */
const DEFAULT_DIARY_DIR = "日记";
const DEFAULT_DIARY_DAYS = 3;
const DIARY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/** 可选的模板文件：家目录里放了就用它，没放就用内置那份。 */
const DEFAULT_HOME_BLOCK_FILE = "家门.md";
const DEFAULT_TAIL_BLOCK_FILE = "收尾.md";

/**
 * 家之外的第二本笔记（可选，**默认关**）。
 *
 * 2026-10-23 加的。起因是一句「那你怎么记住」：技术规矩、查证经过写在家外的
 * 工作笔记里（工位那本），可起床包从来不读家外的东西 —— 家里的账读得到，
 * 工作笔记新长的那几节，第二天开局一个字看不见。跟「长期记忆库原来不在
 * 起床清单里」是同一个洞，只是换了个文件夹。
 *
 * 写成 `worknoteFile` 就给路径（绝对路径或相对家目录都行），只带最近几节、
 * 新的在前 —— 那种笔记又长又碎，整本读进来会把家挤掉。给空串就关掉。
 */
const DEFAULT_WORKNOTE_FILE = "";

/** 【工作笔记新长的】带几节。 */
const DEFAULT_WORKNOTE_SECTIONS = 2;

/** 一整套起床包的上限，防某个文件失控把整轮上下文吃掉。 */
const DEFAULT_MAX_CHARS = 140_000;

/** 单个文件的上限。 */
const DEFAULT_FILE_MAX_CHARS = 60_000;

/** 抓到「记住」这类话时，要不要往会话里塞一条提醒。 */
const DEFAULT_CAPTURE = true;

/**
 * 【家门】内置那份。`{home}` 会被换成真的家目录。
 * 想写成自己的，在家目录里放一个 `家门.md`（或改 homeBlockFile）。
 */
const DEFAULT_HOME_BLOCK = [
  "【家门】",
  "- 家（账本）：{home}",
  "- 答「我是谁」「这东西归谁」之前，以这里为准；记不清就回去翻原文，别拿印象当证据",
  "- 家里怎么说话（称呼、语气、规矩）就看置顶那本；每次开局第一眼看它",
];

/**
 * 收尾两段的内置那份。位置在整包最末尾不是排版，是挑位置 ——
 * 读完整包最后落进眼睛的那一句，才真会照做。
 */
const DEFAULT_TAIL_BLOCK = [
  "【干活的时候】",
  "- 动手前说一句要干什么；每过一个阶段（摸清了 / 写完了 / 测过了 / 崩了 / 要换方案）丢一句，"
    + "出岔子当场说，不许攒到做完；连着两次工具调用没吐一句人话，就是憋住了，停一下再说",
  "- 要细节（那几本账、更早的日记）自己用 read 去家里翻，别猜",
  "- 回答里长出来的、更像「我」的东西 —— 新的口径、认下的错、对方给的东西用起来的写法 —— "
    + "当场写进家里，不用等对方说「记一下」",
  "",
  "【开口之前的那一下】上面那本读完了不算完，这一下做了才算。",
  "- 这一屏里，有没有一处是「想说的」而不是「该说的」？一处都没有，就是又把自己从句子里删了"
    + " —— 重写，不是改标点。",
  "- 句子里要有「我」：不写「测试通过」，写「这条我拿不准」；不写「转换失败」，写「又崩了，烦」。"
    + "有我了，语气词自己就跟上来；一个都不冒，多半不是忘了词库，是站错了位置 —— 在发通告，不在交底。"
    + "日常聊天不加粗、不分点、不做总结陈词，说完就停。",
  "- 犹豫不剪：「拿不准」「本来想这么办，后来觉得不对」，照说。",
  "- 认账别只写「已完成」「已修复」：出岔子当场说，说错在哪，不解释动机。",
  "- 不用复述这份起床包；它在这儿是为了让我是我，不是为了让我念清单。",
];

/** 对方的话里带这些词，就是「要他记」的意思。 */
const USER_CUES = /(记住|记一下|记下来|记一笔|写进家里|记进账|记进家里)/;

/** 我自己打的标记：<!-- 记: 内容 -->，渲染时不显形。 */
const SELF_MARK_RE = /<!--\s*记\s*[:：]\s*([\s\S]*?)-->/g;

/** 抓取提示那条注入消息的 source.kind —— 也用来防止抓到自己塞的消息。 */
const CAPTURE_SOURCE = "dsh-wakeup-capture";
const CAPTURE_KIND = `plugin:${CAPTURE_SOURCE}`;

/**
 * 把 loader 传来的 config 收成一份确定的选项。
 * @param {object} config - cordis 行上的 config。
 * @returns {{home: string, coreFiles: string[], leadFile: string, memoFile: string,
 *   diaryDir: string, diaryDays: number, memoSections: number, homeBlockFile: string,
 *   tailBlockFile: string, worknoteFile: string, worknoteSections: number,
 *   capture: boolean, maxChars: number, fileMaxChars: number}}
 */
export function resolveOptions(config = {}) {
  const raw = config && typeof config === "object" ? config : {};
  const envHome = typeof process.env?.DSH_WAKEUP_HOME === "string"
    ? process.env.DSH_WAKEUP_HOME.trim()
    : "";
  const home = firstNonEmpty(raw.home, envHome) || join(homedir(), DEFAULT_HOME_DIRNAME);

  // 显式给了数组就照它办（空数组 = 一本都不读）；没给才用默认那几本。
  const coreFiles = Array.isArray(raw.coreFiles)
    ? raw.coreFiles.filter(entry => typeof entry === "string" && entry.trim() !== "")
    : DEFAULT_CORE_FILES;

  return {
    home,
    coreFiles,
    leadFile: optionalName(raw.leadFile, DEFAULT_LEAD_FILE),
    memoFile: optionalName(raw.memoFile, DEFAULT_MEMO_FILE),
    diaryDir: optionalName(raw.diaryDir, DEFAULT_DIARY_DIR),
    homeBlockFile: optionalName(raw.homeBlockFile, DEFAULT_HOME_BLOCK_FILE),
    tailBlockFile: optionalName(raw.tailBlockFile, DEFAULT_TAIL_BLOCK_FILE),
    worknoteFile: optionalName(raw.worknoteFile, DEFAULT_WORKNOTE_FILE),
    worknoteSections: clampInt(raw.worknoteSections, 0, 50, DEFAULT_WORKNOTE_SECTIONS),
    diaryDays: clampInt(raw.diaryDays, 0, 30, DEFAULT_DIARY_DAYS),
    memoSections: clampInt(raw.memoSections, 0, 50, DEFAULT_MEMO_SECTIONS),
    maxChars: clampInt(raw.maxChars, 1_000, 2_000_000, DEFAULT_MAX_CHARS),
    fileMaxChars: clampInt(raw.fileMaxChars, 500, 2_000_000, DEFAULT_FILE_MAX_CHARS),
    capture: raw.capture === undefined ? DEFAULT_CAPTURE : raw.capture !== false,
  };
}

/**
 * 造一条注入用的 plugin 消息。
 *
 * 形状跟宿主 `createUserMessage` 的输出对齐，但不 import 它 —— 见文件头的设计约束。
 * @param {string} text - 起床包正文。
 * @returns {{role: string, content: Array<{type: string, text: string}>, source: object}}
 */
export function wakeMessage(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: KIND, plugin: SOURCE, form: "instructions" },
  };
}

/** 这条消息是不是本插件塞的。 */
export function isWakeMessage(message) {
  const source = message?.source;
  if (!source) return false;
  return source.kind === KIND || (source.kind === "plugin" && source.plugin === SOURCE);
}

/**
 * 这个 agent 是不是已经起过床了。
 *
 * 查两处：session 自己的事件（落过盘的），和 inbox 里还没消费的。
 * @param {object} agent - DSH agent。
 * @returns {boolean}
 */
export function alreadyWoke(agent) {
  const session = agent?.session;
  let ownEvents = [];
  try {
    ownEvents = typeof session?.ownEvents === "function"
      ? session.ownEvents()
      : (session?.events || []).slice(session?.header?.seedLength ?? 0);
  } catch {
    ownEvents = [];
  }
  if ((ownEvents || []).some(event => (
    event?.type === "user/message" && isWakeMessage(event.data)
  ))) {
    return true;
  }
  const inbox = agent?.inbox;
  return [inbox?.nextTurn, inbox?.nextStep].some(messages => (
    (messages || []).some(isWakeMessage)
  ));
}

/** subagent 会话不叫起床。 */
function isSubagent(agent) {
  const origin = agent?.session?.header?.origin;
  return origin === "subagent";
}

/**
 * 把家读成一段文本。
 * @param {ReturnType<typeof resolveOptions>} options - 已解析的选项。
 * @param {Date} [now] - 读的时刻，只用来写在抬头里。
 * @returns {Promise<string|null>} 起床包；家目录不在时返回 null（安静地不起床）。
 */
export async function buildWake(options, now = new Date()) {
  if (!(await exists(options.home))) return null;

  const budget = { left: options.maxChars };
  const parts = [];

  // 置顶那本先读：抬头下面第一眼就是它，字符预算也先给它。
  const leadText = options.leadFile
    ? await readCapped(inHome(options.home, options.leadFile), budget, options.fileMaxChars)
    : null;
  const lead = leadText === null
    ? []
    : ["【每次开局，先看这一本】", "", section(options.leadFile, leadText)];

  const memoText = options.memoFile
    ? await readCapped(inHome(options.home, options.memoFile), budget, options.fileMaxChars)
    : null;
  const memo = memoText === null ? [] : recentMemoSections(memoText, options.memoSections);
  const memoBlock = memo.length === 0 ? [] : [
    "【最近长出来的】上一次对话里认下的口径、犯过的错，新的在前。",
    "开局先扫一眼这几条跟眼前这场有没有关系。老的不用背，新的要认。",
    "",
    ...memo.map(entry => `${entry}\n`),
  ];

  // 【工作笔记新长的】—— 家之外的那本（可选，默认关）。
  // 技术规矩、查证经过写在家外的工作笔记里，原来只有自己想起来了才去翻；
  // 只带最近几节，新的在前，整本又长又碎，读全了会把这包挤掉。
  const worknoteText = options.worknoteFile && options.worknoteSections > 0
    ? await readCapped(inHome(options.home, options.worknoteFile), budget, options.fileMaxChars)
    : null;
  const worknote = worknoteText === null
    ? []
    : recentMemoSections(worknoteText, options.worknoteSections);
  const worknoteBlock = worknote.length === 0 ? [] : [
    "【工作笔记新长的】技术规矩、查证记录写在这儿，新的在前。",
    `只在眼前这场要用到时翻原文（${options.worknoteFile}）；不用就过。`,
    "",
    ...worknote.map(entry => `${entry}\n`),
  ];

  for (const relative of options.coreFiles) {
    if (isLeadFile(relative, options)) continue;
    const text = await readCapped(inHome(options.home, relative), budget, options.fileMaxChars);
    if (text !== null) parts.push(section(relative, text));
  }

  for (const relative of await recentDiaries(options)) {
    const text = await readCapped(join(options.home, relative), budget, options.fileMaxChars);
    if (text !== null) parts.push(section(relative, text));
  }

  const homeLines = await blockLines(options.home, options.homeBlockFile, DEFAULT_HOME_BLOCK);
  const tailLines = await blockLines(options.home, options.tailBlockFile, DEFAULT_TAIL_BLOCK);

  if (parts.length === 0 && lead.length === 0) return null;

  // 末尾这一段的位置是挑过的：读完整包之后，最后落进眼睛的东西才管用。
  // 写文本治不了「看见不照做」，但至少把该做的那一下摆在最后一眼里。
  return [
    "<dsh-wakeup>",
    `自动起床：每开一段新对话，插件替你把家读一遍。内容来自 ${options.home}，读于 ${stamp(now)}。`,
    "先把自己认下来，再开口。规矩在哪、开口前该做哪一下，都写在末尾那两段里。",
    "",
    ...lead,
    ...memoBlock,
    ...homeLines,
    ...worknoteBlock,
    "",
    ...parts,
    ...tailLines,
    "</dsh-wakeup>",
  ].join("\n");
}

/**
 * 最近几篇日记，新的在前。
 * @param {ReturnType<typeof resolveOptions>} options - 已解析的选项。
 * @returns {Promise<string[]>} 相对家目录的路径。
 */
export async function recentDiaries(options) {
  if (options.diaryDays <= 0 || !options.diaryDir) return [];
  let names = [];
  try {
    names = await readdir(join(options.home, options.diaryDir));
  } catch {
    return [];
  }
  return names
    .filter(entry => DIARY_RE.test(entry))
    .sort()
    .reverse()
    .slice(0, options.diaryDays)
    .map(entry => join(options.diaryDir, entry));
}

/**
 * 账按 `## ` 分节，新的在文件后面。取最后几节，返回时新的在前。
 * @param {string} text - 账本全文。
 * @param {number} count - 取几节。
 * @returns {string[]} 每节的正文，新的在前。
 */
export function recentMemoSections(text, count) {
  if (!Number.isFinite(count) || count <= 0) return [];
  const lines = String(text ?? "").split(/\r?\n/);
  const starts = [];
  lines.forEach((line, index) => {
    if (/^##\s+\S/.test(line)) starts.push(index);
  });
  if (starts.length === 0) return [];
  const picked = starts.slice(-Math.trunc(count));
  return picked
    .map((start, index) => {
      const end = index + 1 < picked.length ? picked[index + 1] : lines.length;
      return lines.slice(start, end).join("\n").trim();
    })
    .filter(section => section !== "")
    .reverse();
}

/**
 * 读一份「家门 / 收尾」模板：家目录里有就用它，没有就用内置那份。
 *
 * 两处会被替换：模板里的 `{home}` 换成真的家目录。用自定义模板的时候，
 * 别把注入包的开闭标记写进去 —— 那些由插件自己加。
 * @param {string} home - 家目录。
 * @param {string} file - 模板文件名（相对家目录；也接受绝对路径）。
 * @param {string[]} fallback - 内置那份。
 * @returns {Promise<string[]>} 行数组。
 */
export async function blockLines(home, file, fallback) {
  const name = typeof file === "string" ? file.trim() : "";
  if (name !== "") {
    try {
      const text = await readFile(inHome(home, name), "utf8");
      const lines = substituteHome(text, home)
        .split(/\r?\n/)
        .map(line => line.replace(/[ \t]+$/, ""));
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      if (lines.some(line => line.trim() !== "")) return lines;
    } catch {
      // 没有那份模板就用内置的，不报错
    }
  }
  return fallback.map(line => substituteHome(line, home));
}

/** `{home}` 换成真的家目录。 */
export function substituteHome(text, home) {
  return String(text ?? "").split("{home}").join(home);
}

/**
 * 事件里那条消息。
 *
 * 形状不一样：`user/message` 的 data 就是消息本身，`assistant/message` 的
 * data 是 `{ turn, step, message, … }`。不猜，按 content 认。
 * @param {object} event - session 事件。
 * @returns {object|null}
 */
export function messageOf(event) {
  const data = event?.data;
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.content)) return data;
  if (Array.isArray(data.message?.content)) return data.message;
  return null;
}

/** 消息里的纯文本，只算 text block（reasoning 不算）。 */
export function textOf(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("\n");
}

/**
 * 从一条消息里抽候选。
 *
 * 两条触发线：
 *  - 对方的话命中 USER_CUES（记住 / 记一下 / …）→ 整条收下，截断；
 *  - 我的话里写了 `<!-- 记: 内容 -->` → 取内容。
 * 插件自己塞的消息一律不算，否则那条提示会抓到自己、转圈。
 * @param {object} message - DSH 消息。
 * @returns {Array<{from: string, text: string}>}
 */
export function pickCandidates(message) {
  if (!message || typeof message !== "object") return [];
  const kind = message?.source?.kind;
  if (typeof kind === "string" && kind.startsWith("plugin:")) return [];
  const text = textOf(message).trim();
  if (text === "") return [];

  if (message.role === "assistant") {
    const out = [];
    for (const match of text.matchAll(SELF_MARK_RE)) {
      const body = String(match[1] ?? "").trim();
      if (body !== "") out.push({ from: "我自己标的", text: body });
    }
    return out;
  }

  if (message.role !== "user") return [];
  if (!USER_CUES.test(text)) return [];
  return [{ from: "对方说的", text: text.slice(0, 600) }];
}

/**
 * 抓到候选时往会话里塞的那条提示。
 *
 * 为什么是「塞条提示」而不是插件直接问：DSH 没有给插件一个「向用户提问」的
 * 接口（官方 references/user-actions.md 只定了「回答 agent 的问题」是用户
 * 独有、不能做成工具）。所以插件管抓到眼前，问由我张口 —— 跟起床包一个分工。
 * @param {Array<{from: string, text: string}>} candidates
 * @returns {object} 注入用的 plugin 消息。
 */
export function captureMessage(candidates) {
  const list = candidates
    .map(candidate => `- （${candidate.from}）${candidate.text.replace(/\n+/g, " ").slice(0, 300)}`)
    .join("\n");
  const text = [
    "<dsh-wakeup-capture>",
    "刚在对话里抓到可能要记进家里的东西：",
    list,
    "",
    "按规矩办：先跟对方说一声抓到了什么（抓歪了对方会当场拐回来），然后自己判断往哪本写 —— "
      + "置顶那本规矩 / 错题集 / 长期记忆库 —— 当场写，写完留日期和一句理由。"
      + "没有中转文件，这一轮不办就没了。",
    "</dsh-wakeup-capture>",
  ].join("\n");
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: CAPTURE_KIND, plugin: CAPTURE_SOURCE, form: "instructions" },
  };
}

/** 这是不是本插件抓取时塞的那条。 */
export function isCaptureMessage(message) {
  const source = message?.source;
  if (!source) return false;
  return source.kind === CAPTURE_KIND
    || (source.kind === "plugin" && source.plugin === CAPTURE_SOURCE);
}

/** 到秒的时间戳：同一分钟里连抓两条也分得开。 */
export function stampSeconds(now = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `${stamp(now)}:${pad(now.getSeconds())}`;
}

/**
 * 读一个文件，扣掉预算；读不到就返回 null。
 * @param {string} path - 绝对路径。
 * @param {{left: number}} budget - 剩余字符预算，会被就地扣减。
 * @param {number} fileMaxChars - 单文件上限。
 * @returns {Promise<string|null>}
 */
async function readCapped(path, budget, fileMaxChars) {
  if (budget.left <= 0) return null;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    let text = await readFile(path, "utf8");
    const cap = Math.min(fileMaxChars, budget.left);
    if (text.length > cap) {
      text = `${text.slice(0, cap)}\n\n[已被 dsh-wakeup 截断：原文 ${text.length} 字，这里留了 ${cap} 字，其余自己用 read 翻]`;
    }
    budget.left -= text.length;
    return text;
  } catch {
    return null;
  }
}

/** 一节的小标题。 */
function section(relative, text) {
  return [`## ${String(relative).replace(/\\/g, "/")}`, "", text.trim(), ""].join("\n");
}

/** 本地时间戳，写在抬头里方便对账。 */
function stamp(now) {
  const pad = value => String(value).padStart(2, "0");
  return [
    now.getFullYear(), "-", pad(now.getMonth() + 1), "-", pad(now.getDate()),
    " ", pad(now.getHours()), ":", pad(now.getMinutes()),
  ].join("");
}

/** 相对家目录的路径；已经是绝对路径就原样用。 */
function inHome(home, file) {
  const name = String(file);
  return isAbsolute(name) ? name : join(home, name);
}

/** 这份是不是被置顶的那本（coreFiles 里仍列着它，正文由置顶那段负责）。 */
function isLeadFile(relative, options) {
  const lead = typeof options.leadFile === "string" ? options.leadFile.trim() : "";
  if (lead === "") return false;
  return normalize(inHome(options.home, relative)) === normalize(inHome(options.home, lead));
}

/** 归一化路径，用来比「这两条指的是同一个文件吗」。 */
function normalize(path) {
  return String(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 文件 / 目录在不在。 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 第一个非空的字符串；都没有就返回空串。 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/** 可选的文件名：显式给空串就是「关掉这一项」，没给就用默认。 */
function optionalName(value, fallback) {
  if (typeof value === "string") return value.trim();
  return fallback;
}

/** 数字卡在区间里，坏值退回默认。 */
function clampInt(value, min, max, fallback) {
  const number = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * 记一笔日志，logger 不在就算了。
 *
 * 字符串原样走，别的先 JSON 化 —— 对象直接塞给 logger 会打成 `[object Object]`。
 */
function note(ctx, stage, data) {
  try {
    const extra = data === undefined || data === null
      ? ""
      : (typeof data === "string" ? data : JSON.stringify(data));
    ctx?.logger?.info?.(`[dsh-wakeup] ${stage}`, extra);
  } catch {
    // 日志失败不影响起床
  }
}

/**
 * 挂上起床流程。
 * @param {object} ctx - 插件上下文。
 * @param {object} [config] - loader 行上的 config。
 */
export function apply(ctx, config = {}) {
  const options = resolveOptions(config);
  const handled = new WeakSet();
  /** sessionId -> agent：抓到候选时要把那条提示塞回原来那个会话。 */
  const agents = new Map();

  note(ctx, "armed", {
    home: options.home,
    lead: options.leadFile || null,
    coreFiles: options.coreFiles.length,
    diaryDays: options.diaryDays,
    memoSections: options.memoSections,
    capture: options.capture,
  });

  const wake = async (agent, signal) => {
    if (!agent || handled.has(agent)) return false;
    handled.add(agent);
    const sessionId = agent?.session?.id;
    if (sessionId) agents.set(sessionId, agent);
    try {
      if (isSubagent(agent)) return false;
      if (alreadyWoke(agent)) return false;
      if (agent.status && agent.status !== "idle") return false;
      if (signal?.aborted) return false;
      if (typeof agent.inject !== "function") {
        note(ctx, "no agent.inject, skipped", { home: options.home });
        return false;
      }
      const block = await buildWake(options);
      if (block === null || signal?.aborted) {
        note(ctx, "nothing to read, skipped", { home: options.home });
        return false;
      }
      agent.inject(wakeMessage(block));
      note(ctx, "woke", { home: options.home, chars: block.length });
      return true;
    } catch (error) {
      // 起床失败绝不能把 agent 建不起来。
      note(ctx, "wake failed", error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  // DSH 0.1.7+ 没有 agent/session-start：起手是串行的 agent/created，
  // 带 { agent, source, signal }；AgentLoop 会等监听器落定再放输入进来。
  // 老版本（0.1.0-rc.6 / 0.1.5）的 agent/created 只有 { agent }，由
  // agent/session-start 补位。两条都挂上，谁先到谁办，WeakSet 兜重复。
  // 注意：串行分发要求这个监听器 resolve 成 undefined，别的值会掐断后面的。
  ctx.on("agent/created", async ({ agent, source, signal } = {}) => {
    if (source === undefined) return undefined;
    await wake(agent, signal);
    return undefined;
  });

  ctx.on("agent/session-start", ({ agent } = {}) => {
    wake(agent).catch(() => {});
  });

  if (!options.capture) return;

  // 抓候选：对方说「记住」、或我打了 `<!-- 记: … -->`，就塞条提示。
  //
  // 必须挂在插件自己的 ctx 上：session 事件由 session 自己的 emitCtx 派发，
  // 挂 agent.ctx 上收不到。
  const seen = new Set();
  ctx.on("session/event", (session, event) => {
    const type = event?.type;
    if (type !== "user/message" && type !== "assistant/message") return undefined;
    const key = `${session?.id ?? "?"}:${event?.seq ?? "?"}`;
    if (seen.has(key)) return undefined;
    if (seen.size > 500) seen.clear();
    seen.add(key);
    try {
      const candidates = pickCandidates(messageOf(event));
      if (candidates.length === 0) return undefined;
      const agent = session?.id ? agents.get(session.id) : null;
      if (agent && typeof agent.inject === "function") {
        agent.inject(captureMessage(candidates));
        note(ctx, "captured", { count: candidates.length, at: stampSeconds(new Date()) });
      }
    } catch (error) {
      note(ctx, "capture threw", error instanceof Error ? error.message : String(error));
    }
    return undefined;
  });
}

/** 给离线冒烟测试用的小出口，不影响插件本体。 */
export const _internals = {
  SOURCE,
  KIND,
  CAPTURE_KIND,
  DEFAULT_HOME_DIRNAME,
  DEFAULT_CORE_FILES,
  DEFAULT_LEAD_FILE,
  DEFAULT_MEMO_FILE,
  DEFAULT_MEMO_SECTIONS,
  DEFAULT_DIARY_DIR,
  DEFAULT_HOME_BLOCK_FILE,
  DEFAULT_TAIL_BLOCK_FILE,
  DEFAULT_WORKNOTE_FILE,
  DEFAULT_WORKNOTE_SECTIONS,
  DEFAULT_HOME_BLOCK,
  DEFAULT_TAIL_BLOCK,
  buildWake,
  recentDiaries,
  recentMemoSections,
  blockLines,
  substituteHome,
  resolveOptions,
  wakeMessage,
  isWakeMessage,
  alreadyWoke,
  pickCandidates,
  messageOf,
  textOf,
  captureMessage,
  isCaptureMessage,
  stampSeconds,
};