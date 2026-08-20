/**
 * dshrb review-results panel: a DSH WebUI surface that reads and renders the
 * public `result-json` envelope produced by the review runtime / action.
 *
 * This is the natural continuation of `@dshrb/config` (PR #79): that package
 * owns the `dshrb` settings namespace so the Web UI can *edit* reviewer
 * configuration; this package owns an in-memory `dshrbResults` store so the
 * Web UI can *view* reviewer output. Both follow the same Cordis / Typert
 * Remote pattern — a Host service, a `TypertRemoteService` gateway, a
 * host-face `typert.ts` manifest, and a committed static `client.js` that
 * registers a `settings.section`.
 *
 * The store is intentionally ephemeral (process-lifetime). Two ingestion paths
 * feed it:
 *   - `submitResult(json)`  — the browser Remote; a user pastes a `result-json`
 *     (e.g. from the CI `dsh-result-json` artifact) and the Host normalizes +
 *     stores it.
 *   - `ctx.results.ingest(envelope)` — the Host-internal API a future runtime
 *     hook can call to push every completed run automatically (see PR desc).
 *
 * Normalization lives on the Host so the browser only ever renders a clean,
 * already-parsed `ReviewRun`. The envelope contract mirrors
 * `driver-action#buildResultJson` (schemaVersion, status, findings.{items,
 * discarded, suppressed}, policy, write, failure, replay, …) and also tolerates
 * a replay `version` snapshot and a legacy flat `findings` array.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export type Severity = 'blocker' | 'major' | 'minor' | 'nit' | 'info'

const SEVERITY_ORDER: readonly Severity[] = ['blocker', 'major', 'minor', 'nit', 'info']

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITY_ORDER as readonly string[]).includes(value)
}

/** A finding flattened for the wire: the anchor's path/line are lifted up. */
export interface FindingView {
  findingId?: string
  severity: Severity
  title: string
  body?: string
  ruleId?: string
  path?: string
  line?: number
  side?: 'left' | 'right'
  anchored?: boolean
  failureScenario?: string
}

/** Lightweight row for the run list (no full findings arrays). */
export interface ReviewRunSummary {
  id: string
  schemaVersion: number
  status: string
  createdAt: string
  trustLevel?: string
  operation?: string
  forge?: string
  total: number
  blockers: number
  suppressed: number
  discarded: number
  writeRequested: boolean
  failureCode?: string
}

/** A fully normalized, render-ready review run. */
export interface ReviewRun {
  id: string
  schemaVersion: number
  status: string
  createdAt: string
  trustLevel?: string
  operation?: string
  forge?: string
  write?: { appliedPatches: number; commitSha?: string; pullRequestUrl?: string }
  failure?: {
    code: string
    phase: string
    title: string
    message: string
    guidance: string
    retryable: boolean
  } | null
  replay?: string | null
  rules?: unknown[]
  timing?: { durationMs?: number }
  summary: {
    total: number
    bySeverity: Record<string, number>
    byRule: Record<string, number>
    suppressed: number
    discarded: number
  }
  findings: FindingView[]
  suppressed: FindingView[]
  discarded: FindingView[]
}

export interface DshrbResultsService {
  /** Newest-first list of run summaries. */
  list(): ReviewRunSummary[]
  /** Full run by id, or undefined. */
  get(id: string): ReviewRun | undefined
  /** Normalize a `result-json` envelope (or replay/legacy shape) and store it. */
  ingest(envelope: unknown): { id: string }
  /** Remove one run (by id) or every run when id is omitted. */
  clear(id?: string): void
  /** Subscribe to list changes; returns the unsubscription disposer. */
  watch(callback: (runs: ReviewRunSummary[]) => void | Promise<void>): () => void
}

export interface ResultsConfig {
  /** Max runs retained in memory; oldest are evicted past this. */
  maxRuns?: number
}

export const Config: Schema<ResultsConfig> = Schema.object({
  maxRuns: Schema.number().default(50),
})

