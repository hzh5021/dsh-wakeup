# dsh-wakeup

每开一段新对话，自动把「家」读一遍，塞进会话开头。给 DSH（DeepSeek Harness）用的插件。

> 中文 · [English](#english)

> On every new conversation, read your home folder — identity, house rules, mistake log,
> recent diary — and inject it into the session *before* anyone speaks.

---

> **给 AI 的**：主人把这个文件夹丢进来，意思是「装上它，然后照它说的把我的 AI 配起来」。
> **读 `装我.md`，照它做** —— 那份是给你的剧本，包含安装、验证、重启、以及重启之后
> 怎么用问答题把主人的人格填起来。重启之后不用谁记着催：家里还留着「接入还没做完」
> 那段标记时，插件会每一局把「先问第一题」摆在起床包的最后一段，你照着问就行。
> 人要看的说明在 `使用说明.md`。

## 最快装法

```bash
node install.mjs          # 想先看它要做什么：node install.mjs --dry-run
```

一条命令办完：复制插件、登记 profile、写配置、跑 `pnpm install`、在**桌面**上把家建起来、
再跑一遍自检。家里放了形象图（`门面设定.png`），桌面那个家文件夹的图标就换成它 ——
桌面上坐着一张脸，而不是一个黄文件夹。**唯一要人动手的是重启一次 DSH。**

也可以什么都不敲 —— 把这个文件夹整段丢进 DSH 的新对话，跟它说
「按 `装我.md` 把你自己装上」。它会读剧本、自己装好、重启之后接着采访你。

## 手工装（四步）

（跑 `install.mjs` 的话这四步它都替你做了。这段留着，用来弄明白它每一步在改什么，
或者装到一半要自己接手时看。）

## 为什么

规矩都在文件里、也读得到，可「先读一遍」这件事靠自觉。新会话一开局直接开口、忘了翻账，
是最常见的翻车方式 —— 明明家就在那儿，它还是会答错「我是谁」。
这个插件把「起床」从自觉改成机器动作：agent 一建起来，自己去读家、塞进会话，然后才轮到人说话。

## 家里那几本账怎么分

人格（它是谁）、语义（怎么说话、同类事怎么判）、情节（哪一天发生了什么）、
程序（怎么干活）—— 四层各有各的寿命，哪本该淡、哪本一个字都不能动，就清楚了。

`示例家/README.md` 里有那张表；`使用说明.md` 第三节讲实际怎么用：
情节层靠**巩固**往下压（旧的搬 `记忆档案/`，原文一字不动），
语义层靠**提炼**往上长（同一号病犯第二回，就抽一句判据进 `判据集.md`）。

## 装（四步）

1. 把整个 `dsh-wakeup/` 放进插件目录：`~/.dsh/plugins/dsh-wakeup/`；
2. 在 profile 的 `package.json` 里登记两处：
   `dependencies` 加 `"dsh-wakeup": "file:../../plugins/dsh-wakeup"`，
   `dsh.profile.bundles` 数组里加 `"dsh-wakeup"`；
3. 照 `示例家/` 抄一个家，在 profile 的 `cordis.patch.yml` 里指过去：
   ```yaml
   - id: wakeup
     config:
       home: D:\我的家
   ```
   **不知道该往家里写什么？** 打开 `接入问答.md` —— 十来道问答题，
   答完第一批 6 题就能跑。也可以把那份整段丢给 agent，让它一次一题地采访你。
4. 重启 DSH。

**完整说明**（配置项全表、家目录结构、注入包长什么样、边界与常见问题）见 **[使用说明.md](使用说明.md)**。

## 验

```bash
cd ~/.dsh/plugins/dsh-wakeup
node test/smoke.mjs
```

不启动 DSH，自己在临时目录里搭一个假家，跑 14 项检查：读家、排序、模板、截断、
注入去重、跳过 subagent、抓「记住」、工作笔记…… 全过会打印 `OK —— 14 项全过`。
它**不碰你的真实家目录**。

## 目录

```
dsh-wakeup/
├── lib/index.js          插件本体（只用 node 内置模块）
├── package.json
├── cordis.patch.yml      bundle 补丁
├── test/smoke.mjs        离线冒烟测试
├── 使用说明.md / .docx    完整文档（Word 版是同一份）
├── 接入问答.md / .docx    新接入的人照着答，一步步填出自己的家
├── README.md             这份
├── LICENSE               MIT
└── 示例家/               起步用的家目录模板
    ├── README.md         记忆分层那张表（人格 / 语义 / 情节 / 程序）
    ├── 灵魂设定.md        说话的规矩.md   判据集.md
    ├── 错题集.md          成长记录.md     长期记忆库.md   感官记忆.md
    ├── 操作手册.md        程序层：不进起床包，用到时翻
    ├── 记忆档案/          情节层的冷冻层（搬过来的旧节，原文不动）
    ├── 家门.md 收尾.md    （可选）替换注入包里那两段
    └── 日记/
```

（再往家里放一张 `门面设定.png` —— 它的样子，也是桌面上那个家的图标。）

## 边界

- 只读：它不改你的任何文件；
- 只在创建 agent 时注入一次，resume / fork 不重复，subagent 不注入；
- 不做检索、不做索引、不做存储 —— 那是别的插件的事；
- 家文件每轮都在上下文里，**家越厚越贵**，别往里放长文和敏感数据。

## English

**dsh-wakeup** is a [DSH](https://github.com/topics/dsh-plugin) (DeepSeek Harness) plugin. On every new
conversation it reads your home folder — identity, house rules, decision rules, mistake log, recent
diary and ledger — and injects it into the session *before* anyone speaks. The home is a plain folder
of Markdown files, and it stays writable: whatever the agent settles during a conversation is written
back to it, so the persona it wakes up with next time is the one it amended itself.

- **Install** — `node install.mjs` copies the plugin, registers it in the profile, builds a starter
  home on your Desktop and runs a self-check; only a DSH restart is left to you. `装我.md` is the
  same procedure written as a script an agent can follow on its own. The manual four-step install
  and the full config table live in `使用说明.md`.
- **Configure** — `home` (path to the home folder), `coreFiles` (which files to read), `diaryDays`
  (how many diary entries), `memoSections` (how many recent ledger sections), `worknoteFile` /
  `worknoteSections` (an optional note outside the home folder), `maxChars` (injection budget).
- **Requirements** — DSH with a `dsh.bundle`-aware loader (this package declares one), Node 18+.
- **Boundaries** — the plugin itself only reads; it injects once per newly created agent, not on
  resume or fork, and never into subagents. It does no indexing, retrieval or storage. Everything
  read lands in context every turn, so a thick home is expensive — keep long or sensitive text out
  of it.
- **License** — MIT.

MIT 许可，随便改。