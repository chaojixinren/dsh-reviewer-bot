/**
 * Local CLI driver: dry-run, replay, and rule debugging.
 *
 * This is the fast feedback loop the project depends on — tuning prompts or rules
 * there means pushing a PR and waiting on CI for every iteration. Here a run is
 * reproducible offline from a snapshot.
 *
 * Like driver-action, this shell holds no business logic: it parses argv,
 * delegates to `review-runtime` / the pure helpers, renders to the terminal, and
 * returns an exit code. The one non-deterministic seam (`runAgent`) is injected
 * so every function here stays unit-testable without a network, a credential, or
 * a live DSH runtime.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createForgeRegistry } from '@dshrb/forge'
import { createLocalDeps, createLocalGateway } from '@dshrb/forge-local'
import type { FileReader, GitRunner, LineWriter } from '@dshrb/forge-local'
import { commitSha, countBlockers, requestId } from '@dshrb/review-core'
import type { CommitSha, ReviewResult } from '@dshrb/review-core'
import { createReviewRuleRegistry } from '@dshrb/rule-registry'
import type { ReviewRuleRegistry, RulePack } from '@dshrb/rule-registry'
import { baselinePack } from '@dshrb/rules-baseline'
import { createTrustPolicy } from '@dshrb/trust-policy'
import { parseReplaySnapshot, runReview } from '@dshrb/review-runtime'
import type { ReplaySnapshot, StageDeps } from '@dshrb/review-runtime'

export type Command = 'review' | 'replay' | 'rules' | 'doctor'

export interface CliOptions {
  readonly command: Command
  /** Review uncommitted working-tree changes with no network and no token. */
  readonly local?: boolean
  /** Fetch a remote change request and review it locally. */
  readonly pr?: string
  /** Snapshot id for `replay`. */
  readonly runId?: string
  /** Path for `rules --explain`. */
  readonly explain?: string
  readonly json?: boolean
}

/** A usage/argv error: printed without a stack trace, exit code 2. */
export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

const USAGE = [
  'usage: dshrb <command> [options]',
  '',
  'commands:',
  '  review --local          review uncommitted working-tree changes (offline)',
  '  review --pr <number>    review a remote change request',
  '  replay <run-id>         reproduce findings from a snapshot',
  '  rules --explain <path>  list rules effective for a path and their packs',
  '  doctor                  check config and credential reachability',
  '',
  'options:',
  '  --json                  emit JSON instead of terminal text',
].join('\n')

// --- argv -------------------------------------------------------------------

function optionValue(
  arg: string, name: string, args: readonly string[], index: number,
): { readonly value: string; readonly next: number } {
  if (arg === name) {
    const value = args[index + 1]
    if (value === undefined || value === '' || value.startsWith('-')) {
      throw new CliError(`${name} requires a value`)
    }
    return { value, next: index + 1 }
  }
  const value = arg.slice(name.length + 1)
  if (value === '') {
    throw new CliError(`${name} requires a value`)
  }
  return { value, next: index }
}

