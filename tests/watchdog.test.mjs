/**
 * Tests for the resurrection watchdog — the safety net armed just before a
 * graceful restart exits.
 *
 * Every case here is a way to get it wrong that costs more than the bug it
 * guards: starting a second harness while the agent is still working on the
 * first, or standing by while the harness stays down. The watchdog is a real
 * process with a real command line, so the tests run it as one: a state
 * directory, a launch specification, a fake control agent on a loopback port,
 * and the log it actually wrote.
 *
 * The suite needs the built artifacts (`lib/watchdog.js`), exactly like the
 * agent's own end-to-end file: `tsc -b tsconfig.json && node node_modules/tsdown/dist/run.mjs`.
 *
 * Run: node tests/watchdog.test.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const watchdogPath = join(repoRoot, 'lib', 'watchdog.js')

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

/** A PID that provably belonged to a process that has already exited. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid
  await new Promise((resolve) => { child.on('exit', resolve) })
  return pid
}

/** A fresh state directory with one registered instance. */
function makeState(instance = 'labkey') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-watchdog-'))
  mkdirSync(join(root, 'instances', instance), { recursive: true })
  mkdirSync(join(root, 'reports'), { recursive: true })
  writeFileSync(join(root, 'token'), 'watchdog-test-token\n')
  return { root, instance }
}

/** Write the launch specification the watchdog relaunches from. */
function writeSpec(state, spec) {
  writeFileSync(join(state.root, 'instances', state.instance, 'launch.json'), `${JSON.stringify({
    version: 1,
    pid: spec.pid,
    launchId: 'test',
    startedAt: new Date().toISOString(),
    cwd: spec.cwd ?? state.root,
    execPath: process.execPath,
    execArgv: [],
    argv: spec.argv,
    env: spec.env ?? {},
    webSurface: spec.webSurface ?? false,
  }, null, 2)}\n`)
}

/** Point the state directory at a fake control agent. */
function writeAgent(state, port, { pid = process.pid } = {}) {
  writeFileSync(join(state.root, 'agent.json'), `${JSON.stringify({
    version: 1,
    pid,
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
    startedAt: new Date().toISOString(),
    agentVersion: 'test',
    stateDir: state.root,
  }, null, 2)}\n`)
}

/** Run the watchdog and collect everything observable about the run. */
async function runWatchdog(state, options = {}) {
  const args = [
    watchdogPath,
    '--state-dir', state.root,
    '--instance', state.instance,
    '--pid', String(options.pid),
    '--wait-ms', String(options.waitMs ?? 2_000),
    '--poll-ms', String(options.pollMs ?? 100),
    '--silence-ms', String(options.silenceMs ?? 200),
  ]
  if (options.reason !== undefined) args.push('--reason', options.reason)
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise((resolve) => { child.on('exit', resolve) })
  const log = (() => {
    try {
      return readFileSync(join(state.root, 'logs', 'watchdog.log'), 'utf8')
    } catch {
      return ''
    }
  })()
  return { code, stdout, stderr, log }
}

/** A marker file the "relaunched harness" writes, proving it really started. */
function relaunchSpec(state, marker) {
  return {
    argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
  }
}

const markerSeen = async (marker) => {
  for (let i = 0; i < 40; i += 1) {
    try {
      return readFileSync(marker, 'utf8') === 'started'
    } catch {
      await sleep(100)
    }
  }
  return false
}

if (!readdirSync(join(repoRoot, 'lib')).includes('watchdog.js')) {
  process.stdout.write('\nthe watchdog bundle is missing — run the build first:\n')
  process.stdout.write('  node node_modules/typescript/bin/tsc -b tsconfig.json && node node_modules/tsdown/dist/run.mjs\n')
  process.exit(1)
}

