# dsh-restart 未来计划

写给下一个接手这个插件的 Agent。**先读仓库根的 `DESIGN.md`（为什么是这样）与工作区的
`../AGENTS.md`（硬规则与验证手册）**，再动代码。

每条都给了「为什么」与「验收标准」。P0 是收尾，P1 是真正值得做的健壮性，P2/P3 是功能与工程。

---

## P0 — 收尾：两件已实现但未亲眼验证的事（0.1 已完成）

### 0.1 侧边栏指示灯的视觉确认 —— ✅ 已完成（2026-09-11），而且**查出一个真 bug**

**结果**：灯**从来没有画出来过**。单测、类型检查、启动图、服务端字节比对全部通过，
浏览器控制台里却只有一行 warning：

```
[dsh-restart] could not register the supervisor indicator: Error: slot "sidebar.footer.action"
is not declared (a parent entry's children table must declare it)
```

`slots.register` 要求槽位**已被声明**，而这个座位是侧边栏注册自己的 entry 时才声明的；
插件之间 apply 顺序不是契约，抢跑就抛异常 —— 而 `apply` 里的 `try/catch` 把它降级成一行
warning，于是"没有灯"看起来和"灯坏了"一样安静。

**修法**（三处，都已入库）：
1. `slots.inject('sidebar.footer.action', …)` 等声明，而不是直接注册（同 `dsh-cost-meter`、
   `dsh-model-scheduler` 的写法）；
2. 灯的点要额外声明 `corner-shape: round`：宿主主题把**所有**圆角平滑成 superellipse，
   `border-radius: 50%` 渲染出来是圆角方块（8px 与 40px 对照元素都是，不是尺寸问题）；
3. 文案压到 2–3 个字并去掉横向内边距：那一行前面的条目已经占掉 215px，灯只有 ~53px，
   `守护在线 · DSH 重启中` 会被侧边栏切掉半个字（完整句子留在 tooltip）。

**验收证据**：新增 `tests/lamp.browser.mjs`（25 项）—— 真 Chrome + CDP 打开真 GUI，四种状态
逐个截图并断言颜色 / 文案 / 圆形 / 不被裁切；状态由**浏览器内拦请求**造出（拦 3099 或
`/dsh-restart/status`），**不会停真实 Agent**。另外手动做过一次"真停 Agent → 变红 → 用
`dsh_restart_status` 让插件把它拉回来 → 变绿"的闭环（同一张打开的页面，没有刷新）。
客户端单测从 31 项涨到 58 项（新增声明时序、圆形、省略号三条契约的回归）。

**顺带确认**：手写 `client/index.js` 的改动**不需要重启 DSH** —— 宿主的 client-HMR 每 500ms
轮询 bundle 的 stat，重新哈希后经 SSE 通知浏览器重取（实测 rev 从 `28e1db08b1d0` 一路变到
`cd4a7048d5f2`，页面照常）。这给未来改客户端半边省下一整轮重启。

### 0.2 「退出前等回合结束」的真实链路验证

**现状**：有 3 条单测（运行中不退 / 结束才退 / 子代理不阻塞 / 超时封顶），
但**一次真实的工具触发重启都还没走到它**——之前那几次重启分别是手动、CLI、和一次误触发。

**验收**：调用 `dsh_restart` 之后：
- 模型的收尾回复**出现在会话里**（不是被砍断）；
- `agent.log` 里第一次 spawn 的时刻 = 回合结束时刻（而不是工具返回后固定 1.2 秒）；
- 新进程起来后报告 `ok`。

---

## P1 — 健壮性：把"Agent 中途死亡"这条路的损失降到最低

### 1.1 中断重启的自动对账 —— ✅ 已完成（2026-09-11）

**问题**：`agent.log` 停在 `forcing termination`、报告永停 `in-progress`、`attempts` 为空 ——
这就是"Agent 在启动新进程之前死了，dsh 被留在停止状态"。以前只能靠人去看文件才发现。

**做法（已实现）**：boot 阶段检测候选记录 —— `in-progress` **且** `attempts.length === 0`
**且本进程没有 `DSH_RESTART_ATTEMPT`**（有它就说明这次启动是 Agent 拉起来的，重启没有"中断在
spawn 之前"）—— 然后**先问 Agent**：能问到且 `busy === false`、且它手上的最新报告就是这一份，
就把记录补成终态 `failed`（headline 说明"上一个重启在启动任何进程之前就中断了，DSH 一直停着"，
`error` 写明判定依据），日志明说，并让这份报告照常在本轮投递给模型
（`reportText` 对 `in-progress` 会写"你就是被重启出来的那个实例"——对中断记录恰恰是错的）。

**判定条件为什么是这几条**（每条都对着一个真实误判面）：
- `attempts` 只在**尝试结算时**追加，所以"空 attempts"本身证明不了任何事 —— 正常重启中，
  被它拉起来的那个进程读到的就是这个形状；分隔两者的是环境变量与 `busy`。
- Agent 问不到（例如 `autoStartAgent: false` 又没有 Agent 在跑）时是"问不出来"，不是"没在跑"：
  **保持原样**，只记一行日志。宁可漏一次，也不能把正在跑的重启判死。
- 关闭只发生在 `deliverReports` 打开时（关掉投递的人要的是"别在启动路径里动手"）。

**验收证据**：
- `tests/plugin.test.mjs` 新增 14 项（15 → 29）：关闭、忙碌不关闭、`DSH_RESTART_ATTEMPT` 不关闭、
  有 attempt 不关闭、问不到不关闭、终态不关闭；控制 Agent 是**真实 HTTP 服务**，判定是隔着网络断言的。
