/**
 * GitHub Action driver shell.
 *
 * Thin adapter: reads inputs, runs the shared pipeline, writes outputs. No
 * business logic — that lives in review-runtime so every driver behaves alike.
 *
 * Scalar output names are a stable published contract: once released they are
 * never renamed, only added to. See docs/07-data-contracts.md.
 */
import { appendFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { requestId } from '@dshrb/review-core'
import type { ReviewResult } from '@dshrb/review-core'
import { bootReviewRuntime } from '@dshrb/runtime-bootstrap'

/** Action inputs, kebab-case as declared in action.yml. */
export interface ActionInputs {
  readonly 'deepseek-api-key': string
  readonly 'github-token'?: string
  readonly 'allow-write'?: string
  readonly 'run-tests'?: string
  /** JSON array of argv arrays. Not shell-expanded. */
  readonly 'test-commands'?: readonly (readonly string[])[]
  /** Full image digest required in write mode. */
  readonly 'container-image'?: string
  readonly 'progress-comment'?: string
  readonly 'timeout-minutes'?: string
  readonly 'min-severity'?: string
  /** JSON array of rule pack package names. */
  readonly 'rule-packs'?: readonly string[]
}

/** An input read error: malformed env is a config bug, never retryable. */
export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

function requireInput(env: NodeJS.ProcessEnv, envName: string, inputName: string): string {
  const value = env[envName]
  if (value === undefined || value.trim() === '') {
    throw new InputError(`required input '${inputName}' is missing (env ${envName})`)
  }
  return value
}

function optionalInput(
  env: NodeJS.ProcessEnv, envName: string, inputName: keyof ActionInputs, inputs: Record<string, unknown>,
): void {
  const value = env[envName]
  if (value !== undefined && value !== '') {
    inputs[inputName] = value
  }
}

function parseArgvArray(raw: string): readonly (readonly string[])[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new InputError(`input 'test-commands' is not valid JSON: ${(error as Error).message}`)
  }
  if (!Array.isArray(value)) {
    throw new InputError("input 'test-commands' must be a JSON array of argv arrays")
  }
  for (const [index, argv] of value.entries()) {
    if (!Array.isArray(argv) || argv.some((part) => typeof part !== 'string')) {
      throw new InputError(`input 'test-commands' entry ${index} must be an array of strings`)
    }
  }
  return value as readonly (readonly string[])[]
}

function parseStringArray(raw: string): readonly string[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new InputError(`input 'rule-packs' is not valid JSON: ${(error as Error).message}`)
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new InputError("input 'rule-packs' must be a JSON array of package names")
  }
  return value as readonly string[]
}

/**
 * Parses all 10 `action.yml` inputs from the `INPUT_*` environment.
 * `test-commands` and `rule-packs` parse as JSON arrays and fail loudly on
 * malformed input, so a typo in a workflow never half-runs the review.
 */
/**
 * GitHub maps an action input name to `INPUT_<NAME>` with the name uppercased
 * and hyphens **preserved** (`deepseek-api-key` → `INPUT_DEEPSEEK-API-KEY`),
 * not converted to underscores — see actions/runner#2283 / actions/toolkit#629.
 * Reading the underscore form silently drops every kebab-case input, so mirror
 * the toolkit rule exactly.
 */
function inputEnv(name: string): string {
  return `INPUT_${name.toUpperCase()}`
}

export function readInputs(env: NodeJS.ProcessEnv): ActionInputs {
  const inputs: Record<string, unknown> = {
    'deepseek-api-key': requireInput(env, inputEnv('deepseek-api-key'), 'deepseek-api-key'),
  }
  optionalInput(env, inputEnv('github-token'), 'github-token', inputs)
  optionalInput(env, inputEnv('allow-write'), 'allow-write', inputs)
  optionalInput(env, inputEnv('run-tests'), 'run-tests', inputs)
  optionalInput(env, inputEnv('container-image'), 'container-image', inputs)
  optionalInput(env, inputEnv('progress-comment'), 'progress-comment', inputs)
  optionalInput(env, inputEnv('timeout-minutes'), 'timeout-minutes', inputs)
  optionalInput(env, inputEnv('min-severity'), 'min-severity', inputs)

  const testCommands = env[inputEnv('test-commands')]
  if (testCommands !== undefined && testCommands !== '') {
    inputs['test-commands'] = parseArgvArray(testCommands)
  }
  const rulePacks = env[inputEnv('rule-packs')]
  if (rulePacks !== undefined && rulePacks !== '') {
    inputs['rule-packs'] = parseStringArray(rulePacks)
  }
  return inputs as unknown as ActionInputs
}

