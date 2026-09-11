# dsh-restart 设计说明

这份文档记录"为什么是这样"，以及实现过程中被真实事故逼出来的三个修正。想快速上手看
[README.md](README.md)。

## 1. 问题定义

DSH 的配置是**组合式**的：一个 profile 由 bundle 层 + 用户补丁层叠加成插件树。改变组合
（装/卸插件、改 `dsh.profile.bundles`、加 `insert` 行）需要新进程才能生效，因为：

- 新装的包要重新走模块解析；
- `dsh.profile.bundles` 是启动时读的，HMR 只监听用户补丁文件；
- 相当一部分配置在启动时被冻结。

而重启是**唯一会让 DSH 失去自救能力**的操作：如果新进程起不来，没有任何一个活着的 DSH 能
把配置改回去。所以执行者必须在进程外。

## 2. 职责切分

| 组件 | 知道什么 | 不知道什么 |
|---|---|---|
| host 插件 | profile 目录、跟踪哪些文件、这次启动是否成功（`appReady`） | 怎么停进程、怎么拉起、怎么回滚 |
| 控制 Agent | 怎么停/拉/等/回滚/写报告 | profile 是什么、该跟踪哪些文件 |

这条线画在**"谁在进程里"**上：任何需要"重启之后还活着"的逻辑都必须落在 Agent 侧；任何需要
读 Cordis 上下文的逻辑都必须落在插件侧。`tracked-files.json` 就是这个契约的载体——插件把
"该跟踪哪些文件"写下来，Agent 照做。

## 3. 重启协议

```
POST /restart (202)                     ┌─ 写 in-progress 报告（attempts 里带上一次失败）
   │                                    │
   ├─ 停旧进程：先等优雅退出（不给信号），超时才强杀
   │                                    │
   ├─ spawn(execPath, [...execArgv, ...argv], {cwd, env + DSH_RESTART_*})
   │     注入：DSH_RESTART_AGENT / DSH_RESTART_TOKEN / DSH_RESTART_ATTEMPT
   │                                    │
   └─ 等三种结果之一：
        · POST /ready（attempt 匹配）   → 再观察 settleMs，没崩才算 ready  ★权威信号
        · HTTP 探测 healthUrl 有响应    → 观察 settleMs → ready-unconfirmed  ☆兜底信号
        · 进程 exit / 超时              → 失败
                                          │
失败 → 恢复 last-good 基线 → 再写一份 in-progress 报告 → 第二次 spawn → 同样判定
                                          │
最终 → 写终态报告（ok / rolled-back / failed），把 deliveredAt 从旧文件继承过来
```

**为什么 `ready` 是权威信号**：只有插件自己的 `ctx.appReady` 回调能证明"整棵插件树挂载
成功且启动已提交"。HTTP 探测只能证明"某个端口在响应"，一个半死的树也能有端口。兜底信号
存在的唯一理由是：万一这次改动把插件本身删掉了，也不能因此判定重启失败并把配置回滚。

**为什么强杀前先干等**：Windows 上 Node 的 `SIGTERM` 就是 `TerminateProcess`，不优雅。真正
能让 DSH 优雅退出的只有 `ctx.appExit(0)`（插件在受理重启后自己调用），所以 Agent 先给
`stopGraceMs` 的静默窗口，让那条路走完，再动 `taskkill /F`。会话日志、storage 落盘都靠这一步。

## 4. 受管重启与人工重启的差别

有两件事只有在"这次启动是被人为重启的"前提下才成立，插件因此必须显式告诉 Agent，而不是让它照抄命令行。

### 4.1 不能又开一个浏览器标签页

Web 面的 `openBrowser` 来自命令行开关（`openBrowser: !!js ctx.webStartup.openBrowser`，由 `--no-open` 置为
false）。Agent 复用的是启动时记录的 argv，于是每次受管重启都会再弹一个标签页 —— 而用户本来就在看着那个页面。

修法：`POST /restart` 增加 `appendArgs`，插件在**检测到 Web 面已挂载**（`webServer` 或 `webStartup` 服务存在）
时追加 `--no-open`，Agent 把它拼到 `[...execArgv, ...argv, ...appendArgs]` 后面。

