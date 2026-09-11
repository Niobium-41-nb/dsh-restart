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
function loadClient(reactImpl) {
  const loads = []
  globalThis.window = {
    __ModuleLoader__: { load: (definition) => { loads.push(definition) } },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  globalThis.fetch = () => Promise.reject(new Error('no network in this test'))
  const path = fileURLToPath(new URL('../client/index.js', import.meta.url))
  const source = readFileSync(path, 'utf8')
  // eslint-disable-next-line no-new-func -- executes the captured bundle text.
  new Function('window', 'document', source)(globalThis.window, { addEventListener: () => {} })

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

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
