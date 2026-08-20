/**
 * Browser half of @dshrb/results: registers the "DSH Reviewer · Results"
 * settings section and renders the review result-json analytics (KPIs,
 * severity / rule bars, a filterable findings table, and the suppressed /
 * discarded / failure detail) backed by the `ctx.remote.dshrbResults` Typert
 * Remote (see `src/typert.ts` + `src/index.ts`).
 *
 * This file is a committed static asset in the `window.__ModuleLoader__` format
 * the DSH web shell loads; it is not compiled by the repo's Host `tsc` build.
 * `react` is resolved by the shell's module loader at runtime.
 *
 * The Host is the source of truth for parsing: `submitResult` sends a raw
 * `result-json` and the Host returns a normalized `ReviewRun`, so this file
 * only ever renders already-clean data. It mirrors the "DSH Reviewer" settings
 * section added in PR #79.
 */
window.__ModuleLoader__.load({
  id: '@dshrb/results',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var inject = ['slots', 'remote']

    function unwrap(result, method) {
      if (!result || result.ok !== true) {
        var detail = result && result.error ? result.error.code + ': ' + result.error.message : String(result)
        throw new Error('dshrb-results.' + method + ' failed: ' + detail)
      }
      return result.value
    }

    // Client Remote contribution. The shell builds `remote.<namespace>` services
    // from a `TYPERT_REMOTE` contribution (`descriptors`); first-party DSH
    // packages inline theirs into `@deepseek-ai/dsh-api-remotes`. A third-party
    // bundle must mount its own contribution via `ctx.remote.$mount(...)`.
    // Schemas are strict-mode but pass-through: the Host gateway validates args
    // and encodes results, so the client only needs a callable `.parse`.
    var passthrough = { parse: function (value) { return value } }

    var TYPERT_REMOTE = {
      package: '@dshrb/results',
      descriptors: [
        {
          id: '@dshrb/results#dshrbResults/listResults',
          service: 'dshrbResultsRemote',
          namespace: 'dshrbResults',
          method: 'listResults',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'strict', typeSymbol: '@dshrb/results/types#ReviewRunSummary[]', schema: passthrough },
        },
        {
          id: '@dshrb/results#dshrbResults/getResult',
          service: 'dshrbResultsRemote',
          namespace: 'dshrbResults',
          method: 'getResult',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'id', wire: 'id', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: passthrough } },
          ],
          result: { mode: 'strict', typeSymbol: '@dshrb/results/types#ReviewRun', schema: passthrough },
        },
        {
          id: '@dshrb/results#dshrbResults/submitResult',
          service: 'dshrbResultsRemote',
          namespace: 'dshrbResults',
          method: 'submitResult',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'envelope', wire: 'envelope', source: 'json', codec: { mode: 'strict', typeSymbol: '@dshrb/results/types#ResultEnvelope', schema: passthrough } },
          ],
          result: { mode: 'strict', typeSymbol: '@dshrb/results/types#SubmitResult', schema: passthrough },
        },
        {
          id: '@dshrb/results#dshrbResults/clearResults',
          service: 'dshrbResultsRemote',
          namespace: 'dshrbResults',
          method: 'clearResults',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'id', wire: 'id', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: passthrough } },
          ],
          result: { mode: 'strict', typeSymbol: '@dshrb/results/types#ClearResult', schema: passthrough },
        },
      ],
    }

    async function apply(ctx) {
      var unmount = await ctx.remote.$mount(TYPERT_REMOTE)
      var remote = ctx.get('remote.dshrbResults')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dshrb-results',
        order: 26,
        label: 'DSH Reviewer · Results',
        inject: () => ({
          listResults: () => remote.listResults().then(function (r) { return unwrap(r, 'listResults') }),
          getResult: (id) => remote.getResult(id).then(function (r) { return unwrap(r, 'getResult') }),
          submitResult: (envelope) => remote.submitResult(envelope).then(function (r) { return unwrap(r, 'submitResult') }),
          clearResults: (id) => remote.clearResults(id).then(function (r) { return unwrap(r, 'clearResults') }),
        }),
      }, DshrbResultsSection))

      return async () => { await unmount() }
    }

    // --- styling (mirrors the "DSH Reviewer" settings section) -------------
    var label = { fontSize: '13px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)' }
    var hint = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }
    var input = {
      width: '100%', minHeight: '120px', padding: '8px 10px',
      borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
      fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', resize: 'vertical',
    }
    var code = {
      fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      color: 'var(--dsw-alias-label-secondary)',
    }
    var button = {
      height: '32px', padding: '0 14px', borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px', cursor: 'pointer',
    }
    var message = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }

    var SEVERITY_ORDER = ['blocker', 'major', 'minor', 'nit', 'info']
    var SEVERITY_COLOR = {
      blocker: '#b71c1c',
      major: '#e65100',
      minor: '#f9a825',
      nit: '#1565c0',
      info: '#546e7a',
    }

    function badge(text, color) {
      return React.createElement('span', {
        style: {
          display: 'inline-block', padding: '1px 8px', borderRadius: '10px',
          fontSize: '11px', fontWeight: '600', color: '#fff', background: color,
        },
      }, text)
    }

    function statusBadge(status) {
      var color = status === 'success' ? '#2e7d32' : status === 'failed' ? '#c62828' : '#546e7a'
      return badge(status, color)
    }

    // A horizontal stacked bar from { label: count } sized relative to total.
    function Bar(segments) {
      var total = segments.reduce(function (s, x) { return s + x.count }, 0)
      if (total === 0) return null
      return React.createElement('div', {
        style: { display: 'flex', height: '14px', borderRadius: '4px', overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-2)' },
      }, segments.filter(function (s) { return s.count > 0 }).map(function (s, i) {
        return React.createElement('div', {
          key: i,
          title: s.label + ': ' + s.count,
          style: { width: (100 * s.count / total) + '%', background: s.color },
        })
      }))
    }

    function Kpi(_ref) {
      var k = _ref.k
      return React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '92px', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)' },
      },
        React.createElement('span', { style: hint }, k.label),
        React.createElement('span', { style: { fontSize: '18px', fontWeight: '700', color: 'var(--dsw-alias-label-primary)' } }, String(k.value)),
      )
    }

    function FindingsTable(findings) {
      if (!findings || findings.length === 0) {
        return React.createElement('div', { style: hint }, 'No findings.')
      }
      return React.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', overflow: 'hidden' } },
        React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } },
          React.createElement('thead', null, React.createElement('tr', { style: { background: 'var(--dsw-alias-bg-layer-2)' } },
            ['Sev', 'Rule', 'Title', 'Location'].map(function (h) {
              return React.createElement('th', { key: h, style: { textAlign: 'left', padding: '6px 8px', color: 'var(--dsw-alias-label-secondary)', fontWeight: '600' } }, h)
            }),
          )),
          React.createElement('tbody', null, findings.map(function (f, i) {
            return React.createElement('tr', { key: i, style: { borderTop: '1px solid var(--dsw-alias-border-l2)' } },
              React.createElement('td', { style: { padding: '6px 8px' } }, badge(f.severity, SEVERITY_COLOR[f.severity] || '#546e7a')),
              React.createElement('td', { style: { padding: '6px 8px', ...code } }, f.ruleId || '—'),
              React.createElement('td', { style: { padding: '6px 8px', color: 'var(--dsw-alias-label-primary)' } }, f.title),
              React.createElement('td', { style: { padding: '6px 8px', ...code } }, f.path ? (f.path + (f.line ? ':' + f.line : '')) : '—'),
            )
          })),
        ),
      )
    }

    function DshrbResultsSection(props) {
      var listResults = props.listResults
      var getResult = props.getResult
      var submitResult = props.submitResult
      var clearResults = props.clearResults

      var runsState = React.useState([])
      var runs = runsState[0]
      var setRuns = runsState[1]
      var selectedState = React.useState(null)
      var selected = selectedState[0]
      var setSelected = selectedState[1]
      var detailState = React.useState(null)
      var detail = detailState[0]
      var setDetail = detailState[1]
      var textState = React.useState('')
      var text = textState[0]
      var setText = textState[1]
      var sevFilterState = React.useState('all')
      var sevFilter = sevFilterState[0]
      var setSevFilter = sevFilterState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var msgState = React.useState('')
      var msg = msgState[0]
      var setMsg = msgState[1]

      function reload() {
        return listResults().then(function (list) {
          setRuns(list)
          if (selected && !list.some(function (r) { return r.id === selected })) {
            setSelected(null)
            setDetail(null)
          }
        }, function (error) {
          setMsg(String(error && error.message || error))
        })
      }

      React.useEffect(function () {
        var cancelled = false
        reload().then(function () { if (cancelled) return }, function () {})
        return function () { cancelled = true }
      }, [])

      function selectRun(id) {
        setSelected(id)
        setSevFilter('all')
        setBusy(true)
        getResult(id).then(function (run) {
          setDetail(run)
        }, function (error) {
          setMsg(String(error && error.message || error))
          setDetail(null)
        }).then(function () { setBusy(false) })
      }

      function onLoad() {
        if (text.trim() === '') { setMsg('Paste a result-json first.'); return }
        var parsed
        try { parsed = JSON.parse(text) } catch (e) { setMsg('Invalid JSON: ' + e.message); return }
        setBusy(true)
        setMsg('')
        submitResult(parsed).then(function (res) {
          setText('')
          return reload().then(function () { selectRun(res.id) })
        }, function (error) {
          setMsg(String(error && error.message || error))
        }).then(function () { setBusy(false) })
      }

      function onClearOne() {
        if (!selected) return
        setBusy(true)
        clearResults(selected).then(function () {
          setSelected(null); setDetail(null)
          return reload()
        }, function (error) { setMsg(String(error && error.message || error)) }).then(function () { setBusy(false) })
      }

      function onClearAll() {
        setBusy(true)
        clearResults(undefined).then(function () {
          setSelected(null); setDetail(null)
          return reload()
        }, function (error) { setMsg(String(error && error.message || error)) }).then(function () { setBusy(false) })
      }

      var visibleFindings = detail
        ? (sevFilter === 'all' ? detail.findings : detail.findings.filter(function (f) { return f.severity === sevFilter }))
        : []

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 2px' } },
        // Load box
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          React.createElement('label', { style: label }, 'Load a result-json'),
          React.createElement('textarea', {
            style: input, value: text, placeholder: 'Paste the result-json envelope (from the CI dsh-result-json artifact)…',
            spellCheck: false, onChange: function (e) { setText(e.target.value) },
          }),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            React.createElement('button', { style: button, disabled: busy, onClick: onLoad }, busy ? 'Loading…' : 'Load result-json'),
            React.createElement('button', { style: button, disabled: busy || runs.length === 0, onClick: onClearAll }, 'Clear all'),
            msg ? React.createElement('span', { style: message }, msg) : null,
          ),
          React.createElement('span', { style: hint }, 'The Host normalizes and stores the run in memory; nothing leaves this process.'),
        ),

        // Two-pane: list + detail
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: '16px', alignItems: 'start' } },
          // Run list
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            runs.length === 0
              ? React.createElement('div', { style: hint }, 'No runs loaded yet.')
              : runs.map(function (r) {
                  var active = r.id === selected
                  return React.createElement('div', {
                    key: r.id, onClick: function () { selectRun(r.id) },
                    style: {
                      display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px 10px', borderRadius: '6px',
                      cursor: 'pointer', border: '1px solid ' + (active ? 'var(--dsw-alias-border-strong)' : 'var(--dsw-alias-border-l2)'),
                      background: active ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-bg-layer-1)',
                    },
                  },
                    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
                      statusBadge(r.status),
                      React.createElement('span', { style: { ...code, fontSize: '11px' } }, new Date(r.createdAt).toLocaleString()),
                    ),
                    React.createElement('div', { style: { ...code } },
                      r.total + ' findings · ' + r.blockers + ' blockers · ' + r.suppressed + ' suppressed · ' + r.discarded + ' discarded'),
                    r.failureCode ? React.createElement('div', { style: { ...code, color: '#c62828' } }, 'failure: ' + r.failureCode) : null,
                  )
                }),
          ),

          // Detail
          detail
            ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
                  statusBadge(detail.status),
                  detail.trustLevel ? badge('trust:' + detail.trustLevel, '#6a1b9a') : null,
                  detail.write ? badge('write', '#2e7d32') : badge('read-only', '#546e7a'),
                  detail.replay ? React.createElement('span', { style: code }, 'replay ' + detail.replay) : null,
                  React.createElement('button', { style: button, disabled: busy, onClick: onClearOne }, 'Clear this run'),
                ),
                React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                  React.createElement(Kpi, { k: { label: 'Findings', value: detail.summary.total } }),
                  React.createElement(Kpi, { k: { label: 'Blockers', value: detail.summary.bySeverity.blocker || 0 } }),
                  React.createElement(Kpi, { k: { label: 'Suppressed', value: detail.summary.suppressed } }),
                  React.createElement(Kpi, { k: { label: 'Discarded', value: detail.summary.discarded } }),
                ),
                // Severity bar
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  React.createElement('span', { style: label }, 'Severity'),
                  Bar(SEVERITY_ORDER.map(function (s) {
                    return { label: s, count: detail.summary.bySeverity[s] || 0, color: SEVERITY_COLOR[s] }
                  })),
                  React.createElement('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', ...code } },
                    SEVERITY_ORDER.map(function (s) {
                      return React.createElement('span', { key: s }, s + ': ' + (detail.summary.bySeverity[s] || 0))
                    }),
                  ),
                ),
                // Rule bar
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  React.createElement('span', { style: label }, 'Rules'),
                  Bar(Object.keys(detail.summary.byRule).sort().map(function (rule) {
                    return { label: rule, count: detail.summary.byRule[rule], color: '#3949ab' }
                  })),
                ),
                // Findings filter + table
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                  React.createElement('span', { style: hint }, 'Filter:'),
                  ['all'].concat(SEVERITY_ORDER).map(function (s) {
                    var active = sevFilter === s
                    return React.createElement('button', {
                      key: s, onClick: function () { setSevFilter(s) },
                      style: {
                        height: '26px', padding: '0 10px', borderRadius: '13px', cursor: 'pointer', fontSize: '12px',
                        border: '1px solid ' + (active ? 'var(--dsw-alias-border-strong)' : 'var(--dsw-alias-border-l2)'),
                        background: active ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-bg-layer-1)',
                        color: 'var(--dsw-alias-label-primary)',
                      },
                    }, s === 'all' ? 'all (' + detail.findings.length + ')' : s)
                  }),
                ),
                FindingsTable(visibleFindings),
                // Suppressed
                detail.suppressed.length > 0
                  ? React.createElement('details', null,
                      React.createElement('summary', { style: { cursor: 'pointer', ...label } }, 'Suppressed (' + detail.suppressed.length + ')'),
                      React.createElement('div', { style: { marginTop: '6px' } }, FindingsTable(detail.suppressed)),
                    )
                  : null,
                // Discarded
                detail.discarded.length > 0
                  ? React.createElement('details', null,
                      React.createElement('summary', { style: { cursor: 'pointer', ...label } }, 'Discarded (' + detail.discarded.length + ')'),
                      React.createElement('div', { style: { marginTop: '6px' } }, FindingsTable(detail.discarded)),
                    )
                  : null,
                // Failure
                detail.failure
                  ? React.createElement('div', { style: { padding: '10px 12px', borderRadius: '6px', border: '1px solid #c62828', background: 'var(--dsw-alias-bg-layer-1)' } },
                      React.createElement('div', { style: { fontWeight: '600', color: '#c62828' } }, 'Failure · ' + detail.failure.phase + ' · ' + detail.failure.code),
                      React.createElement('div', { style: { marginTop: '4px', ...code } }, detail.failure.title + (detail.failure.message ? ' — ' + detail.failure.message : '')),
                      detail.failure.guidance ? React.createElement('div', { style: { marginTop: '4px', ...hint } }, detail.failure.guidance) : null,
                    )
                  : null,
              )
            : React.createElement('div', { style: hint }, 'Select a run on the left to see its details.'),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