这个判断条件不能省：`--no-open` 是 Web app 自己的参数，对 tui / headless 的命令行来说是未知参数，
commander 会直接报用法错误、整棵树起不来。所以"有没有 Web 面"必须由插件（它看得见服务）判定，
而不是让 Agent（它只会拼字符串）去猜。

### 4.2 退出前必须等回合结束

第一版是"工具返回后 1200 ms 退出"。但重启请求天然发生在**一轮对话中间**：模型调用工具之后还要写收尾回复，
定时退出把这个回复砍掉了，用户看到的就是"重启后对话没继续"。

修法：插件订阅 `agent/status`，维护"正在运行的根代理"集合；`scheduleExit` 轮询到集合为空
（或超过 `exitWaitForIdleMs`）才请求退出，之后再用 `exitDelayMs` 给最后一条消息留出落盘时间。

两个细节：

- **只等根代理。** 子代理是在父代理的回合里跑的，父代理必然也是 running；只统计根代理既够用，
  又不会被一个长跑的子代理拖住（用 `parentAgent` / `options.origin === 'subagent'` 双重判定）。
- **必须封顶。** 模型完全可能调完 `dsh_restart` 又继续干活；`exitWaitForIdleMs` 保证最坏情况下仍会退出，
  只是日志里会记一条"仍在运行，照样退出"。

## 5. 控制 Agent 绝不能待在别人的 Windows Job 里

这是用一次真实的失败换来的：一次重启把 DSH 杀掉了、却没把新的拉起来，最后是手动启动的。

现象：报告永远停在 `in-progress`、`attempts` 为空、没有任何 attempt 日志，`agent.log` 的最后一行
正好是 `pid 29560 is still running after 45000 ms; forcing termination`。

根因不在插件，而在**是谁启动了 Agent**。harness 的 `subprocess-local` 给每条 shell 命令都建一个
Windows Job，并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
（它自己的 README 也写明"普通后代默认继承 Job"）。那次 Agent 是从 **DSH 会话内的 shell** 里启动的，
于是继承了那个 Job；`taskkill /T /F` 结束 DSH 时 Job 被销毁，Agent 被连带杀死 —— 它正准备启动新进程。

两条路径的差别就是全部答案：

| Agent 的启动者 | 在 Job 里吗 | 强杀 DSH 时 |
|---|---|---|
| 插件（两段式，从 DSH 进程直接孵化） | 否 | 存活 ✓ |
| 会话内 shell 里手敲的 CLI | 是 | 一起死 ✗ |

所以：

- **正常路径本来就是安全的**，不需要改。实验室测试、e2e、以及后来一次真实重启（22:05）都验证了
  插件孵化的 Agent 能在强杀中存活。
- **危险的只有"在会话内手敲 CLI"**，而 CLI 的祖先链是完整的，可以可靠检测。于是 CLI 在真正需要
  新建 Agent 之前会走一遍祖先链，发现 harness 就打印警告，并指出记录下来的启动命令。
- 检测有反例测试：从 explorer.exe 的进程链走一遍必须**不**误报。

一个诱人的"修法"是让 Agent 自己逃离 Job —— 做不到：Job 成员身份只能通过 `CREATE_BREAKAWAY_FROM_JOB`
摆脱，而那是 `CreateProcess` 的标志位，Node 的 `spawn` 不暴露它。所以正确的做法是**不要在那个环境里
启动它**，而不是事后补救。

## 6. 指示灯为什么直连 Agent

需求来自一次真实的等待：重启失败后 Harness 停在停止状态，页面一直转圈，用户不知道
"是在重启"还是"永远不会回来"。

能回答这个问题的只有浏览器自己。页面一旦加载，JS 就独立于 Harness 的连接活着 —— 所以指示灯
**直接探测 `http://127.0.0.1:3099/health`**，而不是问宿主。四个状态里有三个是"宿主已经问不到了"
的场景，全靠这条直连：

