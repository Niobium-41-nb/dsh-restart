# dsh-restart

给 DeepSeek Harness 用的**进程外重启插件**。

装插件、改 `cordis.patch.yml`、动 `package.json` 之后，DSH 需要重启才能生效；重启本身又最容易出事——
一个写错的 patch 行会让整棵树起不来，而"起不来"的进程没法自救。这个插件把重启这件事交给一个
**独立的、不在 DSH 进程树里的小型控制 Agent**：它替你停进程、按原样的命令行重新拉起、盯着新进程
有没有真的起来；起不来就**回滚到上一次成功启动时的配置**再启一次，并把报错写下来交给重启后的 DSH。

```
┌──────────────────────────── DSH 进程（会被重启的那个） ────────────────────────────┐
│  dsh-restart 插件                                                                 │
│   • dsh_restart / dsh_restart_status 两个模型可调用工具                            │
│   • ctx.dshRestart 服务（给别的插件用）                                            │
│   • 每次成功启动后写一份「last-good」配置快照                                       │
│   • 启动时读取上一次的重启报告 → stderr + 系统提示词 + 工具                          │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │ HTTP（127.0.0.1，Bearer token）    记录 launch.json / tracked-files.json
                ▼
┌──────────────────────── 控制 Agent（独立进程，默认端口 3099）─────────────────────┐
│  GET  /health    存活探测（无需鉴权）                                              │
│  GET  /status    当前受管实例、基线、最近一次报告                                    │
│  POST /restart   停机 → 原样拉起 → 等 appReady 回报 → 失败则回滚重来 → 写报告         │
│  POST /ready     插件在 appReady 时回报「我起来了」                                 │
│  POST /shutdown  让 Agent 自己退出                                                 │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## 为什么必须是进程外的

- 重启的执行者不能是被重启的进程。DSH 一退出，插件就没了。
- Agent 用**两段式启动**（短命 launcher 拉起真正的 Agent 后立刻退出）脱离 DSH 的进程树，
  这样 Windows 上强杀 DSH 用的 `taskkill /T` 不会顺手把 Agent 一起杀掉。
- Agent 只依赖 Node 内建模块。**DSH 的树挂掉的时候，正是最需要它的时候**，
  所以它不能 import 任何 `@deepseek-ai/*`。

## 安装

```bash
# 在 DSH 源码目录（<HARNESS>）执行
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add file:<PLUGINS>/dsh-restart
```

`dsh-restart` 的 `package.json` 里声明了 `dsh.bundle.patch`，所以 `dsh plugin add` 会把它
自动追加进 `dsh.profile.bundles`，**不需要**再手写 `cordis.patch.yml` 的 insert 行
（两处都写会导致 `duplicate loader entry id`）。

装完需要重启一次 DSH 让插件进入组合——这一次重启之后，以后所有重启都可以交给它。

卸载：

```bash
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web remove dsh-restart
```

## 用法

### 1. 让模型自己重启

```
装好插件了，重启一下 DSH
```

模型会调用 `dsh_restart`：

| 参数 | 说明 |
|---|---|
| `reason`（必填） | 为什么要重启，会写进报告 |
| `mode` | `restart`（默认，用当前配置重启）或 `rollback`（先恢复上一次成功启动的配置再重启） |
| `rollbackOnFailure` | 新进程起不来时是否自动回滚，默认跟随插件配置 |

工具立刻返回，**但进程不会马上退出**：它会等当前这一轮对话跑完（模型把收尾回复写完、落盘），再退出交给 Agent 重启。
最长等 `exitWaitForIdleMs`（默认 180 秒），超时也会退出。

这一条是必须的：重启请求本来就发生在**一轮对话中间**，如果按定时器退出，模型的收尾回复会被拦腰砍断，
重启完回来看到的就是"对话没继续"。

### 重启后的三个行为

- **Web 面不会又弹一个浏览器标签页**：受管重启时会在命令行末尾追加 `--no-open`（只在检测到 Web 面已挂载时才加，
  这样 tui / headless 之类的 profile 不会因为不认识的参数起不来）。你本来就在看着要重启的那个页面。
- **重启结果会回到会话里**：新实例启动时读取上一次的重启报告，打进 stderr、注册成系统提示词里的一段，
  并可通过 `dsh_restart_status` 复查。
- **任务自己接着跑，页面自己回来**（默认开）：重启会同时结束这一轮对话和跑它的进程，以前的结果是
  "你得像催一下才继续" —— 现在不用了：
  - 宿主半边在受理重启时记下**是哪个会话要的重启**，新进程启动提交后把那个会话唤醒
    （`ctx.agents.resume` + 一条 `source.kind: 'plugin'` 的消息），模型从中断处继续干活；
  - 浏览器半边每 3 秒问一次宿主的身份，一旦发现回答的**已经不是加载这个页面的那个进程**，
    就自动刷新自己，并在右下角弹一张重启结果卡片（状态 / 耗时 / pid / 报告摘要）。
  详见 [DESIGN.md](DESIGN.md) 第 12 节。想关掉就配 `resumeAfterRestart: false`。

### 2. 查状态

模型可调用 `dsh_restart_status`，或直接用命令行：

```bash
node <PLUGINS>/dsh-restart/lib/agent.js status
node <PLUGINS>/dsh-restart/lib/agent.js status --json
```

### 3. DSH 已经起不来了怎么办

这正是设计里最重要的一条退路。DSH 死了，但 Agent 还在（或可以被命令行拉起来）：

```bash
# 只回滚配置并重启，不关心原因
node <PLUGINS>/dsh-restart/lib/agent.js rollback --reason "手动回退坏配置"

# 只看状态，不启动任何东西
node <PLUGINS>/dsh-restart/lib/agent.js status

# 普通重启
node <PLUGINS>/dsh-restart/lib/agent.js restart
```

> **⚠ 务必在普通终端窗口里跑，不要跑在 DSH 会话的 shell 里。**
>
> harness 给每条 shell 命令都建了带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Windows Job，
> 而 Job 成员身份会被后代继承。从会话内启动的 Agent 因此**属于那个 Job**：一旦重启需要强杀
> DSH，Job 被一并销毁，Agent 会中途死掉，DSH 就停在"已停止"状态，只能手动启动。
>
> 插件自己拉起 Agent 时没有这个问题 —— 它从 DSH 进程直接孵化（两段式启动），不在任何 shell 的
> Job 里。CLI 也做了检测：从会话内运行时会打印这条警告。
>
> 真的遇到"DSH 已停止"：直接手动启动即可（`start.bat`），配置和插件都在，不会有损坏。

### 4. 其它插件想主动重启

```ts
export const inject = ['dshRestart']

export function apply(ctx: Context) {
  ctx.inject(['dshRestart'], (scope) => {
    scope.dshRestart?.request({ reason: '我改了需要重启的东西', requestedBy: 'my-plugin' })
  })
}
```

## 侧边栏指示灯

Web GUI 侧边栏底部（Settings 旁边）有一个小圆点，显示控制 Agent 的状态：

| 灯 | 含义 |
|---|---|
| 🟢 绿点（无文字） | 守护在线，随时可以重启 |
| 🟠 琥珀 +「重启中」 | Harness 已停、守护在线 —— 正在拉起，页面会自动恢复 |
| 🔴 红 +「未运行」 | Harness 在跑但 Agent 没响应；重启不会自动拉起（下次请求重启时插件会尝试重新拉起它） |
| 🔴 红 +「无响应」 | **两边都没了** —— 不会自动恢复，请手动启动 DSH |

标签刻意只有两三个字：灯待在侧边栏底部、**只分到约 53px**（前面的条目已经占满了那一行），
再长就会被侧边栏裁掉半个字。完整的那句话在鼠标悬停的 tooltip 里（含最近一次重启的结果）。

**它直连 Agent 的 3099 端口，不经过 Harness。** 这一点是关键：页面一旦加载进浏览器，
即使 Harness 已经停了，JS 还在跑 —— 所以只有直连才能在"干等"的那一刻告诉你到底是
"正在重启"还是"永远不会回来"。鼠标悬停可以看到最近一次重启的状态。

实现上的取舍：客户端半边是手写的 lazy-CJS bundle（`client/index.js`），**只 `require('react')`**，
一个 `@deepseek-ai/dsh-client-*` 包都不依赖 —— 避免重蹈 `dsh-notification` 那个"客户端 bundle 引用
已移除的包、整个 Web 界面卡在 Failed to load plugins"的覆辙。进侧边栏的座位用
`slots.inject('sidebar.footer.action', …)` 等宿主声明（**不能**在 `apply` 里直接 `register`，
那个座位是侧边栏自己注册时才声明的），灯的圆形要额外声明 `corner-shape: round`
（宿主主题会把所有圆角平滑成 superellipse）。三条都是实测踩出来的，细节见 `DESIGN.md` 第 6 节。

Agent 的 `/health` 为此加了 CORS，且**只对回环来源**（`127.0.0.1` / `localhost` / `::1`）放行 ——
公网页面没有理由探测本机的重启守护。

> 注意：如果 DSH 绑定在 `0.0.0.0` 并从**另一台机器**的浏览器访问，指示灯会显示"无响应"，
> 因为 Agent 只监听回环。这是正确行为（那台浏览器确实够不到它），不是 bug。

## 报告怎么回到重启后的 DSH

Agent 在**每次拉起进程之前**先把报告写到 `reports/<id>.json`（状态 `in-progress`，里面已经
带着上一次尝试的失败原因、日志尾部和回滚了哪些文件）。所以刚启动的那个 DSH 在 `apply` 阶段
就能读到"我是怎么来的"。重启后的实例会把报告：

1. 打到 stderr（终端 / 启动日志里直接可见）；
2. 注册成系统提示词里的 `## DeepSeek Harness restart report` 段（模型一定会看到，且明确告知
   磁盘上的配置已经被回滚）；
3. 在 `dsh_restart_status` 里可随时复查完整报告。

报告被读过一次就会打上 `deliveredAt`，不会在每次启动时重复轰炸。

**有一种报告不会有下文**：控制 Agent 在"记下这次重启"和"拉起新进程"之间死掉 —— 那是
"DSH 停在停止状态"这个事故的签名。这种记录会永远停在 `in-progress`、`attempts` 为空，
而 `reportText` 会告诉模型"你就是被重启出来的那个实例"（对这份记录恰恰是错的）。

所以插件在启动时会认这个形状：**只有当本进程不是 Agent 拉起来的、记录里一次尝试都没有、
而且问过 Agent 它并不忙**时，才把它补成终态 `failed`（headline 说明上一个重启在启动任何进程
之前就中断了，DSH 一直停着），并在启动日志里明说。**问不到 Agent 就什么都不做** ——
"问不出来"不等于"没在跑"，宁可漏一次也不能把正在跑的重启判死。改写而不是删除：
那个文件是这件事唯一的证据。

## 看门狗：优雅重启没被接上时，它自己来

工具触发的重启里，插件是那个**必须先死掉**的进程：它请求 Agent 重启，然后退出，让 Agent 拉起
替代者。Agent 要是死在这个空档里，就没人去拉新进程了 —— dsh 一直停着，这正是这个插件存在的
那类事故。

所以退出前，插件会派一个看门狗（`lib/watchdog.js`，**两段式启动**成孤儿子进程，`taskkill /T /F`
抓不到它）看着这次重启。它的原则只有一条：**只有确定没人在做这件事时才自己上手** ——

| 它看到 | 它做什么 |
|---|---|
| `launch.json` 里是另一个活着的进程 | 收工（Agent、CLI、你自己拉的都算） |
| 退出中的进程还活着 | 等 |
| Agent 答"正在重启" | 等它做完 |
| Agent 答"我闲着"，而 harness 已经没了 | 用原样命令行把 dsh 拉起来 |
| Agent 静默超过 10 秒 | 当它死了，拉起来 |

拉起时它顺手把那份没下文的报告补成终态（`ok`，说明是看门狗救回来的），并把过程写进
`<state>/logs/watchdog.log`，被拉起进程自己的输出在 `logs/watchdog-relaunch-*.log`。
它**只覆盖优雅重启**：CLI/HTTP 触发的强杀路径上插件已经死了，什么都没派出去；dsh 自己崩溃时
也没人请求过重启。配置项：`watchdog`（默认开）、`watchdogWaitMs`（默认 120000）。

## 回滚基线（last-known-good）的语义

- 快照**只在一个进程真的提交了启动之后**才写（`ctx.appReady` 回调），所以基线里的配置一定是
  "曾经成功起来过的"。
- 重启失败时，回滚的目标是**上一次成功启动时的配置**，也就是你这次改动之前的状态。
- 默认跟踪的文件：

  | 文件 | 说明 |
  |---|---|
  | `<profile>/cordis.patch.yml` | 该 profile 的用户补丁层 |
  | `<profile>/package.json` | 插件依赖 + bundle 列表 |
  | `<profile>/pnpm-lock.yaml` | 锁文件 |
  | `<profile>/pnpm-workspace.yaml` | pnpm 配置（`patchedDependencies` 等） |
  | `$DSH_HOME/cordis.patch.yml` | 机器级用户补丁层 |

  `node_modules` **不**在快照范围内：回滚后多装的包留在磁盘上无害，而回滚配置本身就能让
  树重新起来。

## 配置项

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: dsh-restart
  config:
    port: 3099              # 控制 Agent 首选端口（被占用时自动 +1 往后找）
    autoStartAgent: true    # 启动时自动拉起 Agent
    readyTimeoutMs: 180000  # 单次启动的"起来了吗"预算
    stopGraceMs: 20000      # 等旧进程自己优雅退出的时间，超时才强杀
    exitDelayMs: 1200       # 回合结束后再等多久才真正退出
    exitWaitForIdleMs: 180000 # 最多等当前回合跑完多久（超时也退出）
    rollbackOnFailure: true # 新进程起不来时自动回滚
    deliverReports: true    # 启动时把上次的报告交给模型
    promptSection: true     # 报告是否进系统提示词
    captureEnvironment: true# launch.json 是否记录完整环境变量
    trackedPaths: []        # 额外要跟踪/回滚的文件（支持 ~）
    trackedDirectories: []  # 额外要跟踪的目录（一层深，跳过 node_modules）
    idleExitMs: 1800000     # Agent 空转多久后自己退出
    exposeWebRoute: true    # 暴露 GET /api/dsh-restart/status
    resumeAfterRestart: true# 重启后唤醒提出请求的会话，让任务自己接着跑
    resumeWindowMs: 900000  # 续跑意图的有效期（超过就当历史记录，不再自动开一轮）
```

## 状态目录

默认 `$DSH_HOME/dsh-restart`（可用 `DSH_RESTART_STATE_DIR` 覆盖）：

```
dsh-restart/
├── agent.json                    # 控制 Agent 的 pid / 端口 / 启动时间
├── token                         # 控制令牌
├── logs/agent.log                # Agent 自己的日志
├── reports/<id>.json             # 每次重启的报告（保留最近 30 份）
└── instances/<key>/              # 每个 DSH 实例一份，互不干扰
    ├── launch.json               # 原样重启所需的 argv / cwd / env
    ├── tracked-files.json        # 该实例跟踪哪些配置
    ├── resume.json               # 这次重启是哪个会话提的（新进程据此唤醒它）
    └── last-good/                # 回滚基线（manifest.json + files/）
```

<instances> 按 profile 目录哈希分桶：同时开着 web 和 tui 两个 profile 时，一个实例的重启
不会用错另一个实例的命令行，也不会回滚掉另一个实例的配置。

## 安全边界

- 控制 Agent 只监听 `127.0.0.1`，并且**拒绝非回环来源**。
- 除 `/health` 外所有接口都要 Bearer token（`$DSH_HOME/dsh-restart/token`）。
- `captureEnvironment: true`（默认）会把启动时的环境变量写进 `instances/<key>/launch.json`
  —— 这是"原样重启"的前提（本机实测 97 个变量，含 PATH、代理，以及任何 `DEEPSEEK_*` 之类的
  凭据）。文件按 `0600` 创建，但**Windows 不认 Unix 权限位**：实际保护来自 `~/.dsh` 继承下来的
  用户 ACL，和 `.credentials.yaml`、`settings.yaml` 同一级别（当前用户 + SYSTEM +
  Administrators）。不希望环境变量落盘就设 `captureEnvironment: false`，此时 Agent 用它自己
  继承到的环境启动 DSH。

## 故障排查

| 现象 | 处理 |
|---|---|
| `the restart control agent is not running` | 手动 `node lib/agent.js serve`，或确认 3099 端口没被别的程序占着 |
| 重启后 DSH 没起来，报告是 `failed` | 看 `reports/<id>.json` 里 `attempts[].logFile` 指的日志；用 `rollback` 子命令强制回退 |
| 报告说 `readiness arrived late` | 启动比 `readyTimeoutMs` 慢，调大它 |
| 想彻底停掉 Agent | `node lib/agent.js stop`，或等 `idleExitMs` 空转退出 |

## 开发

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # 类型检查
node node_modules/typescript/bin/tsc -b tsconfig.json            # 编译到 lib/types
node node_modules/tsdown/dist/run.mjs                            # 打包 lib/index.js + lib/agent.js
node tests/agent.e2e.mjs                                         # 43 项：Agent 侧（假 harness + CORS 行为）
node --experimental-strip-types tests/plugin.test.mjs            # 33 项：插件侧（假 Agent HTTP 服务、启动对账、看门狗派发）
node tests/watchdog.test.mjs                                     # 28 项：看门狗二进制（真的跑它，覆盖六种判定）
node tests/client.test.mjs                                       # 58 项：客户端指示灯（stub window + slots）
node tests/lamp.browser.mjs                                      # 25 项：真浏览器里的四种灯态（无 GUI 时跳过）
```

`tests/lamp.browser.mjs` 是唯一能证明"灯真的画出来了"的检查：**它开一个无头 Chrome，用 CDP
把四种状态逐个截出来**，断言颜色、文案、圆形，以及文案没有被侧边栏裁掉。四种状态是靠
**在浏览器里拦请求**造出来的（不给 3099 或 `/dsh-restart/status` 放行），所以它**不会动真实
的 Agent**，随时可以跑。它需要 Web GUI 在跑（`DSH_GUI_URL`，默认 3080），需要 Chrome
（`CHROME_PATH`），没有就跳过 —— 单测和字节比对曾经全绿而灯根本没出现，这个检查就是为
那件事写的。

`node_modules` 里的 `@deepseek-ai/*` 是指向 `<HARNESS>` 的 junction，仅用于编译期类型。

**改完代码要让 profile 用上新构建**：pnpm 对 `file:` 依赖是按内容快照安装的，直接再跑一次
`add` 会说 "Already up to date" 而不重新拷贝。必须 remove 再 add：

```bash
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web remove dsh-restart
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add file:<PLUGINS>/dsh-restart
```

改的只是 Agent 侧（`lib/agent.js`）时不需要重装：Agent 是每次按需从
`instances/<key>` 旁边的入口拉起的，重启 DSH 后新进程会用新代码。
插件侧（`lib/index.js`）必须走上面的重装流程 + 一次重启。

接下来要做什么，见 [ROADMAP.md](ROADMAP.md)；工作区级的硬规则与验证手册见 `../AGENTS.md`。

详见 [DESIGN.md](DESIGN.md)。
