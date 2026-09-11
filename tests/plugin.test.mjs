/**
 * Plugin-side tests for the behaviours a restart must get right.
 *
 * All were reported as bugs by the user, and none is visible from the agent's
 * own tests:
 *
 * 1. `--no-open` — a supervised relaunch of the Web surface must not pop a
 *    second browser tab.
 * 2. The launcher must not exit until the in-flight turn has finished writing
 *    its reply, or the conversation looks truncated after the restart.
 * 3. A restart the agent died in the middle of leaves an `in-progress` report
 *    behind forever; boot has to notice and close it — without ever declaring a
 *    live restart dead.
 *
 * The plugin is mounted against a fake cordis context, and the control agent
 * is a real HTTP server on a loopback port, so the request the plugin builds
 * is asserted over the wire rather than through a stub.
 *
 * Run: node --experimental-strip-types tests/plugin.test.mjs
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const failures = []
let checks = 0

function ok(label, condition, detail = '') {
  checks += 1
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

// ── the fake control agent ────────────────────────────────────────────────
const stateDir = mkdtempSync(join(tmpdir(), 'dsh-restart-plugin-'))
process.env.DSH_RESTART_STATE_DIR = stateDir
mkdirSync(join(stateDir, 'instances'), { recursive: true })
mkdirSync(join(stateDir, 'reports'), { recursive: true })
writeFileSync(join(stateDir, 'token'), 'test-token\n')

/** What the fake agent answers on `/status`; scenarios move these. */
const agentState = { busy: false, lastReport: undefined }

/** Every restart request the plugin sent, in order. */
const received = []
const agentServer = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    const json = (status, value) => {
      const text = JSON.stringify(value)
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      response.end(text)
    }
    if (request.url === '/health') return json(200, { ok: true })
    if (request.url === '/status') {
      return json(200, {
        version: 1,
        busy: agentState.busy,
        ...(agentState.lastReport === undefined ? {} : { lastReport: agentState.lastReport }),
      })
    }
    if (request.url === '/restart') {
      received.push(JSON.parse(body === '' ? '{}' : body))
      return json(202, { accepted: true, id: 'pending', message: 'restart accepted' })
    }
    return json(404, { accepted: false })
  })
})
await new Promise((resolve) => { agentServer.listen(0, '127.0.0.1', resolve) })
const agentPort = agentServer.address().port
// The control agent is always a SEPARATE process (the whole point of the
// two-stage spawn), so the recorded identity must name one: a plugin that finds
// its own pid recorded is looking at a corrupt record, not at a live agent.
const fakeAgentProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })

const agentInfoFile = join(stateDir, 'agent.json')
const writeAgentInfo = (port, pid) => {
  writeFileSync(agentInfoFile, `${JSON.stringify({
    version: 1,
    pid,
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
    startedAt: new Date().toISOString(),
    agentVersion: 'test',
    stateDir,
  }, null, 2)}\n`)
}
writeAgentInfo(agentPort, fakeAgentProcess.pid)

const { apply } = await import('../src/index.ts')

/** A cordis context stub that records listeners and hands out fake services. */
function makeHost({ web = true, agents, presets, defaults, projections, appReady = true } = {}) {
  const listeners = new Map()
  const tools = []
  const exits = []
  const ready = []
  const toolRegistry = { register: (tool) => { tools.push(tool) } }
  const ctx = {
    // The plugin reads the registry through the service property, like every
    // other cordis plugin; `get` is kept for the optional services.
    tools: toolRegistry,
    on(name, listener, options) {
      const list = listeners.get(name) ?? []
      list.push({ listener, options })
      listeners.set(name, list)
      return () => {}
    },
    get(name) {
      if (name === 'tools') return toolRegistry
      if (name === 'webServer' && web) return { port: 3080, host: '127.0.0.1' }
      if (name === 'webStartup' && web) return { openBrowser: true }
      if (name === 'sessionTitle') return { get: () => undefined }
      if (name === 'appExit') return (code) => { exits.push(code) }
      if (name === 'agents') return agents
      if (name === 'agentPresets') return presets
      if (name === 'agentDefaultModel') return defaults
      if (name === 'sessionProjections') return projections
      if (name === 'appReady' && appReady) {
        return { onReady: (listener) => { ready.push(listener); return () => {} } }
      }
      return undefined
    },
    inject(_names, callback) { callback(ctx); return () => {} },
    provide() {},
  }
  return {
    ctx,
    tools,
    exits,
    /** Fire the committed-startup signal, the way the launcher does. */
    fireReady() {
      for (const listener of ready) listener()
    },
    emit(name, ...args) {
      for (const { listener } of listeners.get(name) ?? []) listener(...args)
    },
  }
}