- **隔离 lab profile 实测**（`restart-lab`：base + 保活 + 一个假 Agent 回答 `/status`，`autoStartAgent: false`
  以免真的拉起守护；报告预置成 `in-progress` + 空 attempts）：boot 后报告落成
  `status: "failed"` + headline/error，stderr 打印
  `closed interrupted restart …: it was left 'in-progress' with no attempts and no restart is running`，
  系统提示词的报告段也拿到了终态文本。用完即删，无残留进程。

**顺带查出一个真问题（已修）**：boot 阶段的 1.5 秒存活探测**会输给启动时的模块编译**。
lab 里同一个配置连跑 4 次全失败（日志里是"no control agent answers"），而只要在插件前面多插一个
插件就 6 次全成功 —— 探测被压在进程最忙的那一刻。于是对账时改成**最多问 3 次**（每次 5 秒预算、
间隔 500ms），并把"问不到"与"没在跑"分开。修完在同一个曾经必败的配置下连跑即通过。
代价：只有在**已经是候选记录**时才付这几秒，正常启动路径完全不受影响。

### 1.2 优雅路径的复活看门狗

**做法**：在 `scheduleExit()` 里、请求退出**之前**，孵化一个 detached 看门狗：
等旧进程消失后，若 `launch.json` 里的 pid 在 N 秒内没有变成"活着的新进程"，就用记录的命令行拉起 dsh。
插件此时还在进程内（不在任何 shell 的 Job 里），所以看门狗不会被 Job 连带杀死。

**覆盖范围**：只覆盖「工具/服务触发的优雅重启」；**覆盖不到强杀路径**（那时插件已死）。
写清楚这一点，别让人误以为它解决了 1.1 的全部场景。

**验收**：杀掉 Agent（模拟"Agent 在 spawn 前死亡"）后触发一次工具重启，dsh 能在 N 秒内自行恢复。

### 1.3 Job 继承的自动检测（可选，成本高）

`IsProcessInJob` 需要 FFI；harness 自带 `dsh-win32-process`，但**规则 4 要求 Agent 零依赖**，
所以不能在 Agent 里用。现状是"两段式启动保证正常路径安全 + CLI 祖先链警告"。

若要做，可以考虑：把检测放进 **CLI**（它的祖先链完整，已经能可靠检测），
或者在 Agent 启动时记录祖先链可疑与否放进 `agent.json`，让插件决定要不要复用它。
**不要**为了这个把 Agent 变成需要编译/FFI 的进程。

### 1.4 `launch.json` 的并发写入

现在是 last-writer-wins。同 profile 的双实例是病态场景（第二个必然 bind 失败），
但可以让每个实例写 `instances/<key>/launch-<pid>.json`，Agent 按请求里的 pid 选取。
是否值得做取决于是否真的会同时开两个同 profile 实例。

---

## P2 — 功能

| 项 | 想法 | 说明 |
|---|---|---|
| 可点击的指示灯 | 点一下 = 请求重启 | 插槽是 `list` 类型，可放按钮；调用宿主路由触发，需要给路由加鉴权 |
| 定时/延迟重启 | `dsh_restart` 增加 `after`（下一轮开始前 / 指定时刻） | goal 循环场景有用 |
| CLI `--wait` | 打印最终报告后退出 | 现在 `restart` 已经 wait，但输出可以更完整 |
| 报告保留策略可配 | 现在硬编码 30 份 | 顺带给 `attempts[].logTail` 加显式上限（现在 6000 字符） |
| 非 Windows 验证 | POSIX 分支已有（SIGKILL、无 toast），但没在真实 Linux/macOS 上跑过 | 至少要跑一遍 `agent.e2e.mjs` |

---

## P3 — 工程

1. **抽 `dsh-plugin-kit`**：状态目录解析、原子写、哈希/快照、PowerShell 调用与 base64 编码、
   客户端 bundle 脚手架 —— 现在两个插件各写了一遍（`fsx.ts` / `paths.ts` / `snapshot.ts` 几乎可原样共享）。
   注意：`dsh-ping` 刻意不依赖任何本地包，抽包时要保留"可以被单文件复制"的选项。
2. **CI**：`.github/workflows/check.yml`（同级仓库 `dsh-html-output` 有范本）跑 typecheck + 单测；
   `toast.e2e.mjs` 需要 Windows + 真实桌面，CI 里跳过。
3. **CHANGELOG**。

---

## 已知取舍（**故意如此，别"顺手修"**）

- **`forceKill` 保留 `/T`**：为了带走 dsh 名下的 sandbox / 构建子进程；
  只在 `process.ppid === pid`（自己可能是目标的子进程）时降级为不带 `/T`。
- **回滚不管 `node_modules`**：回滚后多装的包留在磁盘无害，回滚配置足以让树起来。
- **基线是逐文件而不是逐目录**：复制整棵 profile 会把 `node_modules` 卷进来。
- **报告在 `appReady` 之前就写**：见硬规则 9；因此"读到 `in-progress`"是正常现象。
- **Agent 空转 30 分钟后自杀**：靠插件的 `ensureAgent` 按需重新拉起；不要改成常驻不停。

## 验收纪律

改任何东西之后：`tsc --noEmit` → 四个测试文件全绿（43 + 15 + 58 + 25 浏览器）→ 需要时上隔离
lab profile → 最后才动真实环境。

**客户端的改动必须跑 `tests/lamp.browser.mjs`**：0.1 那次事故证明，类型检查、单测、启动图、
字节比对可以同时全绿而灯根本不存在。它需要一个在跑的 Web GUI（`DSH_GUI_URL`，默认 3080），
没有就自动跳过 —— **跳过不算通过**。

**不要为了验证而杀死自己的会话**：要么把说明写在触发之前，
要么用异步 202 + 足够的 `stopGraceMs` 留出窗口。