| 探测结果 | 状态 | 用户该做什么 |
|---|---|---|
| Agent ✓ 宿主 ✓ | ready | 无事，可随时重启 |
| Agent ✓ 宿主 ✗ | restarting | 等着，会自动恢复 |
| Agent ✗ 宿主 ✓ | agent-down | 重启不会自动拉起（下次请求时会重试拉起） |
| Agent ✗ 宿主 ✗ | unreachable | **必须手动启动** |

代价是跨源请求（页面在 3080，Agent 在 3099），所以 `/health` 增加了 CORS —— 但**只对回环
Origin 放行**，并且 `/health` 本来就不含任何敏感信息（pid/端口/启动时间/是否忙碌）。
`/status` 仍然需要 Bearer token，浏览器不碰它。

客户端半边刻意做成手写 lazy-CJS（`window.__ModuleLoader__.load`），只 `require('react')`：
`dsh.client.inject` 声明为空数组，`slots` 通过作用域 `ctx.inject(['slots'])` 获取，拿不到就静默不注册。
这样它不可能因为某个内部包改名而让整个 Web 客户端加载失败 —— 那正是这台机器上
`dsh-notification` 当初坏掉的方式。

宿主侧另开了一条 `/dsh-restart/status`（插件命名空间，不走 `/api`，避免撞上连接插件的请求围栏），
只返回 Agent 地址 + 最近一次重启的状态摘要，供指示灯在 Harness 在线时校准 URL 与文案。

### 6.1 座位是**声明**出来的，所以必须 `slots.inject`

第一版客户端半边在 `apply` 里直接 `scope.slots.register({ name: 'sidebar.footer.action', … })`。
它**什么都没画出来**，而且不报错给人看 —— 只有浏览器控制台里一行 warning：

```
[dsh-restart] could not register the supervisor indicator: Error: slot "sidebar.footer.action"
is not declared (a parent entry's children table must declare it)
```

原因是这个座位属于**另一个 entry**：侧边栏在它自己的 `apply` 里注册 `sidebar` 这个 entry 时，
才用 `children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } }` 把它声明出来。
插件之间的 apply 顺序不是契约，抢跑就输。

正确写法是 `slots.inject(key, callback)`：**声明已经存在就同步调用，否则在声明提交时调用**
（声明塌掉再重建还会再调一次），回调返回的就是注销函数。作者本机另一个插件
（`dsh-model-scheduler`）用的就是这个形式，`dsh-cost-meter` 也是 —— 只有这个插件写错了。

这件事的教训不是"漏了 try/catch"，而是**验证层级**：类型检查、单测、启动图、服务端字节比对
全部通过，灯依然不存在。只有真浏览器能把"注册了"和"画出来了"分开 —— 于是有了
`tests/lamp.browser.mjs`（见第 11 节）。

### 6.2 主题会把圆角磨成 superellipse，正圆要自己声明回来

`ui-theme` 的 `corner-shape.css` 在 `@supports (corner-shape: superellipse(1.5))` 里对
`*` 施加 `corner-shape`：**所有圆角都被平滑成超椭圆**。于是 `border-radius: 50%` 渲染出来是
一个圆角方块 —— 实测在 8px 的灯上是这样，40px 的对照元素也是这样，所以不是尺寸问题。

要正圆就得配对声明 `corner-shape: round`（宿主自己的 `StateDot` 就是这么做的）。灯的价值
有一半在"形状一眼可辨"，所以这条必须照做。

### 6.3 侧边栏底部只给得起 ~53px

那一行（`footerActions`）是横向排布，前面的条目（成本看板的余额/今日两行、另一个插件的
entry row）会先占掉 215px；在默认 280px 侧边栏里，灯从落点到侧边栏裁切边只剩 **53px**，
而圆点 + 间距要花掉 14px。所以：

- 文案压到 2–3 个字（`重启中` / `未运行` / `无响应`），完整句子放 tooltip；
- 组件不留横向内边距（`padding: '2px 0'`）——实测那 16px 正好是从文案里扣的，会让最后一个
  字被侧边栏切掉；
- 文案 span 带 `overflow: hidden` + `textOverflow: ellipsis`，侧边栏更窄时**优雅省略**而不是
  硬切半个字。

绿态刻意不带文字：一切正常时它应该是一个点，而不是一句话。

## 7. 三个被真实事故逼出来的修正

