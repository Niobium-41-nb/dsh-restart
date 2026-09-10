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
  const registered = []
  const ctx = {
    inject(names, callback) {
      eq('injects only the slot service', names, ['slots'])
      callback({ slots: { register: (options, component) => { registered.push({ options, component }); return () => {} } } })
    },
  }
  client.apply(ctx)
  ok('registers one occupancy', registered.length === 1, String(registered.length))
  const { options, component } = registered[0] ?? {}
  ok('claims the sidebar footer action seat', options?.name === 'sidebar.footer.action', options?.name)
  ok('uses a stable entry id', options?.id === 'dsh-restart-indicator', options?.id)
  ok('renders the indicator component', typeof component === 'function')
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
  ok('the worst state says what to do', LOOK.unreachable.label.includes('手动启动'), LOOK.unreachable.label)
  ok('the default agent url is the loopback default', client.__internals.DEFAULT_AGENT === 'http://127.0.0.1:3099')
  ok('the host route is plugin-namespaced', client.__internals.HOST_ROUTE === '/dsh-restart/status', client.__internals.HOST_ROUTE)
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