process.stdout.write('\nthe standalone bundles stay runnable without the harness\n')
{
  // The rule is about real imports, not about mentioning the package name: the
  // sources explain in comments WHICH harness import they deliberately avoid,
  // and those comments survive into the bundle.
  const withoutComments = (source) => source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/^\s*\/\/.*$/gmu, '')
  const offenders = readdirSync(join(repoRoot, 'lib'))
    .filter((name) => name.endsWith('.js') && name !== 'index.js')
    .filter((name) => withoutComments(readFileSync(join(repoRoot, 'lib', name), 'utf8')).includes('@deepseek-ai/'))
  ok('no standalone artifact imports a harness package', offenders.length === 0, offenders.join(', '))
}

process.stdout.write('\nnobody else brought it back, so the watchdog does\n')
{
  const state = makeState()
  const marker = join(state.root, 'relaunched.txt')
  const pid = await deadPid()
  writeSpec(state, { pid, ...relaunchSpec(state, marker) })
  const result = await runWatchdog(state, { pid, reason: 'unit test' })
  ok('it exits successfully', result.code === 0, `code ${String(result.code)} ${result.stderr}`)
  ok('the recorded command line really started', await markerSeen(marker))
  ok('the log says what it saw', result.log.includes('taking over'), result.log)
  ok('the log records the relaunch', result.log.includes('relaunched'), result.log)
  ok('the log carries the reason', result.log.includes('unit test'), result.log)
  const relaunchLogs = readdirSync(join(state.root, 'logs')).filter((name) => name.startsWith('watchdog-relaunch-'))
  ok('the relaunched process gets a log of its own', relaunchLogs.length === 1, relaunchLogs.join(', '))
}

process.stdout.write('\na replacement is already up\n')
{
  const state = makeState()
  const marker = join(state.root, 'relaunched.txt')
  const pid = await deadPid()
  // Somebody else (the agent, a CLI restart, the user) already started one.
  writeSpec(state, { pid: process.pid, ...relaunchSpec(state, marker) })
  const result = await runWatchdog(state, { pid })
  ok('it stands down', result.code === 0, `code ${String(result.code)}`)
  ok('it starts nothing', !(await markerSeen(marker)))
  ok('and it says why', result.log.includes('a replacement is already up'), result.log)
}

process.stdout.write('\nthe outgoing process is still running\n')
{
  const state = makeState()
  const marker = join(state.root, 'relaunched.txt')
  writeSpec(state, { pid: 999_999, ...relaunchSpec(state, marker) })
  // A short window while watching a live pid: nothing may happen.
  const result = await runWatchdog(state, { pid: process.pid, waitMs: 1_200, silenceMs: 0 })
  ok('it waits instead of starting a second harness', !(await markerSeen(marker)))
  ok('and gives up rather than guessing', result.code === 1, `code ${String(result.code)}`)
}

