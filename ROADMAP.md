# dsh-restart 未来计划

写给下一个接手这个插件的 Agent。**先读仓库根的 `DESIGN.md`（为什么是这样）与工作区的
`../AGENTS.md`（硬规则与验证手册）**，再动代码。

每条都给了「为什么」与「验收标准」。P0 是收尾，P1 是真正值得做的健壮性，P2/P3 是功能与工程。

---

## ✅ 已完成（2026-09-11）：重启后自动续跑 + 浏览器自恢复

**需求（用户原话）**：「重启后 deepseek-harness 无法自动继续任务，需要人工提醒。希望你可以实现自动化。」
即：重启完不想再发一条"继续"，也不想再手动刷新页面。设计与取舍见 `DESIGN.md` 第 11 节。

**做法**：宿主半边在受理重启时把「哪个会话要的重启」写进 `instances/<key>/resume.json`
（含 reason 与 agent preset）；新进程在 `appReady` 后先认领（写 `consumedAt`）再
`ctx.agents.resume` + `agent.followup`（`source.kind: 'plugin'`）把会话唤醒。客户端半边在
`/dsh-restart/status` 里比对宿主身份，换进程就自动 `location.reload()`，并在新页面右下角画一张
重启结果卡片。

**验收证据**：`tests/plugin.test.mjs` 33 → 80 项（六条"不该动"的路径各一条：已认领 / 已在线且繁忙 /
过期 / 别的实例 / 没有会话 / resume 抛错，外加"已在线且空闲就直接唤醒它"与
`resumeAfterRestart: false` 全关）；
`tests/client.test.mjs` 58 → 95 项（判定表含"页面比宿主还老"这条首启信号、卡片文案、
临时记录升级成终态、已读去重、拒画不抛）；`tests/lamp.browser.mjs`
25 → 34 项，其中新增的 9 项用 CDP `Fetch` **在途中改写状态响应**造出"换了进程"，断言真标签页
自己刷新、画出卡片、8 秒内不二次刷新、点 × 能关。

**仍然待做**：
- **强杀路径没有续跑意图**：CLI/HTTP 触发的重启里插件直接被杀掉，来不及写 `resume.json`。
  要么让 CLI 也能指定 `--resume-session`，要么接受这条路径仍然需要人工接着说。
- **没有服务端通知**：标签页在后台/最小化时，只有页面内的卡片，没有系统 toast。
  真要做需要 `dsh-ping` 开一条回环通知接口（跨仓库改动，验证量翻倍），目前刻意没做。
- **续跑没有次数上限**：模型连着重启两次就会连着唤醒两次。现在的护栏是新鲜度窗口 + 提示词里
  写明"没有真的坏掉就不要再重启"；如果真出现循环，再加"同一会话 N 分钟内最多唤醒 M 次"。

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

### 1.2 优雅路径的复活看门狗 —— ✅ 已完成（2026-09-11）

**问题**：工具/服务触发的优雅重启有两半 —— 插件请求 Agent 重启，然后插件自己退出、由 Agent 拉起
新进程。Agent 若死在这两半之间（就是本插件存在的那类事故），**没有任何人**会拉起新进程，
dsh 就一直停着，而且这次连报告都不会有下文。

**做法（已实现）**：`src/watchdog.ts`，第 3 个独立产物 `lib/watchdog.js`（与 Agent 同样零
harness 依赖）。插件在 `leave()` 里、真正退出**之前**用**两段式启动**把它派出去（`__spawn-detached`
→ 短命 launcher → 孤儿子进程），所以针对垂死进程树的 `taskkill /T /F` 抓不到它。
它每 `pollMs` 观察一次世界，判定规则是：

| 观察 | 判定 |
|---|---|
| `launch.json` 的 pid 是**另一个活着的**进程 | 已经有人拉起来了 → 收工（谁拉的不重要） |
| 退出的 pid 还活着 | 还没轮到它 → 继续等 |
| 问得到 Agent 且 `busy: true` | 正在跑这次重启 → 让 Agent 做完 |
| 问得到 Agent 且 `busy: false` | Agent 闲着而 harness 已经没了 → 接手 |
| 问不到 Agent，已静默 ≥ `silenceMs`（默认 10s） | 判定已死 → 接手 |

接手 = 用 `launch.json` 里记录的原样命令行（`execPath + execArgv + argv`，Web 面补 `--no-open`）
detached 拉起，输出重定向到 `logs/watchdog-relaunch-*.log`，并给子进程打上
`DSH_RESTART_WATCHDOG` 环境戳；同时把那份还停在 `in-progress` 的报告**补成终态**（`ok`，
headline 说明是看门狗救回来的，`deliveredAt` 继承，永不重复投递）。写盘证据在 `logs/watchdog.log`。

**覆盖范围（写清楚，别误以为它解决了 1.1 的全部场景）**：只覆盖**优雅路径**。
强杀路径（CLI/HTTP 触发）插件已经死了，什么都没派出去；dsh 自己崩溃时也没人请求过重启。
这两种情况剩下的信号只有灯和报告。

**验收证据**（隔离 lab：base + 保活 + 驱动 + 探测，假 Agent **接受 `/restart` 后立刻自杀**）：