const SILENT = {
  exitDelayMs: 80,
  exitWaitForIdleMs: 5_000,
  captureEnvironment: false,
  // Off for these cases on purpose: each one exercises the exit path, and a
  // real watchdog process per exit would outlive the assertions. The scenario
  // below turns it on explicitly.
  watchdog: false,
  // A wake-up normally waits for the supervisor's verdict (the report is still
  // `in-progress` when boot commits). These cases assert what was sent, not how
  // long it waited, and one of them stages the settled record itself.
  resumeReportWaitMs: 0,
}
const AGENT = { id: 'root-agent', session: { id: 'sess-1', cwd: 'E:/work' }, status: 'running' }

process.stdout.write('\nrelaunch arguments\n')
{
  const host = makeHost({ web: true })
  const original = process.stderr.write
  process.stderr.write = () => true
  apply(host.ctx, { ...SILENT, ...{} })
  const tool = host.tools.find(candidate => candidate.name === 'dsh_restart')
  ok('registers the restart tool', tool !== undefined)
  ok('watches agent status', typeof host.emit === 'function')

  const result = await tool.execute({ reason: 'unit test' })
  process.stderr.write = original
  ok('the restart was accepted', result.accepted === true, JSON.stringify(result))

  const request = received.at(-1)
  ok('a restart request reached the control agent', request !== undefined)
  ok('the web surface is relaunched with --no-open', JSON.stringify(request.appendArgs) === '["--no-open"]', JSON.stringify(request.appendArgs))
  ok('the request names this instance', typeof request.instance === 'string' && request.instance.length > 0)
  ok('the request carries this pid', request.pid === process.pid)
}

process.stdout.write('\na non-web surface appends nothing\n')
{
  const host = makeHost({ web: false })
  const original = process.stderr.write
  process.stderr.write = () => true
  apply(host.ctx, { ...SILENT })
  const tool = host.tools.find(candidate => candidate.name === 'dsh_restart')
  await tool.execute({ reason: 'unit test without a web surface' })
  process.stderr.write = original
  const request = received.at(-1)
  ok('no arguments are appended without a web surface', request.appendArgs === undefined, JSON.stringify(request.appendArgs))
}

process.stdout.write('\nthe launch record is re-asserted before a restart\n')
{
  // A second instance of the same profile boots, loses the port race, dies --
  // and leaves its own (dead) pid in the shared launch record on the way down.
  const instanceKey = readdirSync(join(stateDir, 'instances'))[0]
  const file = join(stateDir, 'instances', instanceKey, 'launch.json')
  const clobbered = JSON.parse(readFileSync(file, 'utf8'))
  clobbered.pid = 999_999
  delete clobbered.webSurface
  writeFileSync(file, JSON.stringify(clobbered, null, 2) + '\n')

  const host = makeHost({ web: true })
  const original = process.stderr.write
  process.stderr.write = () => true
  apply(host.ctx, { ...SILENT })
  const tool = host.tools.find(candidate => candidate.name === 'dsh_restart')
  await tool.execute({ reason: 're-assert the launch record' })
  process.stderr.write = original

  const restored = JSON.parse(readFileSync(file, 'utf8'))
  ok('the record names this process again', restored.pid === process.pid, `pid ${String(restored.pid)}`)
  ok('the surface kind is recorded again', restored.webSurface === true, String(restored.webSurface))
  ok('the restart still carries the web flag', JSON.stringify(received.at(-1).appendArgs) === '["--no-open"]')
}

