/**
 * Docker-backed sandbox provider for the standalone (bundled) runtime.
 *
 * The DSH local sandbox (`dsh-sandbox-local`) wraps subprocesses with native
 * launchers — `bwrap`/Landlock on Linux, a restricted-token runner on Windows —
 * whose native modules cannot be folded into a single esbuild bundle
 * (docs/05-packaging.md). Write-mode validation in the standalone Action needs a
 * real confinement backend without those native modules, so it delegates to a
 * container instead: `confine()` rewrites the exact argv into
 * `docker run --rm --init -w <workspace> -v <workspace>:<workspace> <image> <argv...>`,
 * and `spawnConfined` spawns that argv directly — the wrapped command is still
 * exec'd inside the container without a shell, preserving the JSON-argv red
 * line (docs/09 M3).
 *
 * File-effect isolation only: the container's own filesystem is ephemeral and
 * only `policy.workspaceRoot` is bind-mounted from the host (read-write under
 * `workspace-write`, read-only under `read-only`). Network policy is outside the
 * `SandboxMode` vocabulary and is deliberately not restricted here.
 *
 * The image reference must be pinned by digest. A mutable tag could be repointed
 * at a hostile image that reads the bind-mounted workspace, so `confine()` fails
 * closed on any image without a complete `@sha256:<64 hex>` digest.
 */
import { existsSync } from 'node:fs'
import { delimiter, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** A complete image digest: `@sha256:` followed by exactly 64 hex characters. */
const DIGEST_RE = /@sha256:[0-9a-f]{64}$/iu

export interface DockerSandboxConfig {
  /** Digest-pinned image reference, e.g. `ghcr.io/owner/repo@sha256:<64 hex>`. */
  readonly image: string
  /** Override the `docker` executable; a bare name is resolved to an absolute path. */
  readonly dockerCommand?: string
}

/** Test hook mirroring `LocalSandboxProvider.internals.platform`. */
export interface DockerSandboxInternals {
  /** Replaces `process.platform` for the Linux-only gate (offline tests). */
  platform?: string
}

/**
 * Resolves a bare executable name to an absolute path from the host `PATH` so
 * the confined argv does not depend on the (allowlist-stripped) validation
 * subprocess environment having `PATH`. Falls back to the bare name when not
 * found; `spawnConfined` still merges `PATH`/`HOME` into the runner env.
 */
function resolveDocker(command: string): string {
  if (command.includes('/') || command.includes('\\')) {
    return command
  }
  const pathEntries = (process.env.PATH ?? '').split(delimiter)
  for (const dir of pathEntries) {
    if (dir === '') continue
    const candidate = resolvePath(dir, command)
    if (existsSync(candidate)) return candidate
  }
  return command
}

export class DockerSandboxProvider extends SandboxProvider {
  /** Test hook (mirrors the local sandbox's `internals`). */
  readonly internals: DockerSandboxInternals = {}

  private readonly image: string
  private readonly dockerCommand: string

  constructor(ctx: Context, config: DockerSandboxConfig) {
    super(ctx)
    this.image = config.image
    this.dockerCommand = config.dockerCommand ?? 'docker'
  }

  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    if ((this.internals.platform ?? process.platform) !== 'linux') {
      throw new SandboxUnavailableError(
        policy.mode,
        'the Docker sandbox is Linux-only; write-mode validation is unavailable on this platform',
      )
    }
    if (!DIGEST_RE.test(this.image)) {
      throw new SandboxUnavailableError(
        policy.mode,
        `container-image '${this.image}' must be pinned by digest (@sha256:<64 hex>)`,
      )
    }
    const workspaceRoot = policy.workspaceRoot
    // Docker's `-v host:container[:ro]` grammar splits on `:`/`,`, so a workspace
    // path carrying either cannot be expressed unambiguously. Fail closed rather
    // than mount the wrong path (GitHub runner paths never contain either).
    if (workspaceRoot.includes(':') || workspaceRoot.includes(',')) {
      throw new SandboxUnavailableError(
        policy.mode,
        `workspace root '${workspaceRoot}' cannot be bind-mounted by Docker (contains ':' or ',')`,
      )
    }
    const mount = policy.mode === 'read-only'
      ? `${workspaceRoot}:${workspaceRoot}:ro`
      : `${workspaceRoot}:${workspaceRoot}`
    const docker = resolveDocker(this.dockerCommand)
    return {
      argv: [docker, 'run', '--rm', '--init', '-w', workspaceRoot, '-v', mount, this.image, ...argv],
      enforcement: 'full',
      // The read-only bind mount is the one place the container's command is
      // denied a write; these are the dialect strings a denied write produces.
      denialSignatures: ['read-only file system', 'permission denied', 'operation not permitted'],
      // Docker CLI/daemon failures mean the wrapped command never ran. Each is a
      // case-insensitive substring matched against a non-zero run's stderr.
      runnerFailureRules: [{
        fatalSignatures: [
          'docker: ',
          'Cannot connect to the Docker daemon',
          'Error response from daemon',
          'no matching manifest',
          'invalid reference format',
          'permission denied while trying to connect',
        ],
      }],
    }
  }
}