### 7.1 报告必须在 spawn 之前写（否则迟到一整轮）

最初报告是在 `restart()` 结束时写的。结果是：新进程在 `apply` 阶段读报告时，报告还没
落盘——它读到的永远是**上一轮**的报告，而描述它自己的那份要等到下一轮启动才被看到。

真实日志（lab profile）：

```
[dsh-restart] previous restart restart-...-c4a381: [ok] DeepSeek Harness restarted as pid 6680.
        ← 这一轮其实是「坏了 → 回滚 → 重启」，但新进程读到的是上一轮的成功报告
```

修法：`writeProvisional()` 在**每次 spawn 之前**落一份 `in-progress` 报告，把已知的失败原因、
日志尾部、回滚清单都写进去；终态报告覆盖它时**继承 `deliveredAt`**，避免同一次重启被投递两遍。

修完之后的真实日志：

```
[dsh-restart] previous restart restart-...-e256b1: [in-progress] The first boot failed
              (the process exited with code 1). The configuration was rolled back
              (1 restored, 0 removed) and DeepSeek Harness is starting again now.
[dsh-restart]   attempt 1 log: <DSH_HOME>\dsh-restart\logs\...-attempt1.log
[dsh-restart] surfaced 1 previous restart report(s) in the system prompt
```

### 7.2 Agent 不能待在 DSH 的进程树里（否则强杀会杀掉监督者）

Agent 原本由插件直接 `spawn(detached: true)`。Windows 上 `taskkill /PID <dsh> /T /F` 会沿
父子关系杀整棵树，而 Agent 的 `ParentProcessId` 正是 DSH——于是强杀 DSH 时，正在执行回滚的
Agent 被自己那条命令杀掉：

```
[2026-09-10T12:56:53.241Z] pid 36716 is still running after 8000 ms; forcing termination
        ← agent.log 到此为止，回滚没发生，新进程带着坏配置躺在那儿
```

早先的测试之所以没暴露它，是因为那时 Agent 的父进程（更早的那个 DSH）已经死了，Agent 恰好
处于"孤儿"状态。只要让 Agent 在**当前** DSH 的直接子进程位置重新生成一次，问题必然复现。

两处修正：

1. **两段式启动**：插件 spawn 的是一个短命 launcher（`__spawn-detached`），它拉起真正的
   Agent 后立刻退出。Agent 的父进程随即消失，`taskkill /T` 从 DSH 往下走时找不到它。
2. **运行时护栏**：`forceKill()` 检查 `process.ppid === pid`，成立时**去掉 `/T`**。即使有人
   手工把 Agent 塞进目标进程树，回滚也不会自杀。

保留 `/T` 的理由是清理：DSH 名下的 sandbox 进程、构建子进程都挂在它下面，重启时应该一起收走。

### 7.3 一个 Agent、多个实例（否则 web 和 tui 会互相踩）

控制 Agent 是**机器级单例**（一个端口、一份重启历史），但 launch 记录和回滚基线必须是
**实例级**的。两者混在一起时，同时开着 web 和 tui 会出现：tui 的重启请求用 web 的命令行去
启动，或者 web 的失败回滚覆盖 tui 的配置。

修法：`instances/<key>/` 分桶，`key = sha256(profileDir)[0:12]`（Windows 下大小写归一）。
`/restart` 请求带上 `instance`；没带就挑"最近启动且还活着"的那个，再退化到"最近启动的"。
`tracked-files.json`、`launch.json`、`last-good/` 全部按实例隔离。

### 7.4 报告的形状分不出"正在跑"和"已经死了"（boot 对账）

报告是先写后 spawn 的（见 7.1），于是**同一份 `in-progress` + 空 `attempts`** 有两种来源：

- 正常重启：Agent 正在跑这次重启，被它拉起来的那个进程读到的就是这份记录；
- 中断重启：Agent 在 spawn 之前死了，DSH 停在停止状态，这份记录**永远不会**再有下文。

记录本身分不出来，所以 boot 阶段必须去问 Agent，并且要问对问题：