export const name = 'dshrb-results'

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function toFindingView(raw: unknown): FindingView {
  const f = (raw ?? {}) as Record<string, unknown>
  const anchor = (f.anchor ?? {}) as Record<string, unknown>
  const severity = isSeverity(f.severity) ? f.severity : 'info'
  const view: FindingView = {
    severity,
    title: typeof f.title === 'string' ? f.title : '',
  }
  if (typeof f.findingId === 'string') view.findingId = f.findingId
  if (typeof f.body === 'string') view.body = f.body
  if (typeof f.ruleId === 'string') view.ruleId = f.ruleId
  if (typeof anchor.path === 'string') view.path = anchor.path
  if (typeof anchor.line === 'number') view.line = anchor.line
  if (anchor.side === 'left' || anchor.side === 'right') view.side = anchor.side
  if (typeof anchor.anchored === 'boolean') view.anchored = anchor.anchored
  if (typeof f.failureScenario === 'string') view.failureScenario = f.failureScenario
  return view
}

function summarize(findings: FindingView[]) {
  // `Object.create(null)` so untrusted ruleId values (e.g. "constructor",
  // "__proto__") can't collide with Object.prototype keys.
  const bySeverity: Record<string, number> = Object.create(null)
  const byRule: Record<string, number> = Object.create(null)
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
    const rule = f.ruleId ?? 'untagged'
    byRule[rule] = (byRule[rule] ?? 0) + 1
  }
  return { bySeverity, byRule }
}

/**
 * Accepts the three shapes a result can arrive as and returns one normalized
 * `ReviewRun`. Throws on input that is not recognizably a result.
 */
export function normalizeEnvelope(raw: unknown): ReviewRun {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('dshrb-results: envelope must be an object')
  }
  const e = raw as Record<string, unknown>

  let items: unknown[]
  let discarded: unknown[]
  let suppressed: unknown[]
  let schemaVersion: number
  let status: string

  const findings = e.findings
  if (typeof e.schemaVersion === 'number' && findings != null && typeof findings === 'object' && !Array.isArray(findings)) {
    // Current `result-json` envelope (driver-action#buildResultJson).
    const f = findings as Record<string, unknown>
    items = asArray(f.items)
    discarded = asArray(f.discarded)
    suppressed = asArray(f.suppressed)
    schemaVersion = e.schemaVersion
    status = typeof e.status === 'string' ? e.status : 'neutral'
  } else if (typeof e.version === 'number' || typeof e.version === 'string') {
    // Replay snapshot: flat `findings` array, separate `version` field.
    items = asArray(findings)
    discarded = []
    suppressed = []
    schemaVersion = 0
    status = typeof e.status === 'string' ? e.status : 'neutral'
  } else if (Array.isArray(findings)) {
    // Legacy flat shape.
    items = findings
    discarded = asArray(e.discarded)
    suppressed = asArray(e.suppressed)
    schemaVersion = typeof e.schemaVersion === 'number' ? e.schemaVersion : 0
    status = typeof e.status === 'string' ? e.status : 'neutral'
  } else {
    throw new Error('dshrb-results: unrecognized envelope (no findings / schemaVersion / version)')
  }

  const itemViews = items.map(toFindingView)
  const suppressedViews = suppressed.map(toFindingView)
  const discardedViews = discarded.map(toFindingView)
  const { bySeverity, byRule } = summarize(itemViews)

  const policy = (e.policy ?? {}) as Record<string, unknown>
  const write = e.write as Record<string, unknown> | undefined
  const failure = e.failure as Record<string, unknown> | null | undefined

  const id = newId()
  const run: ReviewRun = {
    id,
    schemaVersion,
    status,
    createdAt: new Date().toISOString(),
    findings: itemViews,
    suppressed: suppressedViews,
    discarded: discardedViews,
    summary: {
      total: itemViews.length,
      bySeverity,
      byRule,
      suppressed: suppressedViews.length,
      discarded: discardedViews.length,
    },
  }
  if (typeof policy.trustLevel === 'string') run.trustLevel = policy.trustLevel
  if (typeof e.operation === 'string') run.operation = e.operation
  if (typeof e.forge === 'string') run.forge = e.forge
  if (write !== undefined && write !== null) {
    const applied = write.appliedPatches
    run.write = {
      appliedPatches: Array.isArray(applied) ? applied.length : Number(applied) || 0,
      ...(typeof write.commitSha === 'string' ? { commitSha: write.commitSha } : {}),
      ...(typeof write.pullRequestUrl === 'string' ? { pullRequestUrl: write.pullRequestUrl } : {}),
    }
  }
  if (failure && typeof failure === 'object') {
    const f = failure as Record<string, unknown>
    run.failure = {
      code: typeof f.code === 'string' ? f.code : 'unknown',
      phase: typeof f.phase === 'string' ? f.phase : 'unknown',
      title: typeof f.title === 'string' ? f.title : 'Failure',
      message: typeof f.message === 'string' ? f.message : '',
      guidance: typeof f.guidance === 'string' ? f.guidance : '',
      retryable: f.retryable === true,
    }
  }
  if (e.replay !== undefined) run.replay = typeof e.replay === 'string' ? e.replay : null
  if (Array.isArray(e.rules)) run.rules = e.rules
  if (e.timing != null && typeof e.timing === 'object') {
    const t = e.timing as Record<string, unknown>
    run.timing = typeof t.durationMs === 'number' ? { durationMs: t.durationMs } : {}
  }
  return run
}

