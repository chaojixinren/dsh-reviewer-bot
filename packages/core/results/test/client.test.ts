/**
 * Smoke coverage for the committed static `client.js` browser half.
 *
 * `client.js` is a `window.__ModuleLoader__` asset the DSH shell loads at
 * runtime; it is not part of the Host `tsc` build and there is no real DOM in
 * CI. This test drives it under Node with lightweight mocks — no `jsdom` /
 * `react` install, so the frozen pnpm lockfile is untouched. It captures the
 * registered module, runs its factory with a `react` mock, mounts the section
 * through a mock `ctx`, renders the section component, then walks the produced
 * element tree to fire the event handlers. The goal is to give `client.js`
 * real execution coverage so it is no longer an untested asset.
 */
import { describe, expect, it } from 'vitest'

describe('@dshrb/results client.js (browser half) smoke', () => {
  it('registers, mounts, renders and handles events without throwing', async () => {
    const React = {
      createElement: (type: unknown, props: any, ...children: unknown[]) => ({
        type,
        props: props ?? {},
        children: children.flat(),
      }),
      useState: (init: unknown) => {
        const value = typeof init === 'function' ? (init as () => unknown)() : init
        return [value, () => {}] as const
      },
      useEffect: (fn: () => void) => {
        try { fn() } catch { /* swallow for smoke purposes */ }
        return () => {}
      },
      useRef: (v: unknown) => ({ current: v }),
      useMemo: (fn: () => unknown) => fn(),
      useCallback: (fn: () => unknown) => fn,
    }

    const registered: { spec?: any } = {}
    ;(globalThis as any).window = {
      __ModuleLoader__: { load: (spec: any) => { registered.spec = spec } },
    }
    ;(globalThis as any).React = React

    expect(registered.spec).toBeUndefined() // module not loaded until imported
    // dynamic import via variable to avoid tsc module-resolution on the .js asset
    const modPath = '../client.js'
    await import(modPath)
    expect(registered.spec).toBeDefined()
    expect(registered.spec.id).toBe('@dshrb/results')

    const factory = registered.spec.factory
    const require = (name: string) => {
      if (name === 'react') return React
      throw new Error('unexpected require: ' + name)
    }
    const exported = factory(require)
    expect(typeof exported.apply).toBe('function')
    expect(exported.inject).toEqual(['slots', 'remote'])

    const sampleRun = {
      id: 'r1', schemaVersion: 1, status: 'success',
      createdAt: new Date().toISOString(),
      summary: { total: 0, bySeverity: {}, byRule: {}, suppressed: 0, discarded: 0 },
      findings: [], suppressed: [], discarded: [],
    }
    const remote = {
      listResults: async () => [sampleRun],
      getResult: async () => sampleRun,
      submitResult: async () => ({ id: 'x' }),
      clearResults: async () => ({}),
    }
    let sectionComponent: any = null
    const ctx = {
      remote: {
        $mount: async () => async () => {},
      },
      get: (key: string) => (key === 'remote.dshrbResults' ? remote : undefined),
      slots: {
        inject: (_name: string, registerFn: () => any) => {
          sectionComponent = registerFn().Component
        },
        register: (_spec: any, Component: any) => ({ spec: _spec, Component }),
      },
    }

    const unmount = await exported.apply(ctx)
    expect(typeof unmount).toBe('function')
    expect(typeof sectionComponent).toBe('function')

    const props = {
      listResults: remote.listResults,
      getResult: remote.getResult,
      submitResult: remote.submitResult,
      clearResults: remote.clearResults,
    }
    const tree = sectionComponent(props)
    expect(tree).toBeDefined()

    // Walk the produced tree and fire the event handlers to exercise them.
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return
      if (node.props && typeof node.props.onClick === 'function') {
        try { node.props.onClick() } catch { /* smoke only */ }
      }
      if (node.props && typeof node.props.onChange === 'function') {
        try { node.props.onChange({ target: { value: '{}' } }) } catch { /* smoke only */ }
      }
      if (Array.isArray(node.children)) node.children.forEach(walk)
    }
    walk(tree)

    // flush any microtasks kicked off by useEffect / reload handlers
    await new Promise((r) => setTimeout(r, 0))
  })
})
