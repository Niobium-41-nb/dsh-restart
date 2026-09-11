/**
 * Tests for the browser half: the sidebar supervisor lamp.
 *
 * The client bundle is hand-written plain JS in the host's lazy-CJS protocol,
 * so it can be loaded and driven in Node with nothing but a stub `window`, a
 * stub `require`, and a stub cordis context. That covers everything except the
 * pixels: which slot it claims, what it does when `slots` never appears, and
 * how the two probes map onto the lamp's states.
 *
 * Run: node tests/client.test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

const eq = (label, actual, expected) => ok(label, JSON.stringify(actual) === JSON.stringify(expected), `actual ${JSON.stringify(actual)}`)

/** Load the client bundle the way the host's module loader does. */
function loadClient(reactImpl, stubs = {}) {
  const loads = []
  globalThis.window = {
    __ModuleLoader__: { load: (definition) => { loads.push(definition) } },
    localStorage: stubs.localStorage ?? {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    sessionStorage: stubs.sessionStorage ?? {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    location: stubs.location ?? { reload: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  globalThis.fetch = () => Promise.reject(new Error('no network in this test'))
  const path = fileURLToPath(new URL('../client/index.js', import.meta.url))
  const source = readFileSync(path, 'utf8')
  // eslint-disable-next-line no-new-func -- executes the captured bundle text.
  new Function('window', 'document', source)(
    globalThis.window,
    stubs.document ?? { addEventListener: () => {} },
  )

  ok('the bundle registers exactly one module', loads.length === 1)
  const definition = loads[0]
  ok('the module id is the package name', definition.id === 'dsh-restart', definition.id)
  const react = reactImpl === undefined
    ? {
      createElement: () => ({ kind: 'element' }),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
    }
    : reactImpl
  const exports = definition.factory((id) => {
    if (id === 'react') {
      if (react === null) throw new Error('react is not available')
      return react
    }
    throw new Error(`unexpected require: ${id}`)
  })
  return { exports, react }
}

/** A storage stub with the three methods the bundle uses. */
function makeStore() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    raw: map,
  }
}

/**
 * A DOM just large enough for the notice card: elements, ids, and the
 * append/remove bookkeeping the renderer relies on.
 */
function makeDom() {
  const byId = new Map()
  const nodes = []
  const element = (tagName) => {
    const node = {
      tagName,
      id: '',
      children: [],
      parentNode: null,
      attributes: {},
      textContent: '',
      style: { cssText: '', setProperty(name, value) { node.style[name] = value } },
      appendChild(child) {
        child.parentNode = node
        node.children.push(child)
        if (child.id !== '') byId.set(child.id, child)
        return child
      },
      removeChild(child) {
        node.children = node.children.filter((entry) => entry !== child)
        child.parentNode = null
        if (child.id !== '') byId.delete(child.id)
        return child
      },
      setAttribute(name, value) { node.attributes[name] = value },
      getAttribute(name) { return node.attributes[name] },
    }
    nodes.push(node)
    return node
  }
  const body = element('body')
  return {
    body,
    /** Every element ever created, including ones later removed. */
    nodes,
    createElement: (tagName) => element(tagName),
    getElementById: (id) => byId.get(id) ?? null,
    /** All text under one element, flattened. */
    textOf(node) {
      if (node === null || node === undefined) return []
      const own = node.textContent === '' ? [] : [node.textContent]
      return [...own, ...node.children.flatMap((child) => this.textOf(child))]
    },
  }
}

process.stdout.write('\nthe client module contract\n')
const { exports: client } = loadClient()
ok('exports a cordis plugin name', typeof client.name === 'string' && client.name.length > 0, client.name)
ok('exports an apply function', typeof client.apply === 'function')
ok('declares no package-level inject (nothing can miss)', Array.isArray(client.inject) && client.inject.length === 0, JSON.stringify(client.inject))

process.stdout.write('\nslot registration\n')
{
  // The seat this plugin wants is declared by ANOTHER entry: the sidebar
  // declares `sidebar.footer.action` when ui-sidebar's own apply registers the
  // `sidebar` entry, and apply order is not a contract. Registering eagerly is
  // therefore a race the plugin loses silently — measured on 0.1.5, where the
  // bundle loaded and `register` threw "slot ... is not declared", leaving no
  // lamp at all. The declaration-aware `slots.inject` is the only correct route.
  const registered = []
  const waits = []
  const disposers = []
  const ctx = {
    inject(names, callback) {
      eq('injects only the slot service', names, ['slots'])
      callback({
        slots: {
          register: (options, component) => {
            registered.push({ options, component })
            const dispose = () => {}
            disposers.push(dispose)
            return dispose
          },
          inject: (key, callback) => {
            waits.push({ key, callback })
            return () => {}
          },
        },
      })
    },
  }
  client.apply(ctx)

  ok('never registers before the host declares the seat', registered.length === 0, String(registered.length))
  eq('waits on the sidebar footer action seat', waits.map((wait) => wait.key), ['sidebar.footer.action'])

  // The declaration lands later (the production ordering): the seat is claimed then.
  const dispose = waits[0].callback()
  ok('claims the seat once the declaration arrives', registered.length === 1, String(registered.length))
  ok('hands the declaration controller the registration disposer', dispose === disposers[0])
  const { options, component } = registered[0] ?? {}
  ok('claims the sidebar footer action seat', options?.name === 'sidebar.footer.action', options?.name)
  ok('uses a stable entry id', options?.id === 'dsh-restart-indicator', options?.id)
  ok('orders the lamp after the shipped footer entries', options?.order === 40, String(options?.order))
  ok('renders the indicator component', typeof component === 'function')
  ok('exports the seat it claims', client.__internals.SLOT === options?.name)
}

process.stdout.write('\na host that declares the seat first still gets a lamp\n')
{
  // Equivalent path, opposite timing: `slots.inject` runs the callback
  // synchronously when the declaration already exists.
  const registered = []
  client.apply({
    inject: (_names, callback) => callback({
      slots: {
        register: (options) => { registered.push(options); return () => {} },
        inject: (_key, callback) => { callback(); return () => {} },
      },
    }),
  })
  ok('registers immediately when the seat is declared already', registered.length === 1, String(registered.length))
}

process.stdout.write('\na refusing host never breaks the page load\n')
{
  // register() throwing inside the callback is a setup failure the page must
  // survive: the lamp is optional, the Web UI is not. Each shape below must
  // swallow it and still hand a callable disposer back to the host.
  const originalWarn = console.warn
  console.warn = () => {}
  const claims = []
  /** Drive apply with a stub slots service, recording what the host would dispose. */
  const attempt = (slots) => {
    try {
      client.apply({
        inject: (_names, callback) => callback({
          slots: {
            register: slots.register,
            inject: slots.inject === undefined
              ? undefined
              : (key, callback) => {
                eq('waits on the declared seat', key, 'sidebar.footer.action')
                const dispose = callback()
                claims.push(dispose)
                return dispose
              },
          },
        }),
      })
      return true
    } catch {
      return false
    }
  }
  const declared = attempt({ register: () => { throw new Error('seat occupied') } })
  const refused = attempt({ register: () => () => {}, inject: () => { throw new Error('no such slot') } })
  console.warn = originalWarn
  ok('a throwing seat claim is contained', declared)
  ok('a refused wait is contained', refused)
  ok('a contained failure still hands back a callable disposer',
    claims.length === 1 && typeof claims[0] === 'function', JSON.stringify(claims.map((d) => typeof d)))

  // Older host shape: no declaration-aware injection at all — the direct route
  // is all that shape allows, and it must not throw either.
  const legacyWarn = console.warn
  console.warn = () => {}
  let legacyThrew = false
  try {
    client.apply({
      inject: (_names, callback) => callback({ slots: { register: () => { throw new Error('seat occupied') } } }),
    })
  } catch {
    legacyThrew = true
  }
  console.warn = legacyWarn
  ok('a legacy host without slots.inject is contained too', legacyThrew === false)
}

process.stdout.write('\na host without the slot service stays inert\n')
{
  let called = false
  client.apply({ inject: () => { called = true } })
  ok('does not throw when inject is missing', true)
  ok('never reaches the callback without slots', called === true)
  // No `inject` at all: the plugin must be a no-op, not a crash.
  let threw = false
  try {
    client.apply({})
  } catch {
    threw = true
  }
  ok('does not throw on a bare context', threw === false)
  // A slots service without `register` (a host that renamed the API).
  const registered = []
  let bareThrew = false
  try {
    client.apply({ inject: (_names, callback) => callback({ slots: {} }) })
  } catch {
    bareThrew = true
  }
  ok('does not throw on a slots service without register', bareThrew === false && registered.length === 0)
}

process.stdout.write('\nlamp states\n')
{
  const { phaseOf, LOOK } = client.__internals
  eq('agent up + harness up is ready', phaseOf(true, true), 'ready')
  eq('agent up + harness down is a restart in flight', phaseOf(true, false), 'restarting')
  eq('agent down + harness up is a missing supervisor', phaseOf(false, true), 'agent-down')
  eq('both down needs a manual start', phaseOf(false, false), 'unreachable')
  for (const phase of ['ready', 'restarting', 'agent-down', 'unreachable']) {
    ok(`"${phase}" has a colour and an explanation`, typeof LOOK[phase]?.color === 'string' && LOOK[phase].title.length > 0)
  }
  ok('only the healthy state hides its label', LOOK.ready.label === '' && LOOK.restarting.label !== '' && LOOK['agent-down'].label !== '')
  ok('the worst state still says what to do, in its tooltip',
    LOOK.unreachable.title.includes('手动启动'), LOOK.unreachable.title)
  // Measured in a real browser at the default 280px sidebar: the lamp is
  // right-aligned in the sidebar foot and only ~48px of label is on screen.
  // A longer label is clipped mid-glyph, so the copy must stay short.
  for (const phase of ['restarting', 'agent-down', 'unreachable']) {
    const label = LOOK[phase].label
    ok(`"${phase}" labels itself in four characters or fewer`, [...label].length <= 4, label)
  }
  ok('the default agent url is the loopback default', client.__internals.DEFAULT_AGENT === 'http://127.0.0.1:3099')
  ok('the host route is plugin-namespaced', client.__internals.HOST_ROUTE === '/dsh-restart/status', client.__internals.HOST_ROUTE)
}

process.stdout.write('\nthe lamp is a circle, and its label cannot be sliced\n')
{
  // The host theme smooths every rounded corner into a superellipse
  // (`ui-theme`'s corner-shape.css applies `corner-shape` to `*`), which turns
  // a 50% radius into a rounded square. Measured in a real browser: the lamp
  // rendered as a squircle until it paired the radius with `corner-shape:
  // round`, exactly as the host's own StateDot does.
  /** Render one state with a React stub that records the element tree. */
  const render = (snapshot) => {
    const calls = []
    const recording = {
      createElement: (type, props, ...children) => {
        calls.push({ type, props, children: children.flat() })
        return { type, props, children: children.flat() }
      },
      // The probe effect is inert here, so the snapshot decides the phase.
      useState: () => [snapshot ?? { phase: 'ready', detail: '', probing: false }, () => {}],
      useEffect: () => {},
    }
    const { exports: recorded } = loadClient(recording)
    recorded.__internals.Indicator({})
    const dot = calls.find((call) => call.props?.['aria-hidden'] === 'true')
    const label = calls.find((call) => call.type === 'span' && call.props?.style !== undefined && call.props?.['aria-hidden'] === undefined)
    return { calls, dot, label, text: calls.flatMap((call) => call.children).filter((child) => typeof child === 'string') }
  }

  const ready = render()
  ok('the lamp renders a dot', ready.dot !== undefined)
  ok('the dot is full-round', ready.dot?.props?.style?.borderRadius === '50%', String(ready.dot?.props?.style?.borderRadius))
  ok('the dot opts out of the theme superellipse', ready.dot?.props?.style?.cornerShape === 'round', String(ready.dot?.props?.style?.cornerShape))
  ok('the healthy state renders no label text', ready.text.length === 0, JSON.stringify(ready.text))

  const worst = render({ phase: 'unreachable', detail: '', probing: false })
  ok('a labelled state ellipsizes instead of clipping',
    worst.label?.props?.style?.textOverflow === 'ellipsis' && worst.label?.props?.style?.overflow === 'hidden',
    JSON.stringify(worst.label?.props?.style))
  eq('and shows the short label, not the tooltip sentence', worst.text, ['无响应'])
  ok('the colour follows the phase', worst.dot?.props?.style?.background === '#ef4444', String(worst.dot?.props?.style?.background))
  // createElement receives its children first, so the root is the last call.
  const root = worst.calls.at(-1)
  ok('the tooltip still carries the actionable sentence',
    typeof root?.props?.title === 'string' && root.props.title.includes('手动启动'), String(root?.props?.title))
}

process.stdout.write('\na broken indicator never breaks the page\n')
{
  // A component that throws while the sidebar renders it could take the whole
  // application down; React has no boundary above it here.
  const exploding = {
    createElement: () => { throw new Error('render exploded') },
    useState: () => { throw new Error('state exploded') },
    useEffect: () => {},
  }
  const { exports: broken } = loadClient(exploding)
  const original = console.warn
  console.warn = () => {}
  let value = 'threw'
  try {
    value = broken.__internals.Indicator({})
  } catch {
    value = 'threw'
  }
  console.warn = original
  ok('a failing render returns null instead of throwing', value === null, String(value))

  // React missing entirely: the plugin must not register anything at all.
  const { exports: noReact } = loadClient(null)
  const registered = []
  const originalWarn = console.warn
  console.warn = () => {}
  let threw = false
  try {
    noReact.apply({ inject: (_names, callback) => callback({ slots: { register: (options) => { registered.push(options) } } }) })
  } catch {
    threw = true
  }
  console.warn = originalWarn
  ok('no react means no registration, and no throw', threw === false && registered.length === 0, `threw=${String(threw)} registered=${String(registered.length)}`)
}

process.stdout.write('\na page left over from a replaced process reloads itself\n')
{
  // The page outlives the harness by design (that is why the lamp probes the
  // control agent directly), so after a restart the tab keeps running the shell
  // it was loaded from and nothing on the server can tell it that. The host
  // identity in the status document is the one signal that survives.
  const { reloadDecision, RELOAD_GUARD_MS } = client.__internals
  eq('the first answer is adopted', reloadDecision(null, 'boot-a', 0, 1_000), 'adopt')
  eq('the same host answering again is not a restart', reloadDecision('boot-a', 'boot-a', 0, 1_000), 'hold')
  eq('a different host means this page is stale', reloadDecision('boot-a', 'boot-b', 0, 1_000_000), 'reload')
  eq('an answer without a host identity is ignored', reloadDecision('boot-a', '', 0, 1_000_000), 'hold')
  eq('a flapping host cannot loop the tab', reloadDecision('boot-a', 'boot-b', 999_000, 1_000_000), 'hold')
  eq('and is let through once the guard expires',
    reloadDecision('boot-a', 'boot-b', 1_000_000 - RELOAD_GUARD_MS, 1_000_000), 'reload')

  // The very first restart after this feature is installed has no recorded
  // identity to compare against, so the page compares *ages* instead: a host
  // that started after this document was loaded cannot be the one that served
  // it. Without this the first restart would look like a fresh page.
  eq('a host younger than the page means the page is stale',
    reloadDecision(null, 'boot-b', 0, 1_000_000, 900_000, 800_000), 'reload')
  eq('a host older than the page is simply this page\'s own host',
    reloadDecision(null, 'boot-b', 0, 1_000_000, 700_000, 800_000), 'adopt')
  eq('a page served while its host is still starting is not stale',
    reloadDecision(null, 'boot-b', 0, 1_000_000, 800_500, 800_000), 'adopt')
  eq('and the reload guard still applies to the age signal',
    reloadDecision(null, 'boot-b', 999_000, 1_000_000, 900_000, 800_000), 'hold')
}

process.stdout.write('\nthe restart is announced where the user is already looking\n')
{
  const session = makeStore()
  const local = makeStore()
  const dom = makeDom()
  const { exports: page } = loadClient(undefined, {
    sessionStorage: session,
    localStorage: local,
    document: dom,
  })
  const internals = page.__internals
  /** How many notice cards have ever been drawn, including removed ones. */
  const cards = () => dom.nodes.filter((node) => node.id === internals.NOTICE_ID).length

  ok('the per-tab keys are distinct from the browser-wide one',
    internals.HOST_KEY !== internals.NOTICE_KEY
    && internals.NOTICE_KEY !== internals.SEEN_KEY
    && internals.HOST_KEY !== internals.SEEN_KEY)

  const status = {
    host: { pid: 33828, bootId: 'boot-b' },
    lastReport: {
      status: 'ok',
      headline: 'DeepSeek Harness restarted as pid 33828.',
      createdAt: new Date().toISOString(),
      durationMs: 37485,
      attempts: 1,
      rolledBack: false,
      resumed: 'resumed',
    },
  }
  const notice = internals.noticeOf(status)
  ok('the notice collapses the status document',
    notice.pid === 33828 && notice.status === 'ok' && notice.attempts === 1, JSON.stringify(notice))
  ok('a host with no report still yields a notice', internals.noticeOf({ host: {} }).status === 'unknown')
  eq('sub-second durations stay in milliseconds', internals.humanDuration(480), '480 ms')
  eq('durations read the way a human says them', internals.humanDuration(37485), '37.5 s')
  eq('long restarts switch to minutes', internals.humanDuration(125_000), '2 min 5 s')
  eq('a missing duration renders as nothing', internals.humanDuration(null), '')

  // What a reloading tab leaves behind for its successor: the successor's first
  // status answer already describes the *current* host, so the restart it just
  // lived through is otherwise invisible.
  session.setItem(internals.NOTICE_KEY, JSON.stringify(notice))
  internals.announcePending()
  ok('the staged notice is drawn after the reload', cards() === 1, String(cards()))
  ok('it says the session continued by itself',
    dom.textOf(dom.getElementById(internals.NOTICE_ID)).some((line) => line.includes('会话已自动继续')))
  ok('it names the new process',
    dom.textOf(dom.getElementById(internals.NOTICE_ID)).some((line) => line.includes('pid 33828')))
  ok('the staging record is consumed', session.getItem(internals.NOTICE_KEY) === null)
  ok('the report is marked as announced browser-wide',
    local.getItem(internals.SEEN_KEY) === internals.signatureOf(notice),
    String(local.getItem(internals.SEEN_KEY)))

  internals.announceOnce(status)
  ok('the same report is never announced twice', cards() === 1, String(cards()))

  // The supervisor writes a provisional record before it spawns anything and
  // overwrites it in place once the attempt settles — same id, same
  // `createdAt`, different verdict. A card staged during that window has to be
  // able to correct itself, or the user is left reading "restarting" forever.
  const provisional = {
    host: status.host,
    lastReport: {
      status: 'in-progress',
      headline: 'Restart in progress: end-to-end test.',
      createdAt: new Date(Date.now() + 500).toISOString(),
      durationMs: null,
      attempts: 0,
      rolledBack: false,
      resumed: null,
    },
  }
  internals.announceOnce(provisional)
  ok('the provisional record is announced as it stands', cards() === 2, String(cards()))

  const settled = {
    host: status.host,
    lastReport: {
      ...provisional.lastReport,
      status: 'ok',
      headline: 'DeepSeek Harness restarted as pid 33828.',
      attempts: 2,
      resumed: 'resumed',
    },
  }
  internals.announceOnce(settled)
  ok('a settled verdict replaces the provisional card', cards() === 3, String(cards()))
  ok('and the card on screen is the settled one',
    dom.textOf(dom.getElementById(internals.NOTICE_ID)).some((line) => line.includes('DeepSeek Harness restarted as pid 33828.')),
    JSON.stringify(dom.textOf(dom.getElementById(internals.NOTICE_ID))))
  internals.announceOnce(settled)
  ok('the corrected card is not redrawn on every probe', cards() === 3, String(cards()))

  // A tab that stayed open across the restart (nothing reloaded it), or one
  // opened by a user who never saw the outcome.
  const later = {
    host: { pid: 9, bootId: 'boot-c' },
    lastReport: {
      status: 'rolled-back',
      headline: 'The first boot failed; the configuration was rolled back.',
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      durationMs: 90_000,
      attempts: 2,
      rolledBack: true,
      resumed: 'failed: session log is locked',
    },
  }
  internals.announceOnce(later)
  ok('a newer report is announced on its own', cards() === 4, String(cards()))
  const rollbackCard = dom.textOf(dom.getElementById(internals.NOTICE_ID))
  ok('a rollback is introduced as one', rollbackCard.some((line) => line.includes('已回滚配置并重启')), JSON.stringify(rollbackCard))
  ok('the rollback and the attempt count are shown',
    rollbackCard.some((line) => line.includes('2 次尝试')) && rollbackCard.some((line) => line.includes('已回滚配置')))

  internals.announceOnce({
    host: {},
    lastReport: { status: 'ok', headline: 'old news', createdAt: new Date(Date.now() - 3_600_000).toISOString() },
  })
  ok('yesterday\'s restart is not replayed', cards() === 4, String(cards()))

  // Closing the card is the user's decision, so it has to work.
  const card = dom.getElementById(internals.NOTICE_ID)
  dom.body.removeChild(card)
  ok('the card can be dismissed', dom.getElementById(internals.NOTICE_ID) === null)
}

process.stdout.write('\na hostile document cannot take the page down\n')
{
  // Same rule as the lamp: an exception here would run inside the host's own
  // boot path, and losing a notice is always acceptable.
  const session = makeStore()
  const dom = { body: {}, createElement: () => { throw new Error('no DOM for you') } }
  const { exports: page } = loadClient(undefined, {
    sessionStorage: session,
    localStorage: makeStore(),
    document: dom,
  })
  session.setItem(page.__internals.NOTICE_KEY, JSON.stringify({ status: 'ok', createdAt: null }))
  const originalWarn = console.warn
  console.warn = () => {}
  let threw = false
  let drew = null
  try {
    drew = page.__internals.renderNotice({ status: 'ok' })
  } catch {
    threw = true
  }
  console.warn = originalWarn
  ok('a document that refuses to create elements is contained', threw === false && drew === false)
}

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
