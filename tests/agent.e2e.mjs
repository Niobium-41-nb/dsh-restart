/**
 * End-to-end exercise of the restart agent without touching a real harness.
 *
 * A stand-in process reads the launch specification the plugin would have
 * written, reports a committed startup back over the control API, and fails
 * its boot exactly when the tracked configuration file says "BROKEN" — which
 * is the real failure mode the rollback exists for.
 *
 * Run: node tests/agent.e2e.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const agentEntry = join(packageRoot, 'lib', 'agent.js')
const stateDir = join(packageRoot, '.test-state')
const port = 3299

const failures = []
const checks = []

function check(name, condition, detail = '') {
  checks.push(name)
  if (condition) {
    process.stdout.write(`  ok   ${name}\n`)
    return
  }
  failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms) })

async function waitFor(label, probe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function token() {
  return readFileSync(join(stateDir, 'token'), 'utf8').trim()
}

async function api(path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}`, ...init.headers },
  })
  return { status: response.status, body: await response.json() }
}

async function restart(body) {
  return api('/restart', { method: 'POST', body: JSON.stringify({ ...body, wait: true }) })
}

/** Stop an agent a previous run left listening on this port. */
async function shutdownLeftoverAgent() {
  let info
  try {
    info = JSON.parse(readFileSync(join(stateDir, 'agent.json'), 'utf8'))
  } catch {
    return
  }
  let token
  try {
    token = readFileSync(join(stateDir, 'token'), 'utf8').trim()
  } catch {
    return
  }
  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    })
  } catch {
    return
  }
  await sleep(600)
}

// ── fixtures ──────────────────────────────────────────────────────────────
// A previous run can leave its agent supervising the port; ask it to stop so
// the state directory is not locked underneath us.
await shutdownLeftoverAgent()
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    rmSync(stateDir, { recursive: true, force: true })
    break
  } catch (error) {
    if (attempt === 19) throw error
    await sleep(250)
  }
}
mkdirSync(stateDir, { recursive: true })

const instanceDir = join(stateDir, 'instances', 'e2e')
const configPath = join(instanceDir, 'config.txt')
const harnessPath = join(stateDir, 'fake-harness.mjs')
mkdirSync(instanceDir, { recursive: true })
writeFileSync(configPath, 'GOOD\n')

writeFileSync(harnessPath, `
import { readFileSync } from 'node:fs'
const config = '${configPath.replaceAll('\\', '\\\\')}'
const content = readFileSync(config, 'utf8').trim()
const attempt = process.env.DSH_RESTART_ATTEMPT ?? 'none'
process.stdout.write('[fake-harness] boot pid=' + process.pid + ' attempt=' + attempt + ' config=' + content + ' args=' + process.argv.slice(2).join(',') + '\\n')
if (content === 'BROKEN') {
  process.stderr.write('[fake-harness] simulated fatal load failure\\n')
  process.exit(1)
}
if (attempt !== 'none') {
  const ready = () => fetch(process.env.DSH_RESTART_AGENT + '/ready', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.DSH_RESTART_TOKEN },
    body: JSON.stringify({ attempt }),
  }).then((r) => { process.stdout.write('[fake-harness] reported ready -> ' + r.status + '\\n') })
    .catch((error) => { process.stdout.write('[fake-harness] ready failed: ' + error.message + '\\n') })
  setTimeout(ready, 900)
}
setInterval(() => {}, 1000)
`)

function launchSpec(extraEnv = {}, extra = {}) {
  return {
    version: 1,
    pid: 0,
    launchId: 'test',
    startedAt: new Date().toISOString(),
    cwd: stateDir,
    execPath: process.execPath,
    execArgv: [],
    argv: [harnessPath],
    env: { FAKE: '1', ...extraEnv },
    ...extra,
  }
}

writeJson(join(instanceDir, 'launch.json'), launchSpec())
writeJson(join(instanceDir, 'tracked-files.json'), { version: 1, updatedAt: new Date().toISOString(), files: [configPath] })