| 观察到 | 结论 |
|---|---|
| 本进程带 `DSH_RESTART_ATTEMPT` | 是 Agent 拉起来的 → 正常重启，**不关** |
| `attempts` 非空 | 至少有一次尝试结算过 → 不是"卡在 spawn 之前"，**不关** |
| Agent 答 `busy: true` | 正在跑的重启 → **不关** |
| Agent 答 `busy: false` 且它的最新报告就是这份 | 中断重启 → 补成 `failed`，日志明说，照常投递给模型 |
| 问不到 Agent | **问不出来 ≠ 没在跑** → 保持原样，只记一行日志 |

关闭是**改写**而不是删除：那个文件是"DSH 曾被留在停止状态"的唯一证据。
它保持未投递状态，于是本轮照常进入 stderr 与系统提示词 —— 否则 `reportText` 会告诉模型
"你就是被重启出来的那个实例"，而对一份中断记录来说这是最错的一句话。

**boot 探测会输给启动时的编译**：这一条是 lab 里量出来的，不是推理 —— 同一个 `restart-lab`
配置连跑 4 次全报 "no control agent answers"，而只要在这个插件前面多插一个插件，6 次全成功。
1.5 秒的存活探测被压在进程最忙的那一刻，abort 先到。

它不只是"超时"：单次尝试输了就把**活着的** Agent 判成"没在跑"。代价在两种配置下都不小 ——
`autoStartAgent: false` 时直接**拒绝一次重启**（lab 里复现两次），默认配置下会**另起一个 Agent
到下一个端口**（真实日志里的 `control agent ready at http://127.0.0.1:3100` 就是它，
那个 3099 上其实有一个活着的）。现在：先用 pid 存活做快路径（省掉对已退出 Agent 的三次无用请求），
再**最多问 3 次、每次 5 秒预算**。7.4 里那段专门为重试写的循环随之简化。
**教训**：对"必须准确"的探测不要只给它一次机会，尤其当它在进程最忙的时刻发出。

### 7.5 优雅重启还需要一个看门狗（因为插件必须先死）

一次工具触发的重启里，**插件是那个必须死掉的进程**：它请求 Agent 重启，然后自己退出，让 Agent
拉起替代者。于是有一个人为空档 —— 请求已经记下、替代者还没起来 —— 而 Agent 恰好死在空档里
是本插件存在的理由。此时没有任何进程会去做那件事，dsh 就停在停止状态。

所以在退出前，插件把 `lib/watchdog.js` 派出去（两段式启动 → 孤儿子进程，针对垂死进程树的
`taskkill /T /F` 抓不到它）。它的判定只有一条原则：**只有确定没人在做这件事时才自己上手**。

| 观察 | 判定 | 为什么 |
|---|---|---|
| 记录里的 pid 是另一个活着的进程 | 收工 | 谁拉起来的都算数：Agent、CLI、还是用户自己 |
| 退出中的 pid 还活着 | 等 | 还没轮到它 |
| Agent 答 `busy: true` | 等 | 正在跑的重启比看门狗更清楚这次重启 |
| Agent 答 `busy: false` | 接手 | 它闲着手头却没有 harness，说明它不会去拉了 |
| Agent 静默 ≥ 10s | 接手 | 问不到 ≠ 没在跑，所以要**沉默够久**才当它死了 |

接手后它做两件事：用 `launch.json` 的原样命令行拉起 dsh，并给子进程打上 `DSH_RESTART_WATCHDOG`
戳（让 boot 对账知道"这次是有人启动的"）；以及把那份停在 `in-progress` 的报告补成终态 ——
否则 7.4 的对账会在**下一个** boot 把它误判成"从没启动过任何进程"。

**它不覆盖什么**：强杀路径（CLI/HTTP 触发的重启由 Agent 直接 `taskkill`，插件已经死了，什么都没
派出去）与 harness 自己崩溃（没人请求过重启）。这两种情况剩下的只有灯和报告 —— 写在这里是为了
让下一个人别以为它堵住了 7.4 的全部场景。

## 8. 回滚基线为什么由插件写、而不是 Agent 写

基线 = "上一次成功启动时的配置"。判断"成功"的人只能是插件：`ctx.appReady` 是 launcher 在
整棵树挂载完成、host 准备就绪之后才提交的信号。Agent 无从知道这件事。

