#!/usr/bin/env node
/**
 * Real-Docker end-to-end test for `DockerSandboxProvider` (issue #66).
 *
 * Verifies the confinement semantics the standalone Action relies on for
 * write-mode validation:
 *   1. `workspace-write` — a write under the workspace is visible on the host
 *      (the bind-mount is read-write).
 *   2. `read-only` — a write under the workspace is denied with a sandbox
 *      denial signature (EROFS / EACCES).
 *   3. Isolation — a write to a container path OUTSIDE the workspace does not
 *      leak to the host filesystem.
 *   4. Fail-closed — an image without a complete digest is refused.
 *
 * Requirements: a running Docker daemon and a Linux host (or WSL). The provider
 * is Linux-only by design, and its `-v host:container` mount assumes POSIX
 * paths, so this script targets Linux paths; it only bypasses the platform gate
 * for the offline unit tests, not here.
 *
 * Build the repo first so `lib/` exists:
 *   pnpm run typecheck
 *
 * Usage:
 *   node scripts/e2e-docker-sandbox.mjs
 *   IMAGE="node:24-bookworm-slim@sha256:<64 hex>" node scripts/e2e-docker-sandbox.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { DockerSandboxProvider } from '../packages/core/runtime-bootstrap/lib/docker-sandbox.js'

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name} -> ${error instanceof Error ? error.message : error}`)
  }
}

/** Builds the local isolation image (or uses IMAGE) and returns a digest-pinned reference. */
function resolveImage() {
  if (process.env.IMAGE) {
    if (!/@sha256:[0-9a-f]{64}$/i.test(process.env.IMAGE)) {
      throw new Error(`IMAGE must be digest-pinned (@sha256:<64 hex>), got: ${process.env.IMAGE}`)
    }
    return process.env.IMAGE
  }
  const tag = 'dshrb-sandbox-e2e:local'
  console.log('building docker/Dockerfile ...')
  execFileSync('docker', ['build', '-t', tag, '-f', 'docker/Dockerfile', 'docker'], { stdio: 'inherit' })
  const id = execFileSync('docker', ['inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' }).trim()
  const digest = id.replace(/^sha256:/i, '')
  return `dshrb-sandbox-e2e@sha256:${digest}`
}

const image = resolveImage()
console.log(`using image: ${image}`)

const workspace = mkdtempSync(join(tmpdir(), 'dshrb-e2e-'))
const provider = new DockerSandboxProvider(new Context(), { image })

/** confine(argv) then spawn it, returning the synchronous result. */
function run(argv, mode) {
  const confined = provider.confine(argv, { mode, workspaceRoot: workspace })
  const [program, ...args] = confined.argv
  return spawnSync(program, args, { encoding: 'utf8' })
}

check('workspace-write: a workspace write is visible on the host', () => {
  const out = join(workspace, 'out.txt')
  const r = run(['node', '-e', 'require("node:fs").writeFileSync(process.argv[1], "hi")', out], 'workspace-write')
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`)
  if (!existsSync(out) || readFileSync(out, 'utf8') !== 'hi') {
    throw new Error('out.txt is missing or has wrong content on the host')
  }
})

check('read-only: a workspace write is denied by the sandbox', () => {
  const out = join(workspace, 'ro.txt')
  const r = run(['node', '-e', 'require("node:fs").writeFileSync(process.argv[1], "x")', out], 'read-only')
  if (r.status === 0) throw new Error('write unexpectedly succeeded under read-only')
  const err = r.stderr.toLowerCase()
  if (!/(read-only file system|permission denied|operation not permitted|erofs|eacces)/i.test(err)) {
    throw new Error(`expected a denial signature, got: ${r.stderr}`)
  }
  if (existsSync(out)) throw new Error('ro.txt must not exist on the host')
})

check('isolation: writes outside the workspace do not leak to the host', () => {
  const hostLeak = join(tmpdir(), 'dshrb-e2e-leak.txt')
  rmSync(hostLeak, { force: true })
  // Container-absolute path: only the workspace is bind-mounted, so /tmp here is
  // the container's own ephemeral /tmp, not the host's.
  const r = run(['node', '-e', 'require("node:fs").writeFileSync("/tmp/dshrb-e2e-leak.txt", "x")'], 'workspace-write')
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`)
  if (existsSync(hostLeak)) throw new Error(`container write leaked to host ${hostLeak}`)
})

check('fail-closed: an image without a digest is refused', () => {
  const bad = new DockerSandboxProvider(new Context(), { image: 'node:24-bookworm-slim' })
  // Isolate the digest gate from the Linux-only platform gate so this check is
  // meaningful regardless of the host running the script.
  bad.internals.platform = 'linux'
  let threw = false
  try {
    bad.confine(['node', '-v'], { mode: 'workspace-write', workspaceRoot: workspace })
  } catch (error) {
    threw = error instanceof Error && /digest/.test(error.message)
  }
  if (!threw) throw new Error('did not throw a digest error for an unpinned image')
})

rmSync(workspace, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL DOCKER E2E PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
