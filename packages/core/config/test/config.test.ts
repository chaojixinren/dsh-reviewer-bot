import { Context, symbols } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { apply, type Config } from '../src/index.ts'
import { TYPERT } from '../src/typert.ts'

/** Minimal settings provider for a Node-only test: one in-memory document. */
function mockSettingsProvider(initial: Config) {
  const document: Config = { ...initial }
  return {
    register() {
      return {
        get: () => ({ ...document }),
        watch: () => () => {},
        update: async (patch: Partial<Config>) => { Object.assign(document, patch) },
      }
    },
  }
}

describe('@dshrb/config settings namespace + browser remote', () => {
  it('resolves config through ctx.dshrb and updates the document', async () => {
    const root = new Context()
    root.provide('settings', mockSettingsProvider({ githubToken: '', gitlabToken: '', allowWrite: false }))
    apply(root, { githubToken: '', gitlabToken: '', allowWrite: false })

    expect(root.get('dshrb')?.get()).toEqual({ githubToken: '', gitlabToken: '', allowWrite: false })

    await root.dshrb.update({ githubToken: 'ghp_x', allowWrite: true })
    expect(root.dshrb.get()).toEqual({ githubToken: 'ghp_x', gitlabToken: '', allowWrite: true })
  })

  it('exposes a redacted getConfig and a write setConfig through the remote', async () => {
    const root = new Context()
    root.provide('settings', mockSettingsProvider({ githubToken: 'ghp_secret', gitlabToken: '', allowWrite: false }))
    apply(root, { githubToken: 'ghp_secret', gitlabToken: '', allowWrite: false })

    const gateway = root.get('dshrbRemote')
    expect(gateway).toBeDefined()

    // getConfig never leaks the secret value.
    expect(gateway.getConfig()).toEqual({
      allowWrite: false,
      githubTokenConfigured: true,
      gitlabTokenConfigured: false,
    })

    const result = await gateway.setConfig({ gitlabToken: 'glpat_y', allowWrite: true })
    expect(result).toEqual({ ok: true })

    expect(root.dshrb.get()).toEqual({ githubToken: 'ghp_secret', gitlabToken: 'glpat_y', allowWrite: true })
    expect(gateway.getConfig()).toEqual({
      allowWrite: true,
      githubTokenConfigured: true,
      gitlabTokenConfigured: true,
    })
  })

  it('carries a Typert binding the api-gateway validates', () => {
    const root = new Context()
    root.provide('settings', mockSettingsProvider({ githubToken: '', gitlabToken: '', allowWrite: false }))
    apply(root, { githubToken: '', gitlabToken: '', allowWrite: false })

    const receiver = root.get('dshrbRemote')
    const original = Reflect.get(receiver, symbols.original) ?? receiver
    const binding = receiver.typertRemote

    // readBinding(receiver, 'dshrbRemote', 'dshrb', endpoint) must pass:
    expect(binding.service).toBe(original)
    expect(binding.serviceKey).toBe('dshrbRemote')
    expect(binding.namespace).toBe('dshrb')

    // collectSrcClaims discovers both endpoints from the @Remote markers.
    const methods = remoteMethods(original)
    expect(methods.map(m => m.exportName ?? m.method).sort()).toEqual(['getConfig', 'setConfig'])
  })

  it('declares the two invocations under the dshrb wire namespace', () => {
    expect(TYPERT.face).toBe('host')
    expect(TYPERT.invocations).toHaveLength(2)
    const byMethod = new Map(TYPERT.invocations.map(i => [i.method, i]))
    for (const method of ['getConfig', 'setConfig']) {
      const invocation = byMethod.get(method)
      expect(invocation?.service).toBe('dshrbRemote')
      expect(invocation?.namespace).toBe('dshrb')
      expect(invocation?.invocation).toEqual({ kind: 'direct' })
    }
  })
})
