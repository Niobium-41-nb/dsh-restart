// Browser half of dsh-restart: the supervisor indicator.
//
// A small lamp in the sidebar foot that answers one question at a glance:
// "is the restart supervisor actually working?" That matters because the
// supervisor is what brings the harness back after a restart — if it is dead,
// a restart leaves the harness stopped and the page spins forever with no hint
// about why.
//
// It probes the control agent DIRECTLY over loopback (http://127.0.0.1:3099),
// not through the harness. That is the whole point: this page stays loaded in
// the browser while the harness is down, so a direct probe can still report
// "supervisor alive, harness restarting" — the one state a user most needs to
// see while waiting.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load),
// importing nothing but React. It deliberately does not touch any
// `@deepseek-ai/dsh-client-*` module beyond the slot registry the host already
// loads for every UI plugin, so a renamed internal package cannot break it.
window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var react = null
    function React() {
      if (react === null) react = require('react')
      return react
    }

    /** Where the agent was last seen, so a reload during downtime still finds it. */
    var URL_KEY = 'dsh-restart.agent-url'
    /** The shipped default; the host route corrects it when one is configured. */
    var DEFAULT_AGENT = 'http://127.0.0.1:3099'
    /** Probe cadence: fast enough to notice a restart, slow enough to be free. */
    var PROBE_MS = 3000
    /** Host route carrying the agent URL and the last restart report. */
    var HOST_ROUTE = '/dsh-restart/status'
    /** The sidebar seat this lamp occupies. */
    var SLOT = 'sidebar.footer.action'
    /** Stable occupancy id, so a re-apply replaces rather than duplicates. */
    var ENTRY_ID = 'dsh-restart-indicator'

    function readUrl() {
      try {
        var stored = window.localStorage.getItem(URL_KEY)
        if (typeof stored === 'string' && /^http:\/\/[^\s]+$/.test(stored)) return stored
      } catch (error) {
        // Storage disabled (private mode, policy): fall back to the default.
      }
      return DEFAULT_AGENT
    }

    function writeUrl(url) {
      try {
        window.localStorage.setItem(URL_KEY, url)
      } catch (error) {
        // Storing the URL is an optimisation, never a requirement.
      }
    }

    /** One reachability probe with a hard deadline. */
    function reachable(url, timeoutMs) {
      return fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
        .then(function (response) { return response.ok })
        .catch(function () { return false })
    }

    /**
     * Resolve the display state from the two probes.
     * @param agentUp whether the control agent answered /health
     * @param hostUp whether the harness answered the plugin route
     */
    function phaseOf(agentUp, hostUp) {
      if (agentUp && hostUp) return 'ready'
      if (agentUp && !hostUp) return 'restarting'
      if (!agentUp && hostUp) return 'agent-down'
      return 'unreachable'
    }

    // Labels are kept SHORT on purpose. The lamp sits in the sidebar foot next
    // to the right edge, and the host aligns it there: measured in a browser at
    // the default 280px sidebar, only ~48px of label width is on screen before
    // the sidebar clips it. A long label is therefore not "informative", it is
    // sliced mid-glyph — the full sentence belongs in the tooltip, which is
    // where a user who wants the why will look anyway.
    var LOOK = {
      ready: { color: '#22c55e', label: '', title: '重启守护在线' },
      restarting: { color: '#f59e0b', label: '重启中', title: '控制 Agent 在线，DeepSeek Harness 正在重启，页面会自动恢复' },
      'agent-down': { color: '#ef4444', label: '未运行', title: '控制 Agent 没有响应：现在重启不会自动拉起 DSH（下次请求重启时插件会尝试重新拉起它）' },
      unreachable: { color: '#ef4444', label: '无响应', title: 'DeepSeek Harness 已停止，且控制 Agent 也没有响应：不会自动恢复，请手动启动 DSH' },
    }

    /**
     * A lamp that cannot break the page.
     *
     * React has no error boundary here — the sidebar owns its own tree — so an
     * exception thrown while rendering this component could take the whole
     * application down. Every failure path inside it therefore returns null:
     * losing an indicator is acceptable, losing the UI is not.
     */
    function Indicator(props) {
      try {
        return Lamp(props)
      } catch (error) {
        console.warn('[dsh-restart] supervisor indicator failed to render:', error)
        return null
      }
    }

    /** The lamp itself. */
    function Lamp() {
      var R = React()
      var [snapshot, setSnapshot] = R.useState({ phase: 'ready', detail: '', probing: true })

      R.useEffect(function () {
        var stopped = false
        var url = readUrl()

        function tick() {
          var agentProbe = reachable(url + '/health', 1500)
          var hostProbe = fetch(HOST_ROUTE, { cache: 'no-store', signal: AbortSignal.timeout(2500) })
            .then(function (response) { return response.ok ? response.json() : null })
            .catch(function () { return null })

          Promise.all([agentProbe, hostProbe]).then(function (results) {
            if (stopped) return
            var agentUp = results[0]
            var status = results[1]
            // The host knows the configured URL; a non-default port is picked up
            // here and remembered for the probes that outlive the harness.
            if (status && status.agent && typeof status.agent.url === 'string' && status.agent.url !== url) {
              url = status.agent.url
              writeUrl(url)
            }
            var last = status && status.lastReport
            setSnapshot({
              phase: phaseOf(agentUp, status !== null),
              probing: false,
              detail: last
                ? '最近一次重启：' + last.status + ' · ' + String(last.headline || '').slice(0, 120)
                : '还没有通过守护重启过',
            })
          })
        }

        tick()
        var timer = window.setInterval(tick, PROBE_MS)
        return function () {
          stopped = true
          window.clearInterval(timer)
        }
      }, [])

      var look = LOOK[snapshot.phase] || LOOK.ready
      return R.createElement(
        'div',
        {
          title: look.title + '\n' + snapshot.detail,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            // Measured in a real browser: the sidebar foot is a row that packs
            // left to right, and the entries before this lamp already fill it.
            // At the default 280px sidebar the lamp gets 53px from where it
            // starts to the sidebar's clip edge, and the dot plus gap spend 14
            // of it — so horizontal padding would come straight out of the
            // label and push the text past the edge. Vertical padding only.
            padding: '2px 0',
            fontSize: '11px',
            lineHeight: '18px',
            color: 'var(--dsh-text-secondary, #8b8b8b)',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          },
        },
        R.createElement('span', {
          'aria-hidden': 'true',
          style: {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            // The host theme smooths EVERY rounded corner into a superellipse
            // (`ui-theme`'s corner-shape.css sets `corner-shape` on `*`), which
            // deforms a 50% radius into a rounded square — measured in a real
            // browser: the lamp rendered as a squircle. Full-round shapes opt
            // back out; the host's own StateDot does the same.
            cornerShape: 'round',
            background: look.color,
            boxShadow: '0 0 0 2px ' + look.color + '33',
            flex: '0 0 auto',
            opacity: snapshot.probing ? 0.45 : 1,
            transition: 'opacity .2s ease',
          },
        }),
        look.label === '' ? null : R.createElement('span', {
          style: {
            // Degrade by ellipsis, never by a hard slice: a narrower sidebar (or
            // a longer translation) must still read as text, not as a clipped
            // glyph. `minWidth: 0` lets a flex item shrink below its content.
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          },
        }, look.label),
      )
    }

    /**
     * Claim the sidebar seat, whenever the host declares it.
     *
     * `slots.register` throws for a slot that is not declared yet ("a parent
     * entry's children table must declare it"), and `sidebar.footer.action` is
     * declared as a child of the `sidebar` entry — which ui-sidebar registers
     * from its own apply. Plugin apply order is not a contract, so registering
     * eagerly loses that race and the lamp silently never appears (measured on
     * 0.1.5: the bundle loaded, `register` threw, the console carried
     * "could not register the supervisor indicator").
     *
     * `slots.inject` is the declaration-aware form: it runs the callback
     * immediately when the seat already exists, and inside the declaring
     * `register()` call otherwise — and again if the declaration collapses and
     * returns. The returned disposer is the registration's own.
     *
     * @param slots - the host slot registry.
     * @returns a disposer that removes the occupancy (or a no-op).
     */
    function claimSeat(slots) {
      var options = { name: SLOT, id: ENTRY_ID, order: 40 }

      function register() {
        try {
          return slots.register(options, Indicator)
        } catch (error) {
          console.warn('[dsh-restart] could not register the supervisor indicator:', error)
          return function () {}
        }
      }

      if (typeof slots.inject === 'function') {
        try {
          return slots.inject(SLOT, register)
        } catch (error) {
          console.warn('[dsh-restart] could not wait for the sidebar seat:', error)
          return function () {}
        }
      }
      // A host without declaration-aware injection: the direct route is all
      // that shape allows, and it works only when the seat is declared already.
      return register()
    }

    function apply(ctx) {
      if (typeof ctx.inject !== 'function') return
      // `slots` is the only service this needs, and it is the one every UI
      // plugin already depends on; a scoped inject keeps the plugin inert on a
      // host that has no sidebar (headless, sdk, acp).
      ctx.inject(['slots'], function (scope) {
        try {
          var slots = scope === undefined || scope === null ? undefined : scope.slots
          if (slots === undefined || typeof slots.register !== 'function') return
          // Resolve the one dependency now, not during a render: a component
          // that throws while the sidebar draws it is far worse than a
          // component that never gets registered.
          React()
          claimSeat(slots)
        } catch (error) {
          console.warn('[dsh-restart] could not register the supervisor indicator:', error)
        }
      })
    }

    exports.name = 'dsh-restart-indicator'
    exports.apply = apply
    exports.inject = []
    // Exposed for this repo's tests only; not part of the plugin contract.
    exports.__internals = {
      Indicator: Indicator,
      phaseOf: phaseOf,
      LOOK: LOOK,
      DEFAULT_AGENT: DEFAULT_AGENT,
      HOST_ROUTE: HOST_ROUTE,
      SLOT: SLOT,
      ENTRY_ID: ENTRY_ID,
      readUrl: readUrl,
      writeUrl: writeUrl,
    }
    return module.exports
  },
})