function createService(maxRuns: number): DshrbResultsService {
  const runs = new Map<string, ReviewRun>()
  const watchers = new Set<(runs: ReviewRunSummary[]) => void | Promise<void>>()

  function notify() {
    const list = toSummaries()
    for (const cb of watchers) {
      try {
        const result = cb(list) as Promise<void> | undefined
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch {
        // A watcher threw synchronously; ignore so one bad subscriber can't
        // break notification for the rest.
      }
    }
  }

  function toSummaries(): ReviewRunSummary[] {
    const out: ReviewRunSummary[] = []
    for (const run of runs.values()) {
      out.push({
        id: run.id,
        schemaVersion: run.schemaVersion,
        status: run.status,
        createdAt: run.createdAt,
        ...(run.trustLevel !== undefined ? { trustLevel: run.trustLevel } : {}),
        ...(run.operation !== undefined ? { operation: run.operation } : {}),
        ...(run.forge !== undefined ? { forge: run.forge } : {}),
        total: run.summary.total,
        blockers: run.summary.bySeverity.blocker ?? 0,
        suppressed: run.summary.suppressed,
        discarded: run.summary.discarded,
        writeRequested: run.write !== undefined && (typeof run.write.commitSha === 'string' || typeof run.write.pullRequestUrl === 'string'),
        ...(run.failure ? { failureCode: run.failure.code } : {}),
      })
    }
    out.reverse() // newest first
    return out
  }

  return {
    list: toSummaries,
    get: (id) => runs.get(id),
    ingest: (envelope) => {
      const run = normalizeEnvelope(envelope)
      runs.set(run.id, run)
      while (runs.size > maxRuns) {
        const oldest = runs.keys().next().value
        if (oldest === undefined) break
        runs.delete(oldest)
      }
      notify()
      return { id: run.id }
    },
    clear: (id) => {
      if (id === undefined) runs.clear()
      else runs.delete(id)
      notify()
    },
    watch: (callback) => {
      watchers.add(callback)
      return () => { watchers.delete(callback) }
    },
  }
}

/** Typert Remote backing the Web UI results section for this namespace. */
class DshrbResultsGateway extends TypertRemoteService {
  private readonly source: DshrbResultsService

  constructor(ctx: Context, source: DshrbResultsService) {
    super(ctx, 'dshrbResultsRemote', { namespace: 'dshrbResults' })
    this.source = source
  }

  @Remote
  listResults(): ReviewRunSummary[] {
    return this.source.list()
  }

  @Remote
  getResult(id: string): ReviewRun | null {
    return this.source.get(id) ?? null
  }

  @Remote
  submitResult(envelope: unknown): { id: string } {
    return this.source.ingest(envelope)
  }

  @Remote
  clearResults(id?: string): { ok: true } {
    this.source.clear(id)
    return { ok: true }
  }
}

export function apply(ctx: Context, config: ResultsConfig = {}): void {
  const maxRuns = typeof config.maxRuns === 'number' && config.maxRuns > 0 ? Math.floor(config.maxRuns) : 50
  const service = createService(maxRuns)
  ctx.provide('results', service)
  // Browser Remote. `new` registers the Service (and its Typert binding) under
  // `dshrbResultsRemote`; the wire namespace is `dshrbResults`, so the client
  // injects `remote.dshrbResults`.
  new DshrbResultsGateway(ctx, service)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    results: DshrbResultsService
  }
}
