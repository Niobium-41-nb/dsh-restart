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
    /**
     * Per-tab record of the process this page was loaded from.
     *
     * Session storage, not local: two tabs may legitimately be at different
     * points of the same restart (one reloaded, one not yet), and a shared key
     * would let whichever reloads first convince the other it was up to date.
     */
    var HOST_KEY = 'dsh-restart.host'
    /** Per-tab: what to announce once the reload below lands. */
    var NOTICE_KEY = 'dsh-restart.notice'
    /** Per-tab: when this tab last reloaded itself, so a flapping host cannot loop it. */
    var RELOAD_KEY = 'dsh-restart.reloaded-at'
    /** Browser-wide: when this browser last saw a restart report announced. */
    var SEEN_KEY = 'dsh-restart.seen-report'
    /** Floor between two automatic reloads of the same tab. */
    var RELOAD_GUARD_MS = 15000
    /**
     * How recent a report must be for a page that merely *loads* next to it to
     * announce it. Opening the app days later should not replay old news.
     */
    var NOTICE_FRESH_MS = 600000
    /** One notice per page, however many paths would like to draw one. */
    var NOTICE_ID = 'dsh-restart-notice'
    /** Bounded retries while the shell finishes mounting its body. */
    var pendingAttempts = 0

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

    /** Read one storage slot, treating a disabled or throwing store as empty. */
    function readSlot(store, key) {
      try {
        var value = window[store].getItem(key)
        return typeof value === 'string' ? value : null
      } catch (error) {
        return null
      }
    }

    /** Write one storage slot; a store that refuses is never fatal. */
    function writeSlot(store, key, value) {
      try {
        window[store].setItem(key, value)
      } catch (error) {
        // Persistence is an optimisation: the lamp works without any of it.
      }
    }

    /** Remove one storage slot. */
    function dropSlot(store, key) {
      try {
        window[store].removeItem(key)
      } catch (error) {
        // See writeSlot.
      }
    }

    /**
     * Decide what to do about the process that answered the status probe.
     *
     * The page outlives the harness on purpose (that is why the lamp probes the
     * control agent directly), so after a restart this tab keeps running
     * JavaScript that was loaded from a process which no longer exists. Nothing
     * on the server can tell it that: the only reliable signal is the host
     * identity changing under a page that is still polling.
     *
     * The second signal covers the very first restart after this feature is
     * installed, when no identity has been recorded yet: a host that STARTED
     * after this page was loaded is by definition not the host that served it.
     * Without it, that first restart would look like a fresh page.
     *
     * @param known - boot id this tab was loaded from (null before the first answer).
     * @param seen - boot id the host reported just now.
     * @param lastReloadAt - ms timestamp of this tab's last automatic reload (0 when none).
     * @param now - current ms timestamp.
     * @param hostStartedAt - ms timestamp the answering host started, when known.
     * @param pageOrigin - ms timestamp this document was loaded (see `performance.timeOrigin`).
     * @returns `adopt` for the first answer, `reload` for a stale page, else `hold`.
     */
    function reloadDecision(known, seen, lastReloadAt, now, hostStartedAt, pageOrigin) {
      if (typeof seen !== 'string' || seen.length === 0) return 'hold'
      var stale = typeof known === 'string' && known.length > 0 && known !== seen
      if (!stale
        && typeof hostStartedAt === 'number' && isFinite(hostStartedAt)
        && typeof pageOrigin === 'number' && isFinite(pageOrigin)
        // Two seconds of slack: a page served by a host that is still starting
        // is a normal load, not a stale one.
        && hostStartedAt > pageOrigin + 2000) {
        stale = true
      }
      if (!stale) return typeof known === 'string' && known.length > 0 ? 'hold' : 'adopt'
      // A guard, not a policy: a host that keeps dying and coming back must not
      // be able to turn this tab into a reload loop.
      if (now - lastReloadAt < RELOAD_GUARD_MS) return 'hold'
      return 'reload'
    }

    /** Collapse the host's status document into the few facts a notice needs. */
    function noticeOf(status) {
      var report = status && status.lastReport ? status.lastReport : null
      var host = status && status.host ? status.host : null
      return {
        at: Date.now(),
        createdAt: report && typeof report.createdAt === 'string' ? report.createdAt : null,
        pid: host && typeof host.pid === 'number' ? host.pid : null,
        status: report && typeof report.status === 'string' ? report.status : 'unknown',
        headline: report && typeof report.headline === 'string' ? report.headline : '',
        durationMs: report && typeof report.durationMs === 'number' ? report.durationMs : null,
        attempts: report && typeof report.attempts === 'number' ? report.attempts : null,
        rolledBack: !!(report && report.rolledBack),
        resumed: report && typeof report.resumed === 'string' ? report.resumed : null,
      }
    }

    /** How each outcome is introduced, and what colour it wears. */
    var NOTICE_LOOK = {
      ok: { title: 'DSH 已重启完成', color: '#22c55e' },
      'rolled-back': { title: 'DSH 已回滚配置并重启', color: '#f59e0b' },
      failed: { title: 'DSH 重启失败', color: '#ef4444' },
      'in-progress': { title: 'DSH 正在重启', color: '#f59e0b' },
      unknown: { title: 'DSH 重启状态未知', color: '#8b8b8b' },
    }

    /** Render one short duration the way a human reads it. */
    function humanDuration(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return ''
      if (ms < 1000) return Math.round(ms) + ' ms'
      var seconds = ms / 1000
      if (seconds < 60) return (Math.round(seconds * 10) / 10) + ' s'
      return Math.floor(seconds / 60) + ' min ' + Math.round(seconds % 60) + ' s'
    }

    /**
     * Announce a finished restart in the corner of the page.
     *
     * This is the half of "tell me it is done" that a toast cannot do: the page
     * is where the user is already looking, and it is the only surface that
     * survives the restart. Imperative DOM on purpose — `react-dom` is not part
     * of the client bundle contract (see the module comment), and a component
     * tree is not worth depending on an internal package for.
     *
     * @param notice - the collapsed status facts.
     * @returns true when a card was drawn.
     */
    function renderNotice(notice) {
      try {
        if (typeof document === 'undefined' || !document.body) return false
        if (notice === null || typeof notice !== 'object') return false
        var existing = document.getElementById(NOTICE_ID)
        if (existing !== null && existing.parentNode !== null) existing.parentNode.removeChild(existing)
        var look = NOTICE_LOOK[notice.status] || NOTICE_LOOK.unknown

        var card = document.createElement('div')
        card.id = NOTICE_ID
        // Polite, not assertive: this is news, not an alarm, and the user may
        // be in the middle of typing into the composer underneath it.
        card.setAttribute('role', 'status')
        card.setAttribute('aria-live', 'polite')
        card.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;'
          + 'max-width:380px;box-sizing:border-box;padding:10px 12px;border-radius:10px;'
          + 'border:1px solid color-mix(in srgb, ' + look.color + ' 45%, transparent);'
          + 'background:var(--dsh-surface, #1c1c1e);color:var(--dsh-text-primary, #ececec);'
          + 'font:12px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;'
          + 'box-shadow:0 10px 30px rgba(0,0,0,.35)'

        var head = document.createElement('div')
        head.style.cssText = 'display:flex;align-items:center;gap:8px;font-weight:600'
        var dot = document.createElement('span')
        dot.setAttribute('aria-hidden', 'true')
        dot.style.cssText = 'width:8px;height:8px;flex:0 0 auto;border-radius:50%;background:' + look.color
        try {
          // The harness theme smooths every rounded corner into a superellipse,
          // so a 50% radius renders as a rounded square unless the shape is
          // declared back to round — the same correction the lamp needs.
          dot.style.setProperty('corner-shape', 'round')
        } catch (error) {
          // A browser without the property simply keeps a normal circle.
        }
        head.appendChild(dot)
        var title = document.createElement('span')
        title.textContent = look.title
        title.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
        head.appendChild(title)

        var close = document.createElement('button')
        close.type = 'button'
        close.textContent = '×'
        close.setAttribute('aria-label', '关闭')
        close.style.cssText = 'flex:0 0 auto;border:0;background:transparent;color:inherit;cursor:pointer;'
          + 'font-size:14px;line-height:1;padding:2px 4px;opacity:.7'
        close.onclick = function () {
          if (card.parentNode !== null) card.parentNode.removeChild(card)
        }
        head.appendChild(close)
        card.appendChild(head)

        var facts = []
        if (typeof notice.pid === 'number') facts.push('pid ' + notice.pid)
        var duration = humanDuration(notice.durationMs)
        if (duration !== '') facts.push('用时 ' + duration)
        if (typeof notice.attempts === 'number' && notice.attempts > 1) facts.push(notice.attempts + ' 次尝试')
        if (notice.rolledBack) facts.push('已回滚配置')
        if (facts.length > 0) {
          var meta = document.createElement('div')
          meta.textContent = facts.join(' · ')
          meta.style.cssText = 'margin-top:4px;opacity:.7'
          card.appendChild(meta)
        }
        if (notice.headline !== '') {
          var headline = document.createElement('div')
          headline.textContent = notice.headline
          headline.style.cssText = 'margin-top:4px;word-break:break-word'
          card.appendChild(headline)
        }
        var resumeLine = document.createElement('div')
        resumeLine.textContent = notice.resumed === 'resumed'
          ? '会话已自动继续，无需再发一条消息。'
          : '浏览器已自动重新连接。'
        resumeLine.style.cssText = 'margin-top:6px;opacity:.7'
        card.appendChild(resumeLine)

        document.body.appendChild(card)
        return true
      } catch (error) {
        // Losing a notice is acceptable; taking the page down is not.
        console.warn('[dsh-restart] could not render the restart notice:', error)
        return false
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
            // A different process is answering this page than the one it was
            // loaded from. Nothing on the server can fix that — the page runs
            // the old shell until it reloads itself, which is the whole reason
            // the host reports its own identity here.
            if (status && status.host && typeof status.host.bootId === 'string') {
              var origin = typeof performance !== 'undefined' && typeof performance.timeOrigin === 'number'
                ? performance.timeOrigin
                : Date.now()
              var decision = reloadDecision(
                readSlot('sessionStorage', HOST_KEY),
                status.host.bootId,
                Number(readSlot('sessionStorage', RELOAD_KEY)) || 0,
                Date.now(),
                Date.parse(status.host.startedAt),
                origin,
              )
              // Adopt either way: without this the reload would land on a page
              // that still remembers the *old* boot id and reload itself again,
              // forever.
              if (decision === 'adopt' || decision === 'reload') {
                writeSlot('sessionStorage', HOST_KEY, status.host.bootId)
              }
              if (decision === 'reload') {
                writeSlot('sessionStorage', NOTICE_KEY, JSON.stringify(noticeOf(status)))
                writeSlot('sessionStorage', RELOAD_KEY, String(Date.now()))
                window.location.reload()
                return
              }
            }
            announceOnce(status)
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

    /**
     * What makes two observations of one restart "the same news".
     *
     * Identity alone is not enough: the supervisor writes a provisional record
     * before it spawns anything and overwrites it in place once the attempt
     * settles — same id, same `createdAt`, different verdict. A page that
     * reloaded into the provisional copy must be allowed to upgrade its card to
     * the settled one, and must not be told the same thing twice.
     *
     * @param notice - one collapsed status document.
     * @returns a stable signature for the browser-wide "already announced" slot.
     */
    function signatureOf(notice) {
      return [
        notice.createdAt === null ? '' : notice.createdAt,
        notice.status,
        notice.headline,
        notice.resumed === null ? '' : notice.resumed,
      ].join('|')
    }

    /**
     * Announce a restart this page has not announced yet.
     *
     * Runs on every probe, which is what makes it cover the case the reload
     * path cannot: a tab that was open across the whole restart (so nothing
     * reloaded it), one opened later by a user who never saw the outcome, or —
     * most commonly — the same tab a few seconds after its own reload, when the
     * supervisor has finally written what actually happened. News older than
     * {@link NOTICE_FRESH_MS} is left alone: opening the app tomorrow should not
     * replay yesterday's restart.
     *
     * @param status - the host's status document.
     */
    function announceOnce(status) {
      try {
        var notice = noticeOf(status)
        if (notice.createdAt === null) return
        var created = Date.parse(notice.createdAt)
        if (!isFinite(created) || Date.now() - created > NOTICE_FRESH_MS) return
        var signature = signatureOf(notice)
        if (readSlot('localStorage', SEEN_KEY) === signature) return
        if (renderNotice(notice)) writeSlot('localStorage', SEEN_KEY, signature)
      } catch (error) {
        console.warn('[dsh-restart] could not announce the restart:', error)
      }
    }

    /**
     * Draw the notice this tab staged for itself immediately before reloading.
     *
     * The staged record exists because the reload destroys every in-memory
     * trace of what was observed: by the time the new page polls, the host it
     * is talking to has always been the current one, and the restart it just
     * lived through is only visible as a report on disk.
     */
    function announcePending() {
      try {
        if (typeof document === 'undefined' || !document.body) {
          // The shell may still be mounting. Retry a few times instead of
          // dropping the staged notice: the probe path would also announce it,
          // but only while the report is still fresh.
          if (pendingAttempts < 10) {
            pendingAttempts += 1
            window.setTimeout(announcePending, 200)
          }
          return
        }
        var raw = readSlot('sessionStorage', NOTICE_KEY)
        if (raw === null) return
        var notice = null
        try {
          notice = JSON.parse(raw)
        } catch (error) {
          dropSlot('sessionStorage', NOTICE_KEY)
          return
        }
        if (!renderNotice(notice)) return
        dropSlot('sessionStorage', NOTICE_KEY)
        if (notice !== null && typeof notice.createdAt === 'string') {
          writeSlot('localStorage', SEEN_KEY, signatureOf(notice))
        }
      } catch (error) {
        console.warn('[dsh-restart] could not draw the staged restart notice:', error)
      }
    }

    function apply(ctx) {
      // Drawn before anything else, and before the `inject` check below: the
      // notice has nothing to do with the sidebar and must appear even on a
      // host that never declares one.
      announcePending()
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
      reloadDecision: reloadDecision,
      noticeOf: noticeOf,
      signatureOf: signatureOf,
      humanDuration: humanDuration,
      renderNotice: renderNotice,
      announceOnce: announceOnce,
      announcePending: announcePending,
      NOTICE_LOOK: NOTICE_LOOK,
      HOST_KEY: HOST_KEY,
      NOTICE_KEY: NOTICE_KEY,
      RELOAD_KEY: RELOAD_KEY,
      SEEN_KEY: SEEN_KEY,
      NOTICE_ID: NOTICE_ID,
      RELOAD_GUARD_MS: RELOAD_GUARD_MS,
      NOTICE_FRESH_MS: NOTICE_FRESH_MS,
    }
    return module.exports
  },
})
