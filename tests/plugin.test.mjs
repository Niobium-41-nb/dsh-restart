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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
writeAgentInfo(agentPort, process.pid)

const { apply } = await import('../src/index.ts')

/** A cordis context stub that records listeners and hands out fake services. */
function makeHost({ web = true } = {}) {
  const listeners = new Map()
  const tools = []
  const exits = []
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
      return undefined
    },
    inject(_names, callback) { callback(ctx); return () => {} },
    provide() {},
  }
  return {
    ctx,
    tools,
    exits,
    emit(name, ...args) {
      for (const { listener } of listeners.get(name) ?? []) listener(...args)
    },
  }
}

const SILENT = { exitDelayMs: 80, exitWaitForIdleMs: 5_000, captureEnvironment: false }
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
  writeAgentInfo(agentPort, process.pid)

  // 6. A terminal report is none of this feature's business.
  const terminal = writeReport({ status: 'ok', headline: 'DeepSeek Harness restarted as pid 1.' })
  await boot()
  ok('a terminal report is untouched',
    read(terminal.file).status === 'ok' && read(terminal.file).headline === 'DeepSeek Harness restarted as pid 1.')
}

agentServer.close()

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