// --- Outputs ----------------------------------------------------------------

const SCHEMA_VERSION = 1

/** `verdict.status` → the coarse `conclusion` a workflow gates on. */
function conclusionFor(status: ReviewResult['verdict']['status']): string {
  if (status === 'success') {
    return 'success'
  }
  if (status === 'neutral') {
    return 'neutral'
  }
  return 'failure'
}

/** The versioned result envelope. Stable: add keys, never rename or remove. */
export function buildResultJson(result: ReviewResult): Record<string, unknown> {
  const write = result.write
  return {
    schemaVersion: SCHEMA_VERSION,
    status: result.verdict.status,
    timing: { durationMs: result.verdict.durationMs, ...result.timing },
    policy: {
      trustLevel: result.trust ?? 'none',
      capabilities: result.capabilities ?? null,
    },
    operation: result.operation ?? 'none',
    forge: result.forgeId ?? '',
    isolation: result.isolation ?? null,
    findings: {
      items: result.findings,
      discarded: result.discarded,
      suppressed: result.suppressed ?? [],
    },
    publication: result.publication ?? null,
    validation: write?.validation ?? null,
    write: write === undefined ? null : {
      appliedPatches: write.appliedPatches,
      commitSha: write.commitSha ?? null,
      pullRequestUrl: write.pullRequestUrl ?? null,
    },
    rules: result.rules ?? [],
    failure: result.failure ?? null,
    replay: result.replayId ?? null,
  }
}

/**
 * Maps `ReviewResult` onto the 16 scalar outputs plus `result-json`, field for
 * field with docs/07-data-contracts.md. Unknown fields stay absent; optional
 * fields absent from the result map to the empty string.
 */
export function buildOutputs(result: ReviewResult): Record<string, string> {
  const write = result.write
  return {
    conclusion: conclusionFor(result.verdict.status),
    operation: result.operation ?? '',
    summary: result.summary ?? '',
    'review-summary': result.summary ?? '',
    'findings-count': String(result.verdict.findingsCount),
    'blockers-count': String(result.verdict.blockersCount),
    'suppressed-count': String(result.suppressed?.length ?? 0),
    'branch-name': '',
    'pull-request-url': write?.pullRequestUrl ?? '',
    'commit-sha': write?.commitSha ?? '',
    trust: result.trust ?? '',
    forge: result.forgeId ?? '',
    'duration-ms': String(result.verdict.durationMs),
    'comment-id': result.stickyCommentId ?? '',
    'replay-id': result.replayId ?? '',
    'error-code': result.failure?.code ?? '',
    'error-message': result.failure?.message ?? '',
    'result-json': JSON.stringify(buildResultJson(result)),
  }
}