/**
 * Parses the four subcommands and their options. Invalid input raises a
 * `CliError` with a usage hint rather than crashing with a stack trace — the
 * failure is a user typo, not a bug (docs/03 pipeline: clear errors, no stack).
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const args = [...argv]
  const command = args.shift()
  if (command !== 'review' && command !== 'replay' && command !== 'rules' && command !== 'doctor') {
    throw new CliError(command === undefined ? `missing command\n\n${USAGE}` : `unknown command '${command}'\n\n${USAGE}`)
  }

  let local: boolean | undefined
  let pr: string | undefined
  let runId: string | undefined
  let explain: string | undefined
  let json: boolean | undefined

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '--json') {
      json = true
    } else if (arg === '--local') {
      if (command !== 'review') throw new CliError('--local is only valid with `review`')
      if (pr !== undefined) throw new CliError('`review` accepts either --local or --pr, not both')
      local = true
    } else if (arg === '--pr' || arg.startsWith('--pr=')) {
      if (command !== 'review') throw new CliError('--pr is only valid with `review`')
      if (local === true) throw new CliError('`review` accepts either --local or --pr, not both')
      const parsed = optionValue(arg, '--pr', args, i)
      pr = parsed.value
      i = parsed.next
    } else if (arg === '--explain' || arg.startsWith('--explain=')) {
      if (command !== 'rules') throw new CliError('--explain is only valid with `rules`')
      const parsed = optionValue(arg, '--explain', args, i)
      explain = parsed.value
      i = parsed.next
    } else if (arg.startsWith('-')) {
      throw new CliError(`unknown option '${arg}'\n\n${USAGE}`)
    } else if (command === 'replay') {
      if (runId !== undefined) throw new CliError('`replay` takes exactly one <run-id>')
      runId = arg
    } else {
      throw new CliError(`unexpected argument '${arg}'\n\n${USAGE}`)
    }
  }

  if (command === 'review' && local !== true && pr === undefined) {
    throw new CliError('`review` requires --local or --pr <number>\n\n' + USAGE)
  }
  if (command === 'replay' && runId === undefined) {
    throw new CliError('`replay` requires a <run-id>\n\n' + USAGE)
  }
  if (command === 'rules' && explain === undefined) {
    throw new CliError('`rules` requires --explain <path>\n\n' + USAGE)
  }

  return {
    command,
    ...(local === undefined ? {} : { local }),
    ...(pr === undefined ? {} : { pr }),
    ...(runId === undefined ? {} : { runId }),
    ...(explain === undefined ? {} : { explain }),
    ...(json === undefined ? {} : { json }),
  }
}

// --- Rendering --------------------------------------------------------------

/** JSON output for any structured result. */
export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** Terminal rendering of a `ReviewResult` (review and replay both use it). */
export function renderToTty(result: ReviewResult): string {
  const lines: string[] = []
  const verdict = result.verdict
  lines.push(
    `dshrb ${result.operation ?? 'review'} — ${verdict.status} `
    + `(${verdict.findingsCount} findings, ${verdict.blockersCount} blockers, ${verdict.durationMs}ms)`,
  )
  if (result.replayId !== undefined) {
    lines.push(`replay: ${result.replayId}`)
  }
  if (result.snapshotError !== undefined) {
    lines.push(`snapshot: unavailable — ${result.snapshotError}`)
  }
  if (result.failure !== undefined) {
    lines.push(`failure [${result.failure.code}] ${result.failure.phase}: ${result.failure.message}`)
  }
  if (result.findings.length > 0) {
    lines.push('', 'findings:')
    for (const finding of result.findings) {
      lines.push(`  [${finding.severity}] ${finding.anchor.path}:${finding.anchor.line} — ${finding.title}`)
      lines.push(`    ${finding.body.replaceAll('\n', '\n    ')}`)
      if (finding.failureScenario !== undefined) {
        lines.push(`    scenario: ${finding.failureScenario.replaceAll('\n', '\n    ')}`)
      }
    }
  }
  if (result.discarded.length > 0) {
    lines.push('', `discarded (${result.discarded.length}):`)
    for (const entry of result.discarded) {
      lines.push(`  - ${entry.reason} — ${entry.rawTitle}`)
    }
  }
  return lines.join('\n')
}

// --- Snapshot storage -------------------------------------------------------

/**
 * Snapshot files stay on the local disk by default because they contain
 * repository source. The directory is env-configurable; remote archiving is
 * deliberately NOT wired here — that is a private-code egress path a user must
 * opt into explicitly (docs/08-deployment-modes.md).
 */
export function snapshotDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSHRB_SNAPSHOT_DIR ?? join(homedir(), '.dshrb', 'snapshots')
}

export async function readSnapshotFile(dir: string, runId: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, `${runId}.json`), 'utf8')) as unknown
}