于是分工是：

- 插件在 `appReady` 时把当前配置快照写进 `instances/<key>/last-good/`；
- Agent 在重启失败时把这份快照恢复回去。

这样"坏改动"天然落在快照**之后**：用户先改配置、再要求重启；回滚目标就是改动之前那份成功
过的状态。全程不需要 Agent 理解配置的语义。

快照是**逐文件**的，不是逐目录的：代理一次只动几个文件，复制整棵目录会把 `node_modules`
卷进来。`existed: false` 的条目同样重要——"这个文件当时不存在"也是状态，回滚要把它删掉。

## 9. 失败语义

| 情况 | 行为 |
|---|---|
| 第一次启动成功 | 报告 `ok`，刷新基线 |
| 第一次失败 + 有基线 | 回滚 → 第二次启动；成功则 `rolled-back` |
| 第一次失败 + 无基线 | 报告 `failed`，不盲目重试（同样的配置必然同样失败） |
| 回滚后仍然失败 | 报告 `failed`，headline 明说"DSH 没在运行"，不静默 |
| 报告读取时进程已退出 | 报告留在磁盘（`deliveredAt` 为空），下次手工启动时投递 |

第二次也失败时**不做第三次**：配置已经回到已知good状态还起不来，说明问题不在配置，继续
重启只会掩盖真实错误。此时终端/CLI 是唯一的操作面，报告里带着两次尝试的完整日志尾部。

## 10. 不做什么

- **不管 `node_modules`**：回滚后多装的包留在磁盘上是无害的，回滚配置足以让树起来。
- **不做健康检查的业务语义**：`ready` 只看"启动是否提交"，不看模型能不能跑、端口是不是
  期望的那个。那些是别的插件的事。
- **不持久化 Agent 的 PID 语义**：`agent.json` 只是缓存，任何时刻都以 `/health` 探测为准；
  Agent 可以随时被 `idleExitMs` 收走，下次需要时再拉起来。

## 11. 重启之后：会话自己接着跑，页面自己回来

这一节的需求是一句用户原话：

> 重启后 deepseek-harness 无法自动继续任务，需要人工提醒。希望你可以实现自动化。

两件事以前都要人做，而且都不该由人做：

1. **发一条消息**才有人接着干活；
2. **手动刷新浏览器**才能看到新进程。

### 11.1 为什么重启之后必然停住

Dsh 的会话是**持久化**的（JSONL），代理是**进程内**的 —— 进程没了，那个会话在当前进程里就
**没有代理**。重启又恰好是"一轮对话 + 跑它的进程"同时结束：模型写完收尾回复，树倒下，
新进程对整个在途任务一无所知。于是唯一的续跑途径就是**人再发一条消息**——
而那条消息恰好是"继续"两个字，信息量为零。

报告那条路（第 7.1 节）解决不了它：报告只进入**系统提示词**，而系统提示词只有在下一次有人说话时
才会被读。没有人说话，报告就一直躺在那里。

### 11.2 意图由将死的进程写，由新生的进程兑现

唤醒需要两个只有不同进程才知道的事实：**是哪个会话**要的重启（只有旧进程知道），
和**怎么把一个停掉的会话变回可运行的代理**（只有新进程能做）。

```
旧进程（受理重启时）                     新进程（启动提交后）
  dsh_restart 工具拿到 exec.agent          读 instances/<key>/resume.json
        │  session.id                            │  过期？不是本实例？已认领？→ 不动
        ▼                                         ▼
  写 resume.json                           先写 consumedAt 认领
  {sessionId, reason, requestedAt,         再 ctx.agents.resume({resumeSessionId, agentOptions, setup})
   fromPid, instance, agentPreset}         再 agent.followup(插件来源的用户消息)
```

`ctx.agents.resume` 是 harness 自己的路径（Web 面点开会话时走的就是它），它负责打开会话日志、
修补被中断的回合、发布会话、起循环。`setup` 里重新挂载会话原本的 **agent preset** ——
否则一次唤醒会把会话的工具集和系统提示词悄悄换成 profile 默认值。

四条护栏，每一条都对着一个真实的坏结果：