process.stdout.write('\nthe launcher waits for the turn to finish\n')
{
  const host = makeHost({ web: true })
  const original = process.stderr.write
  process.stderr.write = () => true
  apply(host.ctx, { ...SILENT, exitWaitForIdleMs: 5_000 })
  const tool = host.tools.find(candidate => candidate.name === 'dsh_restart')

  host.emit('agent/status', { agent: AGENT, status: 'running' })
  await tool.execute({ reason: 'unit test waiting for a turn' })
  await sleep(400)
  ok('does not exit while the turn is running', host.exits.length === 0, JSON.stringify(host.exits))

  host.emit('agent/status', { agent: AGENT, status: 'idle' })
  await sleep(700)
  process.stderr.write = original
  ok('exits once the turn has finished', host.exits.length === 1 && host.exits[0] === 0, JSON.stringify(host.exits))
}

process.stdout.write('\na subagent does not hold the process open\n')
{
  const host = makeHost({ web: true })
  const original = process.stderr.write
  process.stderr.write = () => true
  apply(host.ctx, { ...SILENT, exitWaitForIdleMs: 5_000 })
  const tool = host.tools.find(candidate => candidate.name === 'dsh_restart')

  host.emit('agent/status', { agent: { id: 'child', session: { id: 's2' }, parentAgent: AGENT }, status: 'running' })
  await tool.execute({ reason: 'only a subagent is running' })
  await sleep(700)
  process.stderr.write = original
  ok('exits without waiting for a delegated agent', host.exits.length === 1, JSON.stringify(host.exits))
}

process.stdout.write('\nthe wait is bounded\n')
{
  const host = makeHost({ web: true })
  const original = process.stderr.write
  process.stderr.write = () => true
  apply(host.ctx, { ...SILENT, exitWaitForIdleMs: 300 })
  const tool = host.tools.find(candidate => candidate.name === 'dsh_restart')

  host.emit('agent/status', { agent: AGENT, status: 'running' })
  await tool.execute({ reason: 'a turn that never ends' })
  await sleep(1_200)
  process.stderr.write = original
  ok('exits anyway when the budget runs out', host.exits.length === 1, JSON.stringify(host.exits))
}