export async function writeSnapshotFile(dir: string, snapshot: ReplaySnapshot): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${snapshot.replayId}.json`), JSON.stringify(snapshot, null, 2), 'utf8')
}

// --- replay -----------------------------------------------------------------

/**
 * Rebuilds a `ReviewResult` from a snapshot. The snapshot is re-validated by
 * `parseReplaySnapshot` (which runs every finding through
 * `findingInvariantViolation`), so a corrupt or newer-version snapshot is
 * rejected rather than replayed. The reader is injected for tests; the default
 * reads from the local snapshot directory.
 */
export async function replay(
  runId: string,
  read: (runId: string) => Promise<unknown> = (id) => readSnapshotFile(snapshotDir(), id),
): Promise<ReviewResult> {
  const snapshot = parseReplaySnapshot(await read(runId))
  return {
    requestId: requestId(snapshot.requestId),
    verdict: {
      status: 'success',
      findingsCount: snapshot.findings.length,
      blockersCount: countBlockers(snapshot.findings),
      durationMs: 0,
    },
    findings: snapshot.findings,
    discarded: snapshot.discarded,
    replayId: snapshot.replayId,
  }
}

// --- rules --explain --------------------------------------------------------

export interface RuleExplanation {
  readonly path: string
  readonly packs: readonly { readonly id: string; readonly version: string; readonly title: string }[]
  readonly rules: readonly { readonly id: string; readonly severity: string; readonly pack: string; readonly guidance: string }[]
}

/** Lists the rules effective for `path` and the pack each came from. */
export function rulesExplain(path: string, registry: ReviewRuleRegistry): RuleExplanation {
  return {
    path,
    packs: registry.packs(),
    rules: registry.matchWithPacks(path).map((entry) => ({
      id: entry.rule.id,
      severity: entry.rule.severity,
      pack: entry.packId,
      guidance: entry.rule.guidance,
    })),
  }
}

export function renderRules(explanation: RuleExplanation): string {
  const lines: string[] = [`rules for ${explanation.path}`, '']
  if (explanation.packs.length === 0) {
    lines.push('no rule packs registered')
  } else {
    lines.push('active packs:')
    for (const pack of explanation.packs) {
      lines.push(`  - ${pack.id}@${pack.version} — ${pack.title}`)
    }
  }
  lines.push('')
  if (explanation.rules.length === 0) {
    lines.push('no rules apply')
  } else {
    lines.push('effective rules:')
    for (const rule of explanation.rules) {
      lines.push(`  - [${rule.severity}] ${rule.id} (from ${rule.pack})`)
      lines.push(`    ${rule.guidance}`)
    }
  }
  return lines.join('\n')
}

// --- doctor -----------------------------------------------------------------

export interface DoctorCheckInput {
  readonly name: string
  /** Whether the credential/config is present. The VALUE is never read. */
  readonly present: boolean
  /** Optional validity probe result; `false` marks a present-but-unusable check. */
  readonly valid?: boolean
}

export interface DoctorCheck {
  readonly name: string
  readonly status: 'ok' | 'missing' | 'error'
  readonly detail: string
}

export interface DoctorReport {
  readonly healthy: boolean
  readonly checks: readonly DoctorCheck[]
}

/** Credentials the reviewer pipeline can use; only presence is ever observed. */
const CREDENTIALS = [
  { env: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key (DEEPSEEK_API_KEY)' },
  { env: 'FORGE_TOKEN', label: 'forge token (FORGE_TOKEN)' },
  { env: 'GITHUB_TOKEN', label: 'GitHub token (GITHUB_TOKEN)' },
] as const

/**
 * Collects the doctor checks from the environment. It deliberately reads only
 * *whether* a credential is set — never its value — so a secret cannot leak
 * into the report (docs/04-trust-model: credentials never leave their holder).
 */
export function collectDoctorChecks(
  env: NodeJS.ProcessEnv,
  configExists: (path: string) => boolean = () => false,
): readonly DoctorCheckInput[] {
  const checks: DoctorCheckInput[] = [
    { name: 'repository config (.dshrb.yml)', present: configExists('.dshrb.yml') },
  ]
  for (const { env: name, label } of CREDENTIALS) {
    const value = env[name]
    checks.push({ name: label, present: value !== undefined && value !== '' })
  }
  return checks
}

export function doctor(checks: readonly DoctorCheckInput[]): DoctorReport {
  const results = checks.map((entry) => {
    if (!entry.present) return { name: entry.name, status: 'missing' as const, detail: 'not configured' }
    if (entry.valid === false) return { name: entry.name, status: 'error' as const, detail: 'configured but not reachable' }
    return { name: entry.name, status: 'ok' as const, detail: 'reachable' }
  })
  return { healthy: results.every((check) => check.status === 'ok'), checks: results }
}

export function renderDoctor(report: DoctorReport): string {
  const lines = [`doctor: ${report.healthy ? 'ok' : 'problems found'}`, '']
  for (const check of report.checks) {
    lines.push(`  [${check.status}] ${check.name} — ${check.detail}`)
  }
  return lines.join('\n')
}

// --- review --local ---------------------------------------------------------

export interface ReviewLocalDeps {
  readonly repo: string
  readonly baseSha: CommitSha
  /** Ignored by forge-local in working-tree mode, but required by ingest. */
  readonly headSha: CommitSha
  readonly git: GitRunner
  readonly readFile: FileReader
  readonly write: LineWriter
  readonly runAgent: StageDeps['runAgent']
  readonly writeSnapshot?: (snapshot: ReplaySnapshot) => Promise<void>
  readonly rulePacks?: readonly RulePack[]
  readonly now?: () => number
  readonly root?: string
}

/**
 * Runs the full pipeline through forge-local in working-tree mode, so
 * `review-runtime` cannot tell CI from a laptop. Only `runAgent` is
 * non-deterministic; everything else (ingest → route → authorize → context →
 * validate → snapshot → publish → report) is the same deterministic path as CI.
 */
export async function reviewLocal(deps: ReviewLocalDeps): Promise<ReviewResult> {
  const registry = createReviewRuleRegistry({ disabled: [], minSeverity: 'minor' })
  for (const pack of deps.rulePacks ?? [baselinePack]) {
    registry.register(pack)
  }

  const forges = createForgeRegistry()
  forges.register(createLocalGateway(
    { root: deps.root ?? process.cwd(), workingTree: true },
    { git: deps.git, readFile: deps.readFile, write: deps.write },
  ))

  const trustPolicy = createTrustPolicy({ allowWrite: false, protectedPaths: [] })
  const stageDeps: StageDeps = {
    forges,
    now: deps.now ?? (() => Date.now()),
    allowWrite: false,
    minSeverity: 'minor',
    shardBytes: 120_000,
    matchRules: (path) => registry.match(path),
    memory: [],
    packs: () => registry.packs(),
    trustPolicy,
    runAgent: deps.runAgent,
    ...(deps.writeSnapshot === undefined ? {} : { writeSnapshot: deps.writeSnapshot }),
  }

  return runReview({
    deliveryId: 'local',
    forge: 'local',
    repository: { full_name: deps.repo },
    sender: { login: 'local' },
    pull_request: {
      number: 1,
      base: { sha: deps.baseSha, repo: { full_name: deps.repo } },
      head: { sha: deps.headSha, repo: { full_name: deps.repo, fork: false } },
    },
  }, stageDeps, {
    timeoutMinutes: 25,
    shardBytes: 120_000,
    parallelShards: true,
    snapshotReplay: deps.writeSnapshot !== undefined,
    allowWrite: false,
    minSeverity: 'minor',
  })
}

// --- main -------------------------------------------------------------------

/** The seams `main` needs; injected so the shell stays testable offline. */
export interface CliDeps {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly readSnapshot: (runId: string) => Promise<unknown>
  readonly registry: ReviewRuleRegistry
  readonly doctorChecks: readonly DoctorCheckInput[]
  readonly review: (options: CliOptions) => Promise<ReviewResult>
}

/**
 * Real-world deps: a baseline rule registry, the local snapshot directory, and
 * environment-derived doctor checks. `review --local` runs through forge-local
 * with real git, but its `runAgent` throws because the LLM bootstrap is
 * assembled by the release build (the same deferral as driver-action's
 * `createRunner`).
 */
export function createDefaultDeps(env: NodeJS.ProcessEnv = process.env): CliDeps {
  const root = env.DSHRB_ROOT ?? process.cwd()
  const dir = snapshotDir(env)
  const registry = createReviewRuleRegistry({ disabled: [], minSeverity: 'minor' })
  registry.register(baselinePack)
  const localDeps = createLocalDeps(root)

  return {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    readSnapshot: (runId) => readSnapshotFile(dir, runId),
    registry,
    doctorChecks: collectDoctorChecks(env, (path) => existsSync(join(root, path))),
    review: async (options) => {
      if (options.local !== true) {
        throw new CliError('`review --pr` needs the remote forge and runtime bootstrap; only `--local` is available in this milestone')
      }
      const baseSha = commitSha((await localDeps.git(['rev-parse', 'HEAD'])).trim())
      return reviewLocal({
        repo: env.DSHRB_REPO ?? 'local',
        baseSha,
        headSha: baseSha,
        git: localDeps.git,
        readFile: localDeps.readFile,
        write: localDeps.write,
        writeSnapshot: (snapshot) => writeSnapshotFile(dir, snapshot),
        runAgent: async () => {
          throw new Error('runtime bootstrap (LLM agent) is assembled by the release build; `review --local` needs it')
        },
      })
    },
  }
}

/**
 * `parseArgs → dispatch → render`, returning an exit code:
 * `0` success, `1` a review/doctor/replay failure, `2` a usage error. Every
 * error is rendered as a message, never a stack trace.
 */
export async function main(
  argv: readonly string[],
  deps: CliDeps = createDefaultDeps(),
): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    deps.stderr(error instanceof CliError ? error.message : `unexpected: ${(error as Error).message}`)
    return 2
  }

  try {
    switch (options.command) {
      case 'review': {
        const result = await deps.review(options)
        deps.stdout(options.json === true ? renderJson(result) : renderToTty(result))
        return result.verdict.status === 'success' || result.verdict.status === 'neutral' ? 0 : 1
      }
      case 'replay': {
        const result = await replay(options.runId ?? '', deps.readSnapshot)
        deps.stdout(options.json === true ? renderJson(result) : renderToTty(result))
        return 0
      }
      case 'rules': {
        const explanation = rulesExplain(options.explain ?? '', deps.registry)
        deps.stdout(options.json === true ? renderJson(explanation) : renderRules(explanation))
        return 0
      }
      case 'doctor': {
        const report = doctor(deps.doctorChecks)
        deps.stdout(options.json === true ? renderJson(report) : renderDoctor(report))
        return report.healthy ? 0 : 1
      }
      default:
        return 1
    }
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}