| 护栏 | 不做会怎样 |
|---|---|
| **先认领再唤醒**（写 `consumedAt`） | 中途崩一次就会在下次启动再唤醒一遍，同一个任务跑两遍 |
| **新鲜度窗口**（`resumeWindowMs`，默认 15 分钟） | 手工启动 DSH 时读到昨天的意图，**没人要求**就开始烧 token |
| **已在线就唤醒它，而不是再起一个** | 浏览器可能比插件先接上会话（它自己也会 `resume`）：那样 `resume` 会撞上写锁，于是"什么都没发生"。**空闲**的在线代理直接 `followup`；正在跑回合的才跳过（有人在开这辆车） |
| **等判决再说话**（`resumeReportWaitMs`，默认 8 秒） | boot 提交时监督者还没判完这一轮（它要等 2.5 秒的 settle），说出口的就是"重启进行中" |
| **失败只记日志** | 它跑在"刚刚证明自己能启动"的进程里，一个便利功能不允许把这次启动弄坏 |

### 11.3 唤醒消息不能被当成用户说的话

唤醒用的是一条 **`source.kind: 'plugin'`** 的用户消息，不是伪造的用户输入 —— 会话记录里能看出
它不是人打的。文本按 harness 自己的插件框架写法组织（参考 `schedule` 的提醒）：

```
[RESTART RESUME]
DeepSeek Harness was restarted by its out-of-process supervisor … Continue from where you left off …
restart_status_json: "ok"
restart_headline_json: "…"
restart_reason_json: "installed a plugin"     ← 模型自己写过的文本，按数据引用
running_pid: 33828
```

`reason` 是模型在重启前写下的**不可信文本**。把它当散文嵌进消息里，就等于让一段旧文本升级成
指令；所以它只以 JSON 字符串出现（和 `schedule` 处理 `reminder_prompt` 是同一个道理）。

消息对象优先由 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 造（身份 + 冻结），但它是**动态
import 且带退路**的：这个插件刻意不依赖 harness 的私有包（见文件头注释），一个模块解析失败不该
让整棵树起不来 —— 退化成手写对象即可。同样的理由，模块名是运行时拼出来的，不是字面量。

### 11.4 页面为什么必须自己刷新

页面**故意**比 harness 活得久（指示灯直连 3099 就是为此），代价是：重启之后，这个标签页里跑的
仍然是**那个已经不存在的进程**发出来的 shell。没有任何服务端手段能通知它 —— 请求会打到新进程上，
而新进程根本不知道有这么个旧页面。

唯一可靠的信号是**宿主身份在持续轮询下发生变化**。于是 `/dsh-restart/status` 增加 `host`
（`pid` + 本次启动的 `launchId`），客户端每 3 秒比一次：

| 观察 | 判定 |
|---|---|
| 第一次拿到身份 | `adopt`（记下来，什么都不做） |
| 和记下来的一样 | `hold` |
| 不一样（换了进程） | **先把新身份记下来**，再 `location.reload()` |
| 15 秒内刚刷过 | `hold`（防止崩溃循环把标签页变成刷新机器） |

"先记下来再刷新"这一条是必须的：不记，刷新后的新页面会拿**旧**身份去比，于是永远在刷。

刷新会丢掉内存里的东西（未发送的**附件**），但**草稿文本不会丢** —— composer 的草稿是持久化的
（`ui-conversation` 的 `contract/views.ts` 写明 "persisted; survives session switches and reloads"）。

### 11.5 通知要出现在用户正在看的地方

刷新之后，页面看到的第一份状态**已经**是当前宿主了，刚刚经历过的那次重启只剩磁盘上的报告。
所以刷新前把要讲的话**存进 sessionStorage**，由新页面画出来：

- 右下角一张卡片：`DSH 已重启完成` / `已回滚配置并重启` / `重启失败`（颜色跟着状态走）、
  `pid`、**用时**、尝试次数、报告 headline、以及"会话已自动继续，无需再发一条消息"；
- 关闭按钮，用户自己决定什么时候让它消失；
- 用 `document.createElement` 手写，不依赖 `react-dom`（客户端 bundle 只允许 `require('react')`，
  见硬规则 1），并且整段包在 `try/catch` 里 —— 丢一张卡片可以接受，把页面弄崩不行。