process.stdout.write('\nan interrupted restart is closed at boot\n')
{
  // The shape the agent leaves when it dies between recording the request and
  // spawning anything: `in-progress`, no attempts, and nobody left to finish it.
  // Left alone it is surfaced forever, and `reportText` tells the model it IS
  // the restarted instance — the one thing it is not.
  let sequence = 0
  const writeReport = (overrides = {}) => {
    sequence += 1
    const id = `restart-2027-01-01_00-00-${String(sequence).padStart(2, '0')}-000-abcdef`
    const report = {
      version: 1,
      id,
      createdAt: '2027-01-01T00:00:00.000Z',
      status: 'in-progress',
      headline: 'Restart in progress: unit test.',
      reason: 'unit test',
      requestedBy: 'tool',
      fromPid: 4242,
      attempts: [],
      ...overrides,
    }
    writeFileSync(join(stateDir, 'reports', `${id}.json`), `${JSON.stringify(report, null, 2)}\n`)
    return { id, file: join(stateDir, 'reports', `${id}.json`) }
  }
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
  const boot = async (config = {}, env = {}, settleMs = 400) => {
    const lines = []
    const original = process.stderr.write
    process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
    const host = makeHost({ web: true })
    const previous = {}
    for (const [key, value] of Object.entries(env)) {
      previous[key] = process.env[key]
      process.env[key] = value
    }
    try {
      apply(host.ctx, { ...SILENT, ...config })
      // The reconciliation asks the agent over HTTP — and retries, because the
      // boot probe races the tree load.
      await sleep(settleMs)
    } finally {
      process.stderr.write = original
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    return lines.join('')
  }

  // 1. The real case: idle agent, nothing was ever spawned.
  agentState.busy = false
  agentState.lastReport = undefined
  const abandoned = writeReport()
  const quiet = await boot()
  const closed = read(abandoned.file)
  ok('the interrupted report reaches a terminal state', closed.status === 'failed', closed.status)
  ok('it says no process was ever started', closed.headline.includes('before it started any process'), closed.headline)
  ok('it explains how it was detected', String(closed.error).includes('reconciled at boot'), String(closed.error))
  ok('the evidence is kept, not deleted', closed.id === abandoned.id && closed.reason === 'unit test')
  ok('the boot log says what it did', quiet.includes(`closed interrupted restart ${abandoned.id}`), quiet.split('\n').slice(0, 3).join(' | '))
  ok('the closed report is then surfaced like any other',
    quiet.includes(`previous restart ${abandoned.id}: [failed]`), 'no surfaced line')
  ok('it stays undelivered so this boot owns it', closed.deliveredAt === undefined, String(closed.deliveredAt))

  // 2. A live restart reads the same shape and must be left ALONE.
  agentState.busy = true
  agentState.lastReport = undefined
  const inFlight = writeReport()
  const whileBusy = await boot()
  ok('a restart the agent is running is left to the agent',
    read(inFlight.file).status === 'in-progress', read(inFlight.file).status)
  ok('and the log says why', whileBusy.includes('is restarting right now'), 'no reason logged')

  // 3. The boot of a live restart also reads this shape — but it was spawned by
  //    the agent, which the environment records.
  agentState.busy = false
  const spawned = writeReport()
  await boot({}, { DSH_RESTART_ATTEMPT: 'restart-2027-01-01_00-00-03-000-abcdef#1' })
  ok('a boot the agent spawned never closes its own report',
    read(spawned.file).status === 'in-progress', read(spawned.file).status)

  // 4. An attempt that settled means the restart was not stuck before spawning.
  const attempted = writeReport({
    attempts: [{
      attempt: 1,
      startedAt: '2027-01-01T00:00:01.000Z',
      finishedAt: '2027-01-01T00:00:02.000Z',
      durationMs: 1_000,
      result: 'exited',
      usedRollback: false,
      logFile: 'attempt1.log',
      logTail: '',
    }],
  })
  await boot()
  ok('a report with an attempt is never rewritten',
    read(attempted.file).status === 'in-progress' && read(attempted.file).attempts.length === 1)

  // 5. The agent cannot be asked (nothing listening): "cannot tell", not "dead".
  //    The retries have to run their course before this boot gives up.
  agentState.busy = false
  const unanswerable = writeReport()
  writeAgentInfo(1, 424_242)
  const offline = await boot({ autoStartAgent: false }, {}, 2_500)
  ok('an unreachable agent means the record is left alone',
    read(unanswerable.file).status === 'in-progress', read(unanswerable.file).status)
  ok('and the log admits it could not tell', offline.includes('could not be asked'), 'no admission logged')
  writeAgentInfo(agentPort, fakeAgentProcess.pid)

  // 6. A terminal report is none of this feature's business.
  const terminal = writeReport({ status: 'ok', headline: 'DeepSeek Harness restarted as pid 1.' })
  await boot()
  ok('a terminal report is untouched',
    read(terminal.file).status === 'ok' && read(terminal.file).headline === 'DeepSeek Harness restarted as pid 1.')
}

process.stdout.write('\nthe watchdog is armed on the way out\n')
{
  // The restart is only as good as the thing that finishes it: if the agent
  // dies between accepting and spawning, this process is the only one that
  // still knows a harness is supposed to be starting.
  const lines = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  const host = makeHost({ web: true })
  apply(host.ctx, { ...SILENT, watchdog: false, exitDelayMs: 40 })
  const tool = host.tools.find(candidate => candidate.name === 'dsh_restart')
  await tool.execute({ reason: 'unit test without a watchdog' })
  host.emit('agent/status', { agent: AGENT, status: 'idle' })
  await sleep(600)
  process.stderr.write = original
  ok('the exit still happens', host.exits.length === 1, JSON.stringify(host.exits))
  ok('watchdog: false leaves the exit path alone', !lines.join('').includes('armed the watchdog'))

  // Arming is asserted against the BUILT plugin, because the entry is resolved
  // next to whichever module is running: from source that is `src/watchdog.js`
  // (which does not exist — and is reported rather than guessed at), from the
  // shipped layout it is `lib/watchdog.js`, the artifact that actually runs.
  const builtEntry = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  if (!existsSync(builtEntry) || !existsSync(fileURLToPath(new URL('../lib/watchdog.js', import.meta.url)))) {
    process.stdout.write('  skip  the plugin is not built here (tsc -b && tsdown), so arming was not exercised\n')
  } else {
    const { apply: applyBuilt } = await import(pathToFileURL(builtEntry).href)
    const armedLines = []
    const restore = process.stderr.write
    process.stderr.write = (chunk) => { armedLines.push(String(chunk)); return true }
    const builtHost = makeHost({ web: true })
    applyBuilt(builtHost.ctx, { ...SILENT, watchdog: true, watchdogWaitMs: 1_000, exitDelayMs: 40 })
    const builtTool = builtHost.tools.find(candidate => candidate.name === 'dsh_restart')
    await builtTool.execute({ reason: 'unit test arming the watchdog' })
    builtHost.emit('agent/status', { agent: AGENT, status: 'idle' })
    await sleep(700)
    process.stderr.write = restore
    const log = armedLines.join('')
    ok('the built plugin exits on schedule', builtHost.exits.length === 1, JSON.stringify(builtHost.exits))
    ok('and arms the watchdog before it goes',
      log.includes('armed the watchdog'), log.split('\n').filter(line => line.includes('watchdog')).join(' | '))
  }
}

// ── the resume path ───────────────────────────────────────────────────────
//
// The complaint that produced this feature, verbatim: "after a restart
// deepseek-harness cannot continue the task on its own, a human has to prompt
// it". A restart ends the turn *and* the process running it, so the new tree
// has no agent for that conversation at all — sessions are durable, agents are
// not. Everything below pins the two halves: the dying process records which
// session asked, and the boot that replaces it resumes that session and queues
// one plugin-sourced message so the work simply continues.

/** The instance directory the stub context resolves to (no profile => `default`). */
const instanceDir = () => join(stateDir, 'instances', readdirSync(join(stateDir, 'instances'))[0])
const intentFile = () => join(instanceDir(), 'resume.json')
const writeIntent = (overrides = {}) => {
  const intent = {
    version: 1,
    sessionId: 'sess-wake',
    reason: 'installed a plugin',
    requestedAt: new Date().toISOString(),
    fromPid: 4242,
    instance: readdirSync(join(stateDir, 'instances'))[0],
    ...overrides,
  }
  writeFileSync(intentFile(), `${JSON.stringify(intent, null, 2)}\n`)
  return intent
}

/** Mount the plugin, fire the committed-startup signal, and collect the log. */
async function bootHost(options = {}, config = {}, settleMs = 60) {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  const host = makeHost(options)
  try {
    apply(host.ctx, { ...SILENT, ...config })
    host.fireReady()
    await sleep(settleMs)
  } finally {
    process.stderr.write = original
  }
  return { host, log: lines.join('') }
}

process.stdout.write('\nthe requesting session is recorded when a restart is accepted\n')
{
  rmSync(intentFile(), { force: true })
  const lines = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  const host = makeHost({ web: true, projections: { stateOf: () => 'preset-7' } })
  apply(host.ctx, { ...SILENT })
  const tool = host.tools.find(candidate => candidate.name === 'dsh_restart')
  await tool.execute(
    { reason: 'installed a plugin' },
    { agent: { id: 'root', session: { id: 'sess-resume' } } },
  )
  process.stderr.write = original

  const intent = JSON.parse(readFileSync(intentFile(), 'utf8'))
  ok('the requesting session is written down', intent.sessionId === 'sess-resume', intent.sessionId)
  ok('the reason travels with it', intent.reason === 'installed a plugin', intent.reason)
  ok('the session preset travels with it', intent.agentPreset === 'preset-7', String(intent.agentPreset))
  ok('the request names this process', intent.fromPid === process.pid, String(intent.fromPid))
  ok('it names the owning instance', intent.instance === readdirSync(join(stateDir, 'instances'))[0])
  ok('nothing has claimed it yet', intent.consumedAt === undefined)
  ok('the log says what will happen next', lines.join('').includes('the next boot wakes it'))
}

process.stdout.write('\na restart requested outside a session records nothing\n')
{
  rmSync(intentFile(), { force: true })
  const lines = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  const host = makeHost({ web: true })
  apply(host.ctx, { ...SILENT })
  const tool = host.tools.find(candidate => candidate.name === 'dsh_restart')
  // A PTC dispatch or a composite tool can run this without an agent behind it.
  await tool.execute({ reason: 'no session behind this call' }, {})
  process.stderr.write = original
  ok('no intent file is written', !existsSync(intentFile()))
  ok('and the log says why', lines.join('').includes('outside a session'))
}

process.stdout.write('\nthe next boot wakes that session without a prompt\n')
{
  rmSync(intentFile(), { force: true })
  writeIntent({ agentPreset: 'preset-7' })
  // A real wake-up speaks after the supervisor has judged the restart, so it
  // can quote the verdict rather than the provisional record. Filenames sort
  // chronologically, so this one is the newest report for the rest of the run.
  const settledId = 'restart-2028-01-01_00-00-00-000-ffffff'
  writeFileSync(join(stateDir, 'reports', `${settledId}.json`), `${JSON.stringify({
    version: 1,
    id: settledId,
    createdAt: new Date().toISOString(),
    status: 'ok',
    headline: 'DeepSeek Harness restarted as pid 4242.',
    reason: 'installed a plugin',
    requestedBy: 'tool',
    fromPid: 4242,
    attempts: [{
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 37_485,
      result: 'ready',
      usedRollback: false,
      logFile: 'attempt-1.log',
      logTail: '',
    }],
  }, null, 2)}\n`)
  const calls = { resume: [], followup: [], mounted: [] }
  const agents = {
    get: () => undefined,
    resume: async (options) => {
      calls.resume.push(options)
      if (typeof options.setup === 'function') await options.setup({}, {})
      return { agent: { followup: (message) => { calls.followup.push(message) } } }
    },
  }
  const { log } = await bootHost({
    web: true,
    agents,
    presets: {
      resolve: async (id) => ({ id: id ?? 'default' }),
      mount: async (_agentCtx, id) => { calls.mounted.push(id) },
    },
    defaults: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
  })

  ok('the recorded session is resumed', calls.resume.length === 1
    && calls.resume[0].resumeSessionId === 'sess-wake', JSON.stringify(calls.resume[0]?.resumeSessionId))
  ok('the session preset is mounted again', calls.mounted[0] === 'preset-7', String(calls.mounted[0]))
  ok('the resume carries the default provider and model',
    JSON.stringify(calls.resume[0]?.agentOptions) === '{"provider":"deepseek","model":"deepseek-chat"}',
    JSON.stringify(calls.resume[0]?.agentOptions))
  ok('exactly one message is queued', calls.followup.length === 1, String(calls.followup.length))

  const message = calls.followup[0] ?? {}
  ok('the message is plugin-sourced, never the user',
    message.source?.kind === 'plugin' && message.source?.plugin === 'dsh-restart', JSON.stringify(message.source))
  ok('the message carries an identity', typeof message.id === 'string' && message.id.length > 0)
  ok('the message is a user-role message', message.role === 'user', String(message.role))
  const text = message.content?.[0]?.text ?? ''
  ok('it quotes the recorded reason as data', text.includes('"installed a plugin"'), text.slice(0, 160))
  ok('it carries the supervisor\'s verdict', text.includes('restart_status_json: "ok"'), text.slice(0, 200))
  ok('it carries the settled headline', text.includes('DeepSeek Harness restarted as pid 4242.'))
  ok('it carries the attempt count', text.includes('restart_attempts: 1'), text.slice(0, 260))
  ok('it asks the agent to continue from where it stopped', text.includes('Continue from where you left off'))
  ok('it warns against restarting again for no reason', text.includes('Do not request another restart'))
  ok('the log says the session was woken', log.includes('the interrupted task continues without a prompt'))

  const claimed = JSON.parse(readFileSync(intentFile(), 'utf8'))
  ok('the intent is claimed', typeof claimed.consumedAt === 'string' && claimed.consumedAt.length > 0)
  ok('and the claim records the outcome', claimed.outcome === 'resumed', String(claimed.outcome))
}

process.stdout.write('\na claimed intent is never resumed twice\n')
{
  const calls = []
  const { log } = await bootHost({
    web: true,
    agents: {
      get: () => undefined,
      resume: async () => { calls.push('resume'); return { agent: { followup: () => {} } } },
    },
  })
  ok('a claimed intent wakes nothing', calls.length === 0, JSON.stringify(calls))
  ok('and boots quietly', !log.includes('resumed session'))
}

process.stdout.write('\na session the browser already re-attached is woken, not duplicated\n')
{
  rmSync(intentFile(), { force: true })
  writeIntent()
  // The GUI resumes its session on its own schedule, and the API it talks to
  // creates the agent when it finds none. Whoever wins that race, the session
  // must end up with exactly one agent — so an existing one is the thing to
  // wake, not a reason to give up.
  const calls = []
  const messages = []
  const { log } = await bootHost({
    web: true,
    agents: {
      get: (id) => ({ id, status: 'idle', followup: (message) => { calls.push('followup'); messages.push(message) } }),
      resume: async () => { calls.push('resume'); return { agent: { status: 'idle', followup: () => {} } } },
    },
  })
  ok('no second agent is created for a live session', calls.join(',') === 'followup', calls.join(','))
  ok('the live agent is woken instead', messages.length === 1 && messages[0]?.source?.plugin === 'dsh-restart')
  ok('the log says which path was taken', log.includes('already live'), log.split('\n').filter(l => l.includes('resumed')).join(' | '))
  ok('and the claim records the outcome',
    JSON.parse(readFileSync(intentFile(), 'utf8')).outcome === 'resumed')
}

process.stdout.write('\na session that is already working is left alone\n')
{
  rmSync(intentFile(), { force: true })
  writeIntent()
  const calls = []
  const { log } = await bootHost({
    web: true,
    agents: {
      get: (id) => ({ id, status: 'running', followup: () => { calls.push('followup') } }),
      resume: async () => { calls.push('resume'); return { agent: { status: 'idle', followup: () => {} } } },
    },
  })
  ok('a running turn is never interrupted', calls.length === 0, JSON.stringify(calls))
  ok('the log explains the skip', log.includes('already running'), log)
  ok('the skip is recorded as the claim outcome',
    JSON.parse(readFileSync(intentFile(), 'utf8')).outcome === 'skipped: the session is already running a turn')
}

process.stdout.write('\na stale intent does not start a turn\n')
{
  rmSync(intentFile(), { force: true })
  // The shape a boot finds hours later: a record left by a restart that did NOT
  // produce this process. Waking a conversation nobody asked to resume is worse
  // than missing one wake-up, so age is the gate.
  writeIntent({ requestedAt: new Date(Date.now() - 3_600_000).toISOString() })
  const calls = []
  const { log } = await bootHost({
    web: true,
    agents: {
      get: () => undefined,
      resume: async () => { calls.push('resume'); return { agent: { followup: () => {} } } },
    },
  })
  ok('an hour-old intent wakes nothing', calls.length === 0, JSON.stringify(calls))
  ok('the log calls it stale', log.includes('is stale'), log.split('\n').filter(l => l.includes('stale')).join(' | '))
  ok('and it is left unclaimed for a human to read',
    JSON.parse(readFileSync(intentFile(), 'utf8')).consumedAt === undefined)
}

process.stdout.write('\nanother instance\'s intent is not this boot\'s business\n')
{
  rmSync(intentFile(), { force: true })
  writeIntent({ instance: 'someone-else' })
  const calls = []
  const { log } = await bootHost({
    web: true,
    agents: {
      get: () => undefined,
      resume: async () => { calls.push('resume'); return { agent: { followup: () => {} } } },
    },
  })
  ok('a foreign intent wakes nothing', calls.length === 0, JSON.stringify(calls))
  ok('and the log says whose it is', log.includes('belongs to instance someone-else'))
}

process.stdout.write('\na failing resume cannot break the boot\n')
{
  rmSync(intentFile(), { force: true })
  writeIntent()
  const { log } = await bootHost({
    web: true,
    agents: {
      get: () => undefined,
      resume: async () => { throw new Error('session log is locked by another process') },
    },
  })
  ok('the failure is reported, not thrown', log.includes('could not resume session sess-wake'))
  ok('the reason is carried into the log', log.includes('session log is locked'))
  const claimed = JSON.parse(readFileSync(intentFile(), 'utf8'))
  ok('the attempt is still claimed, so it cannot retry forever',
    claimed.outcome?.startsWith('failed: ') === true, String(claimed.outcome))
}

process.stdout.write('\nresumeAfterRestart: false turns the whole path off\n')
{
  rmSync(intentFile(), { force: true })
  const lines = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  const requester = makeHost({ web: true })
  apply(requester.ctx, { ...SILENT, resumeAfterRestart: false })
  const tool = requester.tools.find(candidate => candidate.name === 'dsh_restart')
  await tool.execute({ reason: 'quiet restart' }, { agent: { session: { id: 'sess-quiet' } } })
  process.stderr.write = original
  ok('nothing is recorded at request time', !existsSync(intentFile()))

  // Even a record written by an older, chattier configuration stays untouched.
  writeIntent({ sessionId: 'sess-quiet' })
  const calls = []
  await bootHost({
    web: true,
    agents: {
      get: () => undefined,
      resume: async () => { calls.push('resume'); return { agent: { followup: () => {} } } },
    },
  }, { resumeAfterRestart: false })
  ok('and nothing is resumed at boot', calls.length === 0, JSON.stringify(calls))
  rmSync(intentFile(), { force: true })
}

process.stdout.write('\nthe wake-up waits for the supervisor\'s verdict\n')
{
  rmSync(intentFile(), { force: true })
  writeIntent()
  // What is on disk the moment boot commits: a provisional record. It carries
  // one attempt, which also keeps boot reconciliation from claiming it as an
  // interrupted restart.
  const id = 'restart-2029-01-01_00-00-00-000-ffffff'
  const file = join(stateDir, 'reports', `${id}.json`)
  const provisional = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    status: 'in-progress',
    headline: 'Restart in progress: unit test.',
    reason: 'unit test',
    requestedBy: 'tool',
    fromPid: 1,
    attempts: [{
      attempt: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1_000,
      result: 'exited',
      usedRollback: true,
      logFile: 'attempt-1.log',
      logTail: '',
    }],
  }
  writeFileSync(file, `${JSON.stringify(provisional, null, 2)}\n`)
  // The supervisor settles a moment later, exactly as the real one does.
  setTimeout(() => {
    writeFileSync(file, `${JSON.stringify({
      ...provisional,
      status: 'rolled-back',
      headline: 'The first boot failed; the configuration was rolled back.',
      rollback: { performed: true, restored: ['x'], removed: [], failures: [] },
    }, null, 2)}\n`)
  }, 120)

  const messages = []
  await bootHost({
    web: true,
    agents: { get: () => undefined, resume: async () => ({ agent: { followup: (m) => messages.push(m) } }) },
  }, { resumeReportWaitMs: 2_000 }, 500)

  const text = messages[0]?.content?.[0]?.text ?? ''
  ok('the framing carries the settled status, not the provisional one',
    text.includes('restart_status_json: "rolled-back"'), text.slice(0, 220))
  ok('it carries the settled headline', text.includes('the configuration was rolled back'))
  ok('it flags the rollback', text.includes('restart_rolled_back_configuration: true'), text.slice(0, 320))
}

agentServer.close()
fakeAgentProcess.kill()

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
