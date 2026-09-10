# dsh-restart 未来计划

写给下一个接手这个插件的 Agent。**先读仓库根的 `DESIGN.md`（为什么是这样）与工作区的
`../AGENTS.md`（硬规则与验证手册）**，再动代码。

每条都给了「为什么」与「验收标准」。P0 是收尾，P1 是真正值得做的健壮性，P2/P3 是功能与工程。

---

## P0 — 收尾：两件已实现但未亲眼验证的事

### 0.1 侧边栏指示灯的视觉确认

**现状**：客户端半边已经发布、服务端吐出的 bundle 与源码逐字节一致、插槽是侧边栏真实渲染的位置
（`SidebarRoot.tsx:270` 的 `renderSlot('sidebar.footer.action', …)`），单测覆盖了注册、
四种状态映射与渲染兜底。**但没有用肉眼看它渲染出来。**

**为什么值得做**：指示灯的全部价值就是"一眼可见"；一个注册成功但视觉上不可见的组件等于没有。

**验收**：
- 打开 Web GUI，侧边栏底部（Settings 旁边）能看到绿灯（无文字）；
- `node <PLUGINS>/dsh-restart/lib/agent.js stop` 后数秒内变红并显示「守护未运行」；
- 再重启一次 dsh（或让插件重新拉起 Agent）后恢复绿灯。

**手段**：`agent-browser`（已全局安装，Chrome 也在）：
`agent-browser open "http://127.0.0.1:3080/?token=<token>"` → `snapshot`/`screenshot`。
token 在最近一次 attempt 日志里（`dsh web: http://127.0.0.1:3080/?token=…`）。
**注意**：侧边栏折叠时这个插槽可能不渲染（`renderSlot(..., { wide })`），截图前确认侧边栏是展开的。

### 0.2 「退出前等回合结束」的真实链路验证

**现状**：有 3 条单测（运行中不退 / 结束才退 / 子代理不阻塞 / 超时封顶），
但**一次真实的工具触发重启都还没走到它**——之前那几次重启分别是手动、CLI、和一次误触发。

**验收**：调用 `dsh_restart` 之后：
- 模型的收尾回复**出现在会话里**（不是被砍断）；
- `agent.log` 里第一次 spawn 的时刻 = 回合结束时刻（而不是工具返回后固定 1.2 秒）；
- 新进程起来后报告 `ok`。

---

## P1 — 健壮性：把"Agent 中途死亡"这条路的损失降到最低

### 1.1 中断重启的自动对账（推荐先做）

**问题**：`agent.log` 停在 `forcing termination`、报告永停 `in-progress`、`attempts` 为空 ——
这就是"Agent 在启动新进程之前死了，dsh 被留在停止状态"。目前只能靠人去看文件才发现。

**做法**：插件在 `apply` 阶段检查最新一份报告：
若 `status === 'in-progress'` **且 `attempts.length === 0`** **且 Agent 不忙**，
判定上次重启被中断，把它补成终态（`failed`，headline 写"上次重启在启动新进程前中断，
dsh 曾被留在停止状态"），并在启动日志里明说。

**坑**：正常重启时 boot 阶段读到 `in-progress` 是**预期的**（报告先于 spawn 写），
所以判定必须带 `attempts.length === 0` 这个条件，且要在 Agent 可用时先问一句 `/status` 的 `busy`。
不要只按时间判断。

**验收**：从上一次中断留下的状态启动，报告被补成终态且日志有明确提示；
正常重启路径不受影响（`in-progress` 仍被正常投递）。

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

改任何东西之后：`tsc --noEmit` → 三个测试文件全绿（43 + 15 + 31）→ 需要时上隔离 lab profile →
最后才动真实环境。**不要为了验证而杀死自己的会话**：要么把说明写在触发之前，
要么用异步 202 + 足够的 `stopGraceMs` 留出窗口。
