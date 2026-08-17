import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { DockerSandboxProvider } from '../src/docker-sandbox.ts'

const DIGEST = 'a'.repeat(64)
const IMAGE = `ghcr.io/owner/repo@sha256:${DIGEST}`

function provider(image = IMAGE): DockerSandboxProvider {
  const p = new DockerSandboxProvider(new Context(), { image, dockerCommand: '/usr/bin/docker' })
  // The host may be any OS; the Docker provider itself is Linux-only, so pin
  // the platform gate to exercise the argv construction deterministically.
  p.internals.platform = 'linux'
  return p
}

describe('DockerSandboxProvider', () => {
  it('wraps the exact argv in a docker run invocation with the workspace bind-mounted', () => {
    const confined = provider().confine(['npm', 'test'], { mode: 'workspace-write', workspaceRoot: '/work' })
    expect(confined.argv).toEqual([
      '/usr/bin/docker', 'run', '--rm', '--init', '-w', '/work', '-v', '/work:/work', IMAGE, 'npm', 'test',
    ])
    expect(confined.enforcement).toBe('full')
  })

  it('marks the workspace mount read-only under a read-only policy', () => {
    const confined = provider().confine(['npm', 'test'], { mode: 'read-only', workspaceRoot: '/work' })
    expect(confined.argv).toContain('/work:/work:ro')
  })

  it('fails closed on an image without a complete digest', () => {
    expect(() => provider('ghcr.io/owner/repo:latest').confine(['npm', 'test'], { mode: 'workspace-write', workspaceRoot: '/work' }))
      .toThrow(SandboxUnavailableError)
  })

  it('fails closed on a workspace root with bind-mount-ambiguous characters', () => {
    expect(() => provider().confine(['npm', 'test'], { mode: 'workspace-write', workspaceRoot: '/wo:rk' }))
      .toThrow(SandboxUnavailableError)
  })

  it('reports denial and runner-failure evidence for downstream classification', () => {
    const confined = provider().confine(['npm', 'test'], { mode: 'workspace-write', workspaceRoot: '/work' })
    expect(confined.denialSignatures.length).toBeGreaterThan(0)
    expect(confined.runnerFailureRules.length).toBeGreaterThan(0)
    expect(confined.runnerFailureRules[0]?.fatalSignatures).toContain('Cannot connect to the Docker daemon')
    expect(confined.runnerFailureRules[0]?.fatalSignatures).toContain('Error response from daemon')
  })

  it('is Linux-only', () => {
    const p = provider()
    p.internals.platform = 'win32'
    expect(() => p.confine(['npm', 'test'], { mode: 'workspace-write', workspaceRoot: '/work' }))
      .toThrow(SandboxUnavailableError)
  })
})