// ── start the agent ───────────────────────────────────────────────────────
process.stdout.write('starting the control agent\n')
// Launched exactly the way the plugin launches it: through the short-lived
// two-stage launcher, so the agent ends up outside this process's tree.
const launcher = spawn(
  process.execPath,
  [agentEntry, '__spawn-detached', 'serve', '--port', String(port), '--idle-ms', '3600000'],
  { env: { ...process.env, DSH_RESTART_STATE_DIR: stateDir }, stdio: ['ignore', 'pipe', 'pipe'] },
)
let agentLog = ''
launcher.stdout.on('data', (chunk) => { agentLog += chunk })
launcher.stderr.on('data', (chunk) => { agentLog += chunk })

let exitCode = 0
try {
  await waitFor('the control agent', async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      return response.ok
    } catch {
      return false
    }
  })

  // ── test 1: clean restart ───────────────────────────────────────────────
  process.stdout.write('\ntest 1 — clean restart\n')
  const first = await restart({ reason: 'e2e clean restart', requestedBy: 'e2e', instance: 'e2e', readyTimeoutMs: 15_000, stopGraceMs: 3_000 })
  check('http 200', first.status === 200, `status ${first.status}`)
  check('report status is ok', first.body.status === 'ok', JSON.stringify(first.body.headline))
  check('one attempt', first.body.attempts?.length === 1, `attempts ${first.body.attempts?.length}`)
  check('attempt reported ready', first.body.attempts?.[0]?.result === 'ready', first.body.attempts?.[0]?.result)
  check('no rollback', first.body.rollback === undefined)
  check('the stand-in is still running', first.body.attempts?.[0]?.pid !== undefined)

  // ── test 2: bad configuration → rollback → second boot ──────────────────
  process.stdout.write('\ntest 2 — failing boot rolls back to last known-good\n')
  const goodBytes = readFileSync(configPath)
  writeJson(join(instanceDir, 'last-good', 'manifest.json'), {
    version: 1,
    createdAt: new Date().toISOString(),
    source: 'e2e baseline',
    entries: [{
      path: configPath,
      existed: true,
      sha256: createHash('sha256').update(goodBytes).digest('hex'),
      size: goodBytes.length,
      stored: '000__config.txt',
    }],
  })
  mkdirSync(join(instanceDir, 'last-good', 'files'), { recursive: true })
  writeFileSync(join(instanceDir, 'last-good', 'files', '000__config.txt'), goodBytes)
  // The bad edit under test: this is what the user's last change would look like.
  writeFileSync(configPath, 'BROKEN\n')

  const second = await restart({ reason: 'e2e rollback', requestedBy: 'e2e', instance: 'e2e', readyTimeoutMs: 15_000, stopGraceMs: 3_000 })
  check('http 200', second.status === 200, `status ${second.status}`)
  check('report status is rolled-back', second.body.status === 'rolled-back', JSON.stringify(second.body.headline))
  check('two attempts', second.body.attempts?.length === 2, `attempts ${second.body.attempts?.length}`)
  check('first attempt exited', second.body.attempts?.[0]?.result === 'exited', second.body.attempts?.[0]?.result)
  check('second attempt used the rollback', second.body.attempts?.[1]?.usedRollback === true)
  check('second attempt is ready', second.body.attempts?.[1]?.result === 'ready', second.body.attempts?.[1]?.result)
  check('config was restored', readFileSync(configPath, 'utf8').trim() === 'GOOD')
  check('rollback names the file', second.body.rollback?.restored?.includes(configPath) === true)
  check('rollback recorded as performed', second.body.rollback?.performed === true)
  check('failure log tail was captured', (second.body.attempts?.[0]?.logTail ?? '').includes('simulated fatal load failure'))

  // ── test 2b: the failure is on disk before the retry boots ──────────────
  process.stdout.write('\ntest 2b — the report exists before the restarted process boots\n')
  const readReports = () => readdirSync(join(stateDir, 'reports'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(stateDir, 'reports', name), 'utf8')))

  const restoredBytes = readFileSync(configPath)
  writeJson(join(instanceDir, 'last-good', 'manifest.json'), {
    version: 1,
    createdAt: new Date().toISOString(),
    source: 'e2e baseline for the provisional-report test',
    entries: [{
      path: configPath,
      existed: true,
      sha256: createHash('sha256').update(restoredBytes).digest('hex'),
      size: restoredBytes.length,
      stored: '000__config.txt',
    }],
  })
  writeFileSync(join(instanceDir, 'last-good', 'files', '000__config.txt'), restoredBytes)
  writeFileSync(configPath, 'BROKEN\n')

  const fired = await api('/restart', {
    method: 'POST',
    body: JSON.stringify({
      reason: 'e2e provisional report',
      requestedBy: 'e2e',
      instance: 'e2e',
      readyTimeoutMs: 15_000,
      stopGraceMs: 3_000,
    }),
  })
  check('accepted without waiting', fired.status === 202, `status ${fired.status}`)
  const provisional = await waitFor('an in-progress report with the rollback', async () => {
    return readReports().find((report) => report.reason === 'e2e provisional report'
      && report.rollback?.performed === true)
  })
  check('provisional status is in-progress', provisional.status === 'in-progress', provisional.status)
  check('provisional records the failed attempt', provisional.attempts?.[0]?.result === 'exited',
    provisional.attempts?.[0]?.result)
  check('provisional carries the failure log tail',
    (provisional.attempts?.[0]?.logTail ?? '').includes('simulated fatal load failure'))
  check('provisional names the restored file', provisional.rollback?.restored?.includes(configPath) === true)
  await waitFor('the provisional restart to settle', async () => {
    const state = await api('/status')
    return state.body.busy === false
  })

  // ── test 2c: appended relaunch arguments reach the child ────────────────
  process.stdout.write('\ntest 2c — a relaunch can append arguments\n')
  writeFileSync(configPath, 'GOOD\n')
  const appended = await restart({
    reason: 'e2e appended args',
    requestedBy: 'e2e',
    instance: 'e2e',
    readyTimeoutMs: 15_000,
    stopGraceMs: 3_000,
    appendArgs: ['--no-open'],
  })
  check('http 200', appended.status === 200, `status ${appended.status}`)
  check(
    'the appended argument reached the child',
    (appended.body.attempts?.[0]?.logTail ?? '').includes('args=--no-open'),
    appended.body.attempts?.[0]?.logTail,
  )

  // ── test 2d: a recorded Web surface implies --no-open on its own ────────
  process.stdout.write('\ntest 2d — the recorded surface kind supplies the flag\n')
  writeJson(join(instanceDir, 'launch.json'), launchSpec({}, { webSurface: true }))
  const implicit = await restart({ reason: 'e2e web surface', requestedBy: 'e2e', instance: 'e2e', readyTimeoutMs: 15_000, stopGraceMs: 3_000 })
  check(
    'a Web surface is relaunched with --no-open by default',
    (implicit.body.attempts?.[0]?.logTail ?? '').includes('args=--no-open'),
    implicit.body.attempts?.[0]?.logTail,
  )

  writeJson(join(instanceDir, 'launch.json'), launchSpec({}, { webSurface: false }))
  const headless = await restart({ reason: 'e2e headless surface', requestedBy: 'e2e', instance: 'e2e', readyTimeoutMs: 15_000, stopGraceMs: 3_000 })
  check(
    'a non-Web surface gets no extra flag',
    (headless.body.attempts?.[0]?.logTail ?? '').includes('args=\n') || (headless.body.attempts?.[0]?.logTail ?? '').includes('args=\r\n'),
    headless.body.attempts?.[0]?.logTail,
  )

  // ── test 3: unrecoverable ───────────────────────────────────────────────
  process.stdout.write('\ntest 3 — a rollback that cannot boot reports failure\n')
  writeFileSync(configPath, 'BROKEN\n')
  const brokenBaseline = readFileSync(configPath)
  writeJson(join(instanceDir, 'last-good', 'manifest.json'), {
    version: 1,
    createdAt: new Date().toISOString(),
    source: 'e2e deliberately broken baseline',
    entries: [{
      path: configPath,
      existed: true,
      sha256: createHash('sha256').update(brokenBaseline).digest('hex'),
      size: brokenBaseline.length,
      stored: '000__config.txt',
    }],
  })
  writeFileSync(join(instanceDir, 'last-good', 'files', '000__config.txt'), brokenBaseline)

  const third = await restart({ reason: 'e2e unrecoverable', requestedBy: 'e2e', instance: 'e2e', readyTimeoutMs: 15_000, stopGraceMs: 3_000 })
  check('report status is failed', third.body.status === 'failed', JSON.stringify(third.body.headline))
  check('headline names the downtime', (third.body.headline ?? '').includes('NOT running'))

  // ── test 4: the agent's own routes ──────────────────────────────────────
  process.stdout.write('\ntest 4 — status and reports\n')
  const status = await api('/status')
  check('status lists the last report', status.body.lastReport?.status === 'failed')
  check('status lists tracked files', status.body.trackedFiles?.includes(configPath) === true)
  check('status reports the healthy baseline date', typeof status.body.lastGood?.createdAt === 'string')

  const unauthorised = await fetch(`http://127.0.0.1:${port}/status`)
  check('unauthenticated status is rejected', unauthorised.status === 401, `status ${unauthorised.status}`)

  // ── test 4b: the health probe the Web GUI lamp depends on ───────────────
  process.stdout.write('\ntest 4b — /health is readable from the loopback page, and only from there\n')
  const fromGui = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin: 'http://127.0.0.1:3080' } })
  check('the loopback page is answered', fromGui.status === 200, `status ${fromGui.status}`)
  check(
    'the loopback page is granted CORS',
    fromGui.headers.get('access-control-allow-origin') === 'http://127.0.0.1:3080',
    String(fromGui.headers.get('access-control-allow-origin')),
  )
  check('the answer is not cached', fromGui.headers.get('cache-control') === 'no-store')
  await fromGui.body?.cancel()

  const fromWeb = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin: 'https://example.invalid' } })
  check(
    'a public page is not granted CORS',
    fromWeb.headers.get('access-control-allow-origin') === null,
    String(fromWeb.headers.get('access-control-allow-origin')),
  )
  await fromWeb.body?.cancel()

  const noOrigin = await fetch(`http://127.0.0.1:${port}/health`)
  check('a same-origin probe still works', noOrigin.status === 200, `status ${noOrigin.status}`)
  await noOrigin.body?.cancel()

  // ── test 5: the CLI sees the same state ─────────────────────────────────
  process.stdout.write('\ntest 5 — cli status\n')
  const cli = spawnSync(process.execPath, [agentEntry, 'status'], {
    env: { ...process.env, DSH_RESTART_STATE_DIR: stateDir },
    encoding: 'utf8',
  })
  check('cli reports the control agent', (cli.stdout ?? '').includes('control agent'), cli.stdout ?? cli.stderr)
  check('cli reports the tracked pid', (cli.stdout ?? '').includes('tracked pid'))

  // ── test 6: the agent is orphaned from whoever started it ───────────────
  process.stdout.write('\ntest 6 — the agent is not a descendant of its caller\n')
  const agentInfo = JSON.parse(readFileSync(join(stateDir, 'agent.json'), 'utf8'))
  check('agent records its parent pid', typeof agentInfo.ppid === 'number', String(agentInfo.ppid))
  check('agent is orphaned from the spawning process', agentInfo.ppid !== process.pid,
    `ppid ${agentInfo.ppid} vs caller ${process.pid}`)
  // A working directory inside the package locks it on Windows, which makes
  // the next `pnpm add` fail with EPERM and leaves the profile without the
  // plugin. The agent must live outside its own package.
  check('the agent does not run inside its own package', !String(agentInfo.cwd ?? '').includes('dsh-restart'),
    String(agentInfo.cwd))

  // ── test 7: build output stays harness-free ─────────────────────────────
  process.stdout.write('\ntest 7 — the agent bundle has no harness imports\n')
  const agentSource = readFileSync(agentEntry, 'utf8')
  check('agent.js does not import @deepseek-ai', !agentSource.includes('@deepseek-ai'))
  check('agent.js exists', existsSync(agentEntry))
} catch (error) {
  failures.push(`harness error: ${error.message}`)
  process.stdout.write(`\nFAIL harness error: ${error.stack}\n`)
} finally {
  await api('/shutdown').catch(() => {})
  await sleep(700)
  // Belt and braces: a supervised restart can leave the agent busy enough to
  // miss the shutdown window, and a lingering listener would break the next run.
  try {
    const remaining = JSON.parse(readFileSync(join(stateDir, 'agent.json'), 'utf8'))
    process.kill(remaining.pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
  launcher.kill('SIGKILL')
}

process.stdout.write(`\n${checks.length - failures.length}/${checks.length} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('failures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.stdout.write('\n--- agent log ---\n')
  process.stdout.write(agentLog)
  exitCode = 1
}
process.exit(exitCode)
