/**
 * Browser half of @dshrb/config: registers the "DSH Reviewer" settings section
 * and renders a token / write-toggle form backed by the `ctx.remote.dshrb`
 * Typert Remote (see `src/typert.ts` + `src/index.ts`).
 *
 * This file is a committed static asset in the `window.__ModuleLoader__`
 * format the DSH web shell loads; it is not compiled by the repo's Host
 * `tsc` build. `react` is resolved by the shell's module loader at runtime.
 */
window.__ModuleLoader__.load({
  id: '@dshrb/config',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var inject = ['slots', 'remote']

    function unwrap(result, method) {
      if (!result || result.ok !== true) {
        var detail = result && result.error ? result.error.code + ': ' + result.error.message : String(result)
        throw new Error('dshrb.' + method + ' failed: ' + detail)
      }
      return result.value
    }

    // Client Remote contribution. The shell builds `remote.<namespace>`
    // services from a `TYPERT_REMOTE` contribution (`descriptors`), NOT from
    // the host `./typert` manifest. First-party DSH packages inline theirs
    // into `@deepseek-ai/dsh-api-remotes`; a third-party bundle must mount its
    // own contribution via `ctx.remote.$mount(...)`. Schemas are strict-mode
    // but pass-through: the Host gateway validates args and encodes results,
    // so the client only needs a callable `.parse`.
    var passthrough = { parse: function (value) { return value } }

    var TYPERT_REMOTE = {
      package: '@dshrb/config',
      descriptors: [
        {
          id: '@dshrb/config#dshrb/getConfig',
          service: 'dshrbRemote',
          namespace: 'dshrb',
          method: 'getConfig',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'strict', typeSymbol: '@dshrb/config/types#ClientConfig', schema: passthrough },
        },
        {
          id: '@dshrb/config#dshrb/setConfig',
          service: 'dshrbRemote',
          namespace: 'dshrb',
          method: 'setConfig',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'patch', wire: 'patch', source: 'json', codec: { mode: 'strict', typeSymbol: '@dshrb/config/types#ConfigPatch', schema: passthrough } },
          ],
          result: { mode: 'strict', typeSymbol: '@dshrb/config/types#SetResult', schema: passthrough },
        },
      ],
    }

    async function apply(ctx) {
      // Mount the `remote.dshrb` contribution first: `$mount` resolves once
      // the namespace service (and its getConfig/setConfig methods) exists, so
      // we must not inject `remote.dshrb` as a hard dependency (it is produced
      // by this very mount).
      var unmount = await ctx.remote.$mount(TYPERT_REMOTE)
      var remoteDshrb = ctx.get('remote.dshrb')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dshrb',
        order: 25,
        label: 'DSH Reviewer',
        inject: () => ({
          getConfig: () => remoteDshrb.getConfig().then((r) => unwrap(r, 'getConfig')),
          setConfig: (patch) => remoteDshrb.setConfig(patch).then((r) => unwrap(r, 'setConfig')),
        }),
      }, DshrbSettingsSection))

      return async () => { await unmount() }
    }

    var field = { display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '560px' }
    var label = { fontSize: '13px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)' }
    var hint = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }
    var input = {
      height: '34px',
      padding: '0 10px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px',
    }
    var button = {
      height: '34px',
      padding: '0 14px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-3)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px',
      cursor: 'pointer',
    }
    var row = { display: 'flex', alignItems: 'center', gap: '8px' }
    var message = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }

    function DshrbSettingsSection(props) {
      var getConfig = props.getConfig
      var setConfig = props.setConfig

      var github = React.useState('')
      var githubToken = github[0]
      var setGithubToken = github[1]
      var gitlab = React.useState('')
      var gitlabToken = gitlab[0]
      var setGitlabToken = gitlab[1]
      var writeState = React.useState(false)
      var allowWrite = writeState[0]
      var setAllowWrite = writeState[1]
      var githubConfiguredState = React.useState(false)
      var githubConfigured = githubConfiguredState[0]
      var setGithubConfigured = githubConfiguredState[1]
      var gitlabConfiguredState = React.useState(false)
      var gitlabConfigured = gitlabConfiguredState[0]
      var setGitlabConfigured = gitlabConfiguredState[1]
      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]
      var messageState = React.useState('')
      var messageText = messageState[0]
      var setMessageText = messageState[1]

      React.useEffect(function () {
        var cancelled = false
        getConfig().then(function (config) {
          if (cancelled) return
          setAllowWrite(config.allowWrite)
          setGithubConfigured(config.githubTokenConfigured)
          setGitlabConfigured(config.gitlabTokenConfigured)
        }, function (error) {
          if (!cancelled) setMessageText(String(error && error.message || error))
        })
        return function () { cancelled = true }
      }, [getConfig])

      function refreshBadges() {
        return getConfig().then(function (config) {
          setGithubConfigured(config.githubTokenConfigured)
          setGitlabConfigured(config.gitlabTokenConfigured)
        }, function () {
          // Best-effort re-read: the primary write result is already reflected
          // in the message, and a failed badge refresh is not user-actionable.
        })
      }

      function onSave() {
        var patch = { allowWrite: allowWrite }
        if (githubToken !== '') patch.githubToken = githubToken
        if (gitlabToken !== '') patch.gitlabToken = gitlabToken
        setSaving(true)
        setMessageText('')
        setConfig(patch).then(function () {
          setGithubToken('')
          setGitlabToken('')
          setMessageText('Saved')
          return refreshBadges()
        }, function (error) {
          setMessageText(String(error && error.message || error))
        }).then(function () {
          setSaving(false)
        })
      }

      function onClear(field) {
        var patch = { allowWrite: allowWrite }
        patch[field] = ''
        setSaving(true)
        setMessageText('')
        setConfig(patch).then(function () {
          setMessageText('Cleared')
          return refreshBadges()
        }, function (error) {
          setMessageText(String(error && error.message || error))
        }).then(function () {
          setSaving(false)
        })
      }

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 2px' } },
        React.createElement('div', { style: field },
          React.createElement('label', { style: label, htmlFor: 'dshrb-github-token' }, 'GitHub token'),
          React.createElement('input', {
            id: 'dshrb-github-token',
            type: 'password',
            style: input,
            value: githubToken,
            placeholder: githubConfigured ? 'Configured (leave blank to keep)' : 'Paste a fine-grained PAT',
            autoComplete: 'off',
            spellCheck: false,
            onChange: function (event) { setGithubToken(event.target.value) },
          }),
          React.createElement('span', { style: hint }, 'Sent as a Bearer token to api.github.com. Secret: never read back, only written.'),
        ),
        React.createElement('div', { style: field },
          React.createElement('label', { style: label, htmlFor: 'dshrb-gitlab-token' }, 'GitLab token'),
          React.createElement('input', {
            id: 'dshrb-gitlab-token',
            type: 'password',
            style: input,
            value: gitlabToken,
            placeholder: gitlabConfigured ? 'Configured (leave blank to keep)' : 'Paste a personal access token',
            autoComplete: 'off',
            spellCheck: false,
            onChange: function (event) { setGitlabToken(event.target.value) },
          }),
          React.createElement('span', { style: hint }, 'Sent as the PRIVATE-TOKEN header to gitlab.com.'),
        ),
        React.createElement('div', { style: field },
          React.createElement('label', { style: label, htmlFor: 'dshrb-allow-write' }, 'Allow write'),
          React.createElement('div', { style: row },
            React.createElement('input', {
              id: 'dshrb-allow-write',
              type: 'checkbox',
              checked: allowWrite,
              onChange: function (event) { setAllowWrite(event.target.checked) },
            }),
            React.createElement('span', { style: hint }, 'Let the reviewer post comments and propose changes. Fail-closed by default.'),
          ),
        ),
        React.createElement('div', { style: row },
          React.createElement('button', { style: button, disabled: saving, onClick: onSave }, saving ? 'Saving…' : 'Save'),
          React.createElement('button', { style: button, disabled: saving, onClick: function () { onClear('githubToken') } }, 'Clear GitHub'),
          React.createElement('button', { style: button, disabled: saving, onClick: function () { onClear('gitlabToken') } }, 'Clear GitLab'),
          messageText ? React.createElement('span', { style: message }, messageText) : null,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
