import { describe, expect, it } from 'vitest'
import { createForgeRegistry } from '../src/index.ts'
import type { ForgeCapability, ForgeGateway, ForgeId } from '../src/index.ts'

/**
 * Smoke test for the one piece of the scaffolding that has real behavior today:
 * the forge provider registry. It is intentionally dependency-free, so it can
 * be tested without a network, a forge token, or a DSH runtime.
 */

function gateway(id: string, capabilities: readonly ForgeCapability[]): ForgeGateway {
  return { id: id as ForgeId, capabilities }
}

describe('createForgeRegistry', () => {
  it('resolves a registered provider and unregisters on dispose', () => {
    const registry = createForgeRegistry()
    const github = gateway('github', ['diff-source'])
    const dispose = registry.register(github)

    expect(registry.resolve('github' as ForgeId)).toBe(github)

    dispose()
    expect(registry.resolve('github' as ForgeId)).toBeUndefined()
  })

  it('throws listing missing capabilities instead of failing mid-pipeline', () => {
    const registry = createForgeRegistry()
    registry.register(gateway('github', ['diff-source', 'comment-sink']))

    expect(() => registry.require('github' as ForgeId, ['mutation-sink']))
      .toThrow(/mutation-sink/)
  })

  it('throws when no provider is registered for an id', () => {
    const registry = createForgeRegistry()
    expect(() => registry.require('missing' as ForgeId, []))
      .toThrow(/no forge provider/)
  })
})
