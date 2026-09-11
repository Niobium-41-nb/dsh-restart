/**
 * Real-browser check of the sidebar lamp: the level of verification that
 * actually caught the bug this file exists to prevent.
 *
 * Why it is needed. On harness 0.1.5 the lamp loaded, exported, and applied
 * perfectly — unit tests were green, the boot graph carried
 * `dsh-restart/client.js`, and the bytes the server sent matched the source
 * byte for byte. It still never appeared: `slots.register` threw "slot ...
 * is not declared" because the sidebar declares that seat from ITS OWN apply,
 * and the plugin lost that race. Nothing short of a rendered page can tell you
 * that, which is exactly what this test renders.
 *
 * It drives a real Chrome over CDP, captures all four lamp states, and asserts
 * the pixels-level facts (colour, label, shape, and that the sidebar does not
 * clip the label). States are produced by BLOCKING REQUESTS in the browser, so
 * the test never stops the real control agent and is safe to run while you are
 * using the machine. It does need a running Web GUI; without one it skips.
 *
 * Run: node tests/lamp.browser.mjs
 * Env: DSH_GUI_URL (default http://127.0.0.1:3080), CHROME_PATH, KEEP_SHOTS=1
 *
 * Costs: opens one headless browser window (invisible), takes ~40s, and
 * writes screenshots to a temp directory unless KEEP_SHOTS points elsewhere.
 */

import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const GUI = process.env.DSH_GUI_URL ?? 'http://127.0.0.1:3080'
const AUTHORITY = new URL(GUI).host
const CHROME = process.env.CHROME_PATH ?? [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => existsSync(candidate))

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

/** The harness signs a persistent browser-session cookie with this secret. */
function mintCookie() {
  try {
    const yaml = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = /secret:\s*([A-Za-z0-9_-]+)/u.exec(yaml)
    if (match === null) return undefined
    const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
    const b64 = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
    const now = Date.now()
    const body = b64(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 }), 'utf8'))
    return {
      name: `dsh-auth-${b64(createHash('sha256').update(AUTHORITY).digest())}`,
      value: `v1.${body}.${b64(createHmac('sha256', secret).update(body).digest())}`,
    }
  } catch {
    return undefined
  }
}