```
[dsh-restart] armed the watchdog for pid 3772 (waiting up to 90000 ms for a replacement)
[dsh-restart] exiting so the control agent can relaunch this process
[watchdog.log] taking over: outgoing pid 3772 is gone, no replacement is alive,
               and the control agent has been unreachable for 10145 ms
[watchdog.log] relaunched … bin.ts --profile restart-lab (cwd <HARNESS>) as pid 31848
→ launch.json 变成 pid=31848 且 alive=True；被拉起进程自己的启动日志完整落盘
```

即"Agent 在 spawn 前死亡"后 **11 秒** dsh 自己回来了。另有 `tests/watchdog.test.mjs` **28 项**：
真跑这个二进制，覆盖接手 / 已有替代进程时收手 / 退出进程还活着时等待 / Agent 忙碌时不插手 /
Agent 闲着但没在重启时接手 / 短暂静默不算死亡 / 报告终态化并保留投递标记 / 两段式启动真的脱离，
以及命令行不合法时拒绝猜测。

**顺带修掉一个真问题**：boot 阶段那次存活探测**不只是超时**——1.5 秒预算 + 单次尝试，输了就
把活着的 Agent 判成"没在跑"。在 `autoStartAgent: false` 下这会**直接拒绝一次重启**
（lab 里复现两次），在默认配置下会**另起一个 Agent 到下一个端口**（真实日志里
`control agent ready at http://127.0.0.1:3100` 就是它）。现在：先看 pid 是否还活着（快路径，
省掉三次无用请求），再**最多问 3 次、每次 5 秒预算**。1.1 里那段专门为重试写的对账循环随之简化。

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
2. **CI** —— ✅ **已完成（2026-09-14）**：`.github/workflows/check.yml` 跑 typecheck + 四个宿主侧
   测试（agent.e2e / plugin / watchdog / client）。两个刻意的选择：`runs-on: windows-latest`
   （这个插件驱动 `taskkill`、in-box PowerShell 与 Windows toast，POSIX 分支从没在真 POSIX 机器上
   跑过 —— 一个绿色的 Linux run 证明的东西比它看起来少）、**不配 `setup-node` 的 pnpm 缓存**
   （本仓库没有 `pnpm-lock.yaml`，没有 lockfile 时缓存步骤会直接失败）。
   `tests/lamp.browser.mjs` 不入 CI：它需要一个在跑的 Web GUI 与真 Chrome，没有就跳过 ——
   **跳过不算通过**，所以留在本机跑。
3. **CHANGELOG**。
4. **发布到 npm** —— ✅ **已完成（2026-09-13）**：以 `@vanadium-23/dsh-restart@0.1.0` 上线
   （`dsh-restart` 这个名字属于 anweat，只能用 scope 别名；脚本临时改名、发完还原）。
   走通的做法：**人在真终端里跑** `node ../.scratch/publish-npm.mjs`，pnpm 对每个目标打印一条
   `Authenticate your account at: https://www.npmjs.com/auth/cli/<uuid>` + 二维码，回车 →
   浏览器过 2FA → 该包发布成功。**换凭据解决不了**（`bypass_2fa` token 与 `npm login
   --auth-type=web` 都只解决"读"），**agent 的非 TTY shell 永远过不去** —— 见 `../AGENTS.md`
   第 4.3 节与硬规则 22。
   产物已读回验证（`node ../.scratch/verify-published.mjs`：名字/版本/`repository`/
   `README`+`LICENSE` 齐全，无 `workspace:` 泄漏）。
   **免 token 发布的 workflow 已入库（2026-09-13）**：`.github/workflows/publish.yml` 用
   trusted publishing（OIDC）发布；**只剩 npm 侧的 trusted publisher 配置**（每个包一次，
   需人在浏览器里过 2FA）—— 照工作区根目录的 `TRUSTED-PUBLISHING.md` 做，里面也写了两个
   会静默失败的坑与限制（私有仓库没有 provenance、OIDC 只覆盖 publish 命令、只支持云托管运行器）。

---

## 已知取舍（**故意如此，别"顺手修"**）

- **`forceKill` 保留 `/T`**：为了带走 dsh 名下的 sandbox / 构建子进程；
  只在 `process.ppid === pid`（自己可能是目标的子进程）时降级为不带 `/T`。
- **回滚不管 `node_modules`**：回滚后多装的包留在磁盘无害，回滚配置足以让树起来。
- **基线是逐文件而不是逐目录**：复制整棵 profile 会把 `node_modules` 卷进来。
- **报告在 `appReady` 之前就写**：见硬规则 9；因此"读到 `in-progress`"是正常现象。
- **Agent 空转 30 分钟后自杀**：靠插件的 `ensureAgent` 按需重新拉起；不要改成常驻不停。

## 验收纪律

改任何东西之后：`tsc --noEmit` → 五个测试文件全绿（agent.e2e 43 + plugin 80 + watchdog 28 +
client 95 + 浏览器 34 = 280 项）→ 需要时上隔离 lab profile → 最后才动真实环境。

**客户端的改动必须跑 `tests/lamp.browser.mjs`**：0.1 那次事故证明，类型检查、单测、启动图、
字节比对可以同时全绿而灯根本不存在。它需要一个在跑的 Web GUI（`DSH_GUI_URL`，默认 3080），
没有就自动跳过 —— **跳过不算通过**。

**不要为了验证而杀死自己的会话**：要么把说明写在触发之前，
要么用异步 202 + 足够的 `stopGraceMs` 留出窗口。