process.stdout.write('\nthe agent is working on the restart\n')
{
  const state = makeState()
  const marker = join(state.root, 'relaunched.txt')
  const pid = await deadPid()
  writeSpec(state, { pid, ...relaunchSpec(state, marker) })
  const server = createServer((request, response) => {
    const body = JSON.stringify(request.url === '/status' ? { version: 1, busy: true } : { ok: true })
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  writeAgent(state, server.address().port)
  try {
    const result = await runWatchdog(state, { pid, waitMs: 1_500, silenceMs: 0 })
    ok('it stays out of the way', !(await markerSeen(marker)))
    ok('it exits without claiming success', result.code === 1, `code ${String(result.code)}`)
  } finally {
    server.close()
  }
}

process.stdout.write('\nthe agent answers, but is not restarting anything\n')
{
  // The agent survived the failure and is idle: it is not going to spawn, so
  // the harness would stay down forever if nobody stepped in.
  const state = makeState()
  const marker = join(state.root, 'relaunched.txt')
  const pid = await deadPid()
  writeSpec(state, { pid, ...relaunchSpec(state, marker) })
  const server = createServer((request, response) => {
    const body = JSON.stringify(request.url === '/status' ? { version: 1, busy: false } : { ok: true })
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  writeAgent(state, server.address().port)
  try {
    const result = await runWatchdog(state, { pid, silenceMs: 60_000 })
    ok('it takes over even though the agent answers', await markerSeen(marker))
    ok('because that agent is provably not restarting', result.log.includes('no restart in progress'), result.log)
  } finally {
    server.close()
  }
}

process.stdout.write('\na brief silence is not a death certificate\n')
{
  const state = makeState()
  const marker = join(state.root, 'relaunched.txt')
  const pid = await deadPid()
  writeSpec(state, { pid, ...relaunchSpec(state, marker) })
  writeAgent(state, 1, { pid: 1 })
  // The agent is unreachable, but this run is far too short to conclude that.
  const result = await runWatchdog(state, { pid, waitMs: 1_000, silenceMs: 30_000 })
  ok('it does not relaunch on a momentary silence', !(await markerSeen(marker)))
  ok('and it reports that it gave up', result.log.includes('gave up'), result.log)
  ok('the exit code says nothing was recovered', result.code === 1, `code ${String(result.code)}`)
}

process.stdout.write('\nthe report of the dead agent is finished off\n')
{
  const state = makeState()
  const marker = join(state.root, 'relaunched.txt')
  const pid = await deadPid()
  writeSpec(state, { pid, ...relaunchSpec(state, marker) })
  const reportFile = join(state.root, 'reports', 'restart-2027-03-03_00-00-00-000-lab000.json')
  writeFileSync(reportFile, `${JSON.stringify({
    version: 1,
    id: 'restart-2027-03-03_00-00-00-000-lab000',
    createdAt: '2027-03-03T00:00:00.000Z',
    status: 'in-progress',
    headline: 'Restart in progress: unit test.',
    reason: 'unit test',
    requestedBy: 'tool',
    fromPid: pid,
    attempts: [],
    deliveredAt: '2027-03-03T00:00:05.000Z',
  }, null, 2)}\n`)
  await runWatchdog(state, { pid })
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  ok('the record reaches a terminal state', report.status === 'ok', report.status)
  ok('it names the watchdog as the one that recovered it', report.headline.includes('watchdog'), report.headline)
  ok('it explains what it saw', String(report.error).includes('recovered by the watchdog'), String(report.error))
  ok('and it keeps the delivery mark', report.deliveredAt === '2027-03-03T00:00:05.000Z', String(report.deliveredAt))
}

process.stdout.write('\nthe two-stage launcher hands the watchdog to nobody\n')
{
  const state = makeState()
  const marker = join(state.root, 'relaunched.txt')
  const pid = await deadPid()
  writeSpec(state, { pid, ...relaunchSpec(state, marker) })
  const started = Date.now()
  const launcher = spawn(process.execPath, [
    watchdogPath, '__spawn-detached',
    '--state-dir', state.root,
    '--instance', state.instance,
    '--pid', String(pid),
    '--wait-ms', '4_000'.replace('_', ''),
    '--poll-ms', '100',
    '--silence-ms', '200',
  ], { stdio: 'ignore' })
  const code = await new Promise((resolve) => { launcher.on('exit', resolve) })
  ok('the launcher exits immediately', code === 0 && Date.now() - started < 3_000, `code ${String(code)}`)
  // The real watchdog is an orphan now; it still does its job.
  ok('the detached watchdog still recovers the harness', await markerSeen(marker))
}

process.stdout.write('\na command line it cannot trust\n')
{
  const state = makeState()
  const bad = spawn(process.execPath, [watchdogPath, '--state-dir', state.root], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  bad.stderr.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise((resolve) => { bad.on('exit', resolve) })
  ok('a missing --instance is refused', code === 2, `code ${String(code)}`)
  ok('and it prints usage instead of guessing', stderr.includes('--instance is required'), stderr.slice(0, 200))
  ok('nothing was written to the state directory', !readdirSync(state.root).includes('logs'))
}

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
