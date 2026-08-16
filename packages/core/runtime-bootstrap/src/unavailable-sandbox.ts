/**
 * Fail-closed sandbox provider for the standalone (bundled) runtime.
 *
 * The DSH local sandbox (`dsh-sandbox-local`) wraps subprocesses with native
 * launchers — `bwrap`/Landlock on Linux, a restricted-token runner on Windows —
 * whose native modules cannot be folded into a single esbuild bundle. Read-only
 * review and diagnosis never confine a subprocess, so this provider satisfies
 * the `sandbox` service and fails closed if write-mode validation is ever
 * requested, mirroring DSH's own refusal to run a command unconfined
 * (docs/05-packaging.md).
 */
import type { Context } from '@deepseek-ai/cordis'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

export class UnavailableSandboxProvider extends SandboxProvider {
  constructor(ctx: Context) {
    super(ctx)
  }

  confine(_argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    throw new SandboxUnavailableError(
      policy.mode,
      'the standalone Action bundle ships no native sandbox launcher; write-mode validation is unavailable',
    )
  }
}