/** GitHub Actions heredoc line for a multi-line output. */
function heredocLine(name: string, value: string): string {
  const delimiter = `dshrb-${name}-${Date.now()}`
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`
}

/** Single-value outputs are newline-free, so `name=value` is safe. */
function assignmentLine(name: string, value: string): string {
  return `${name}=${value}\n`
}

/**
 * Writes every scalar output plus `result-json` to the `GITHUB_OUTPUT` file.
 *
 * Called even on a failed step, so consumers can read outputs under `always()`.
 * Model-derived strings stay untrusted here: they must reach downstream steps
 * through env vars, never spliced into a shell command. No-op when
 * `GITHUB_OUTPUT` is unset (local runs), so tests and CLI use `buildOutputs`.
 */
export async function writeOutputs(result: ReviewResult): Promise<void> {
  const outputs = buildOutputs(result)
  const path = process.env.GITHUB_OUTPUT
  if (path === undefined || path === '') {
    return
  }
  let chunk = ''
  for (const [name, value] of Object.entries(outputs)) {
    chunk += value.includes('\n') ? heredocLine(name, value) : assignmentLine(name, value)
  }
  await appendFile(path, chunk, 'utf8')
}

// --- Main -------------------------------------------------------------------

/**
 * Reads the GitHub event payload and injects the idempotency key. A webhook
 * uses `GITHUB_DELIVERY`; a workflow run falls back to `GITHUB_RUN_ID`.
 */
export function readEventPayload(env: NodeJS.ProcessEnv): unknown {
  const eventPath = env.GITHUB_EVENT_PATH
  if (eventPath === undefined || eventPath === '') {
    throw new InputError('GITHUB_EVENT_PATH is not set')
  }
  let payload: unknown
  try {
    payload = JSON.parse(readFileSync(eventPath, 'utf8'))
  } catch (error) {
    throw new InputError(`could not parse GITHUB_EVENT_PATH payload: ${(error as Error).message}`)
  }
  const deliveryId = env.GITHUB_DELIVERY ?? env.GITHUB_RUN_ID ?? ''
  if (typeof payload !== 'object' || payload === null) {
    throw new InputError('GITHUB_EVENT_PATH payload is not an object')
  }
  return { ...(payload as Record<string, unknown>), deliveryId }
}

/** The runtime entry the bootstrap must produce: run a raw event to a result. */
export type ReviewRunner = (raw: unknown) => Promise<ReviewResult>

/** Coerces an Action boolean input (`'true'`/anything else) to a boolean. */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  return raw === 'true'
}

const SEVERITIES = ['blocker', 'major', 'minor', 'nit', 'info'] as const

/** Validates the `min-severity` input against the stable severity vocabulary. */
function parseSeverity(raw: string | undefined): 'blocker' | 'major' | 'minor' | 'nit' | 'info' {
  if (raw === undefined) return 'minor'
  if ((SEVERITIES as readonly string[]).includes(raw)) {
    return raw as 'blocker' | 'major' | 'minor' | 'nit' | 'info'
  }
  throw new InputError(`input 'min-severity' must be one of ${SEVERITIES.join(', ')}, got '${raw}'`)
}

/** Validates the `timeout-minutes` input as a positive finite number of minutes. */
function parseTimeoutMinutes(raw: string | undefined): number {
  if (raw === undefined) return 25
  const value = Number(raw)
  // `Number('abc')` is NaN and `Number('')` is 0: both would silently collapse
  // the watchdog to an immediate timeout instead of failing the run loudly.
  if (!Number.isFinite(value) || value <= 0) {
    throw new InputError(`input 'timeout-minutes' must be a positive number of minutes, got '${raw}'`)
  }
  return value
}

/**
 * Boots the Cordis container and returns a `runReview` bound to the resolved
 * configuration. The plugin chain and agent loop are wired by
 * `@dshrb/runtime-bootstrap`; this function only maps Action inputs onto the
 * bootstrap config and surfaces the credentials the LLM adapter resolves.
 */
export async function createRunner(inputs: ActionInputs, _env: NodeJS.ProcessEnv): Promise<ReviewRunner> {
  // The DSH base resolves the DeepSeek key from the inherited environment
  // (`DEEPSEEK_API_KEY`); surface the Action input there before boot. The key
  // never enters the agent workspace — it is read only by the adapter chain.
  process.env.DEEPSEEK_API_KEY = inputs['deepseek-api-key']

  const runtime = await bootReviewRuntime({
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    ...(inputs['github-token'] === undefined ? {} : { githubToken: inputs['github-token'] }),
    allowWrite: parseBool(inputs['allow-write'], false),
    enableDiagnose: true,
    minSeverity: parseSeverity(inputs['min-severity']),
    timeoutMinutes: parseTimeoutMinutes(inputs['timeout-minutes']),
    ...(inputs['test-commands'] === undefined ? {} : { testCommands: inputs['test-commands'] }),
  })
  return runtime.runReview
}

/**
 * `readInputs → runReview → writeOutputs`, with a watchdog: `timeout-minutes`
 * (default 25) is the internal budget and the job-level timeout sits above it,
 * so `writeOutputs` finalizes before the job is killed. Every failure path —
 * malformed inputs, bootstrap failure, or a review timeout — still writes a
 * terminal `result-json` before rethrowing.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const inputs = readInputs(env)
    const raw = readEventPayload(env)
    const run = await createRunner(inputs, env)
    const result = await run(raw)
    await writeOutputs(result)
  } catch (error) {
    await writeOutputs({
      requestId: requestId(env.GITHUB_RUN_ID ?? 'unknown'),
      verdict: {
        status: 'failed',
        findingsCount: 0,
        blockersCount: 0,
        durationMs: 0,
      },
      findings: [],
      discarded: [],
      failure: {
        code: 'E_DRIVER',
        phase: 'ingest',
        title: (error as Error).name,
        message: (error as Error).message,
        guidance: 'see the run logs for details',
        retryable: false,
      },
    })
    throw error
  }
}
