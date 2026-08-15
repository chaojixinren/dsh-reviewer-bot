/**
 * Write-mode sandbox contract (type-level).
 *
 * The M3 design once treated `ctx.sandbox` as the write-mode isolation
 * backend. Probing the real DSH types (0.1.0-rc.6) showed it is only an argv
 * wrapper; the policy home is `ctx.sandboxPolicy`, and file writes are fenced
 * by `ctx.fs` through its `sandboxPolicy` parameter. This file pins those
 * three seams with explicit expected signatures, so a future rc bump breaks
 * `tsc -p .` here instead of silently breaking M3 at runtime.
 */
import type {
  ConfinedArgv, SandboxExecutionPolicy, SandboxPolicy, SandboxProvider,
} from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/**
 * Compile-time contract pins. Never called at runtime — its only job is to be
 * type-checked against the real upstream signatures.
 *
 * 1. `sandbox` is an argv wrapper: `confine(argv, policy) => ConfinedArgv`.
 * 2. `sandboxPolicy` is the single policy home: `resolve() => SandboxExecutionPolicy`.
 * 3. `fs` fences mutations by the per-call `SandboxExecutionPolicy`.
 */
export function assertWriteModeContracts(
  sandbox: SandboxProvider,
  sandboxPolicy: SandboxPolicyService,
  fs: FileSystem,
): void {
  const confine: (argv: readonly string[], policy: SandboxPolicy) => ConfinedArgv =
    sandbox.confine
  const resolve: () => SandboxExecutionPolicy = sandboxPolicy.resolve
  const writeText: FileSystem['writeText'] = fs.writeText
  const editText: FileSystem['editText'] = fs.editText
  void confine
  void resolve
  void writeText
  void editText
}