/** Minimal CDP client: one websocket, promise per command. */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.next = 1
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id === undefined) {
        this.events.push(message)
        return
      }
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.next++
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`)) }, 30_000)
    })
  }
}

/** The lamp is found by shape (an 8px dot), never by copy: only one of the four states has a label-free tooltip. */
const LAMP_EXPR = `(() => {
  const dotOf = (el) => {
    const dot = el.firstElementChild
    if (!dot) return null
    const cs = getComputedStyle(dot)
    return cs.width === '8px' && cs.height === '8px' ? cs : null
  }
  let el = null
  let cs = null
  for (const candidate of document.querySelectorAll('div[title]')) {
    const found = dotOf(candidate)
    if (found !== null) { el = candidate; cs = found; break }
  }
  if (el === null) return { found: false, titles: [...document.querySelectorAll('[title]')].map((e) => e.getAttribute('title')) }
  const labelEl = el.children[1] ?? null
  const labelRect = labelEl === null ? null : labelEl.getBoundingClientRect()
  const sidebar = document.querySelector('aside, [class*=sidebarCol]')
  const sidebarRect = sidebar === null ? null : sidebar.getBoundingClientRect()
  const rootRect = el.getBoundingClientRect()
  return {
    found: true,
    title: el.getAttribute('title'),
    label: (el.textContent || '').trim(),
    colour: cs.backgroundColor,
    opacity: cs.opacity,
    size: cs.width + 'x' + cs.height,
    radius: cs.borderRadius,
    cornerShape: cs.cornerShape,
    inSidebar: el.closest('aside, [class*=sidebar], [class*=Sidebar]') !== null,
    sidebarRight: sidebarRect === null ? null : Math.round(sidebarRect.right),
    lampRight: Math.round(rootRect.right),
    labelRight: labelRect === null ? null : Math.round(labelRect.right),
  }
})()`

const clickFreeProbe = async (cdp, sessionId) => {
  const result = await cdp.send('Runtime.evaluate', { expression: LAMP_EXPR, returnByValue: true }, sessionId)
  return result.result.value
}

const STATES = [
  {
    id: 'ready',
    block: [],
    colour: 'rgb(34, 197, 94)',
    label: '',
    tooltip: '重启守护在线',
  },
  {
    id: 'agent-down',
    block: ['*127.0.0.1:3099*'],
    colour: 'rgb(239, 68, 68)',
    label: '未运行',
    tooltip: '控制 Agent 没有响应',
  },
  {
    id: 'restarting',
    block: ['*dsh-restart/status*'],
    colour: 'rgb(245, 158, 11)',
    label: '重启中',
    tooltip: '正在重启',
  },
  {
    id: 'unreachable',
    block: ['*dsh-restart/status*', '*127.0.0.1:3099*'],
    colour: 'rgb(239, 68, 68)',
    label: '无响应',
    tooltip: '手动启动 DSH',
  },
]

/** Is the Web GUI up at all? Without it this check has nothing to look at. */
async function guiReachable() {
  try {
    const response = await fetch(GUI, { signal: AbortSignal.timeout(4_000) })
    return response.status === 200 || response.status === 401
  } catch {
    return false
  }
}

async function main() {
  process.stdout.write('\nthe sidebar lamp, in a real browser\n')

  if (CHROME === undefined) {
    process.stdout.write('  skip  no Chrome/Chromium found (set CHROME_PATH to run this check)\n')
    return
  }
  if (!await guiReachable()) {
    process.stdout.write(`  skip  no Web GUI answering at ${GUI} (start it, or set DSH_GUI_URL)\n`)
    return
  }

  const port = 9401 + Math.floor(Math.random() * 200)
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-lamp-test-'))
  const shotDir = process.env.KEEP_SHOTS === undefined
    ? mkdtempSync(join(tmpdir(), 'dsh-lamp-shots-'))
    : process.env.KEEP_SHOTS
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' })

  try {
    let version
    for (let i = 0; i < 80; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (response.ok) { version = await response.json(); break }
      } catch { /* not up yet */ }
      await sleep(250)
    }
    ok('a headless browser started', version !== undefined)
    if (version === undefined) return

    const ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => { reject(new Error('devtools websocket refused')) }, { once: true })
    })
    const cdp = new Cdp(ws)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Log.enable', {}, sessionId)
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }, sessionId)

    const cookie = mintCookie()
    if (cookie !== undefined) {
      await cdp.send('Network.setCookie',
        { name: cookie.name, value: cookie.value, domain: new URL(GUI).hostname, path: '/' }, sessionId)
    }

    await cdp.send('Page.navigate', { url: GUI }, sessionId)
    // The boot graph loads plugin modules after the document, and the lamp's
    // first probe runs on mount.
    await sleep(7_000)

    // The failure this test exists for was silent: it showed up only as a
    // console warning. Assert on it directly.
    const warnings = cdp.events
      .filter((event) => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'warning')
      .map((event) => (event.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '))
    ok('the client bundle registers without complaint',
      !warnings.some((text) => text.includes('dsh-restart')), warnings.filter((t) => t.includes('dsh-restart')).join(' | '))

    for (const state of STATES) {
      await cdp.send('Network.setBlockedURLs', { urls: state.block }, sessionId)
      // The lamp re-probes every 3s; two cycles settle a blocked transition.
      await sleep(state.block.length === 0 ? 4_500 : 8_000)
      const lamp = await clickFreeProbe(cdp, sessionId)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
      writeFileSync(join(shotDir, `lamp-${state.id}.png`), Buffer.from(shot.data, 'base64'))

      if (!lamp.found) {
        ok(`[${state.id}] the lamp is rendered`, false, JSON.stringify(lamp.titles))
        continue
      }
      ok(`[${state.id}] the lamp is rendered`, lamp.inSidebar, String(lamp.inSidebar))
      ok(`[${state.id}] colour is ${state.colour}`, lamp.colour === state.colour, lamp.colour)
      ok(`[${state.id}] label is "${state.label || '(none)'}"`, lamp.label === state.label, lamp.label)
      ok(`[${state.id}] tooltip explains it`, lamp.title.includes(state.tooltip), lamp.title.split('\n')[0])
      if (state.label !== '') {
        ok(`[${state.id}] the sidebar does not clip the label`,
          lamp.labelRight !== null && lamp.sidebarRight !== null && lamp.labelRight <= lamp.sidebarRight,
          `label right ${String(lamp.labelRight)} vs sidebar ${String(lamp.sidebarRight)}`)
      }
    }

    // Leave the page as the test found it, and assert it comes back: unblocking
    // everything must return the lamp to healthy without a reload.
    await cdp.send('Network.setBlockedURLs', { urls: [] }, sessionId)
    await sleep(8_000)
    const settled = await clickFreeProbe(cdp, sessionId)
    ok('the lamp recovers to healthy once nothing is blocked',
      settled.found === true && settled.colour === 'rgb(34, 197, 94)' && settled.label === '',
      `${String(settled.colour)} "${String(settled.label)}"`)
    ok('the dot is round', settled.radius === '50%' && String(settled.cornerShape).startsWith('superellipse(1)'),
      `${String(settled.radius)} / ${String(settled.cornerShape)}`)
    ok('the dot is dot-sized', settled.size === '8pxx8px', settled.size)
    ok('the lamp reports the last restart in its tooltip',
      typeof settled.title === 'string' && settled.title.includes('最近一次重启'), settled.title)

    ws.close()
  } finally {
    chrome.kill()
    await sleep(400)
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

try {
  await main()
} catch (error) {
  ok('the browser check ran to completion', false, error instanceof Error ? error.message : String(error))
}

if (checks === 0) {
  process.stdout.write('\nskipped (no checks ran)\n')
  process.exit(0)
}

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