两条路径都会走到同一张卡片：刚刷新过的页面读 sessionStorage 里的"待播报"，而**一直在那儿的**
标签页（或用户事后才打开的页面）则由轮询发现"有份报告我还没播报过"（`localStorage` 记已读，
10 分钟内的才算新闻）。

## 12. 测试策略

`tests/agent.e2e.mjs` 用一个**假 harness** 复现真实故障模式，不碰任何真实 DSH：

- 假 harness 读 `launch.json` 启动、按协议回报 `ready`、并且**当被跟踪的配置文件内容是
  `BROKEN` 时 fatal 退出**——这正是"坏配置导致启动失败"的最小复刻；
- 覆盖 35 项断言：干净重启、失败回滚、无基线不可恢复、in-progress 报告先于 spawn 落盘、
  鉴权、CLI、两段式启动确实让 Agent 成为孤儿、追加参数确实传到了子进程、
  以及 agent bundle 不含 `@deepseek-ai` 依赖。

`tests/plugin.test.mjs` 把插件挂在一个假 cordis 上下文上，控制 Agent 则是**真的 HTTP 服务**
（随机回环端口），所以插件发出的请求是隔着网络断言的，不是打桩：

- `appendArgs`：有 Web 面时是 `['--no-open']`，没有时一个都不加；
- 退出时机：回合还在跑就不退；回合结束才退；只跑着子代理时不等待；超时封顶后照样退。

`tests/client.test.mjs` 用假的 `window` / `require` / `slots` 盯住客户端半边的契约：
**声明之前不许注册**（第 6.1 节那个 bug 的回归）、声明到达后只注册一次、四种状态的映射、
圆形与省略号这两条样式契约，以及"渲染抛异常只返回 null、绝不带崩界面"。

`tests/lamp.browser.mjs` 是**真实读回**那一层：无头 Chrome + CDP 打开真 GUI，四种灯态逐个
截图并断言颜色 / 文案 / 形状 / 不被侧边栏裁切。四种状态由**浏览器内拦截请求**造出来
（拦 3099 或 `/dsh-restart/status`），因此**不需要停掉真实 Agent**，随时可跑；没有 GUI 或
没有 Chrome 时它自己跳过。单测和字节比对曾经全绿而灯根本没出现 —— 这一层就是为那件事写的。

第 11 节同样只能在这里证明：单测能钉住 `reloadDecision` 的判定，但"**这个标签页真的自己刷新了、
刷新之后真的画出卡片了、而且没有进入刷新循环**"只有真浏览器能回答。做法是把
`/dsh-restart/status` 的**响应体在途中改写**（CDP `Fetch` 域，response 阶段
`fulfillRequest`）成一个 `host.bootId` 不同的文档，先把 sessionStorage 里的身份改成"重启前"，
然后断言：哨兵变量消失（真的导航了）、新身份已记下、卡片出现且文案正确、8 秒后没有第二次刷新、
点 × 能关掉。真实 harness、真实控制 Agent、真实会话全程不动。

<br>

`tests/plugin.test.mjs` 里续跑那一段（第 11.2 节）用的是**假 agents 服务**：断言 resume 拿到的
session id / preset / provider，断言 `followup` 收到的是 `source.kind: 'plugin'` 的消息、
`reason` 只以 JSON 出现，并把六条"不该动"的路径各测一遍（已认领 / 已在线 / 过期 / 别的实例 /
没有会话 / resume 抛错），最后确认 `resumeAfterRestart: false` 是整个关掉的。

真实 launcher 的验证在隔离的 `restart-lab` profile 上做（`@deepseek-ai/dsh-base` + 一个保活
插件 + dsh-restart），完整跑通了：

```
status: rolled-back
headline: The first boot failed (the process exited with code 1); the configuration was
          rolled back (1 restored, 0 removed) and DeepSeek Harness restarted as pid 36032.
restored: [ '<DSH_HOME>\\profiles\\restart-lab\\cordis.patch.yml' ]
attempts: #1 exited | #2 ready (rolled back)
```
