/**
 * Long-running webhook daemon driver.
 *
 * Trades a larger attack surface for no cold start: this process holds
 * credentials for many repositories and listens on the network, unlike the
 * one-shot Action. The hardening requirements in docs/08-deployment-modes.md
 * are not optional for this mode.
 *
 * The module is deliberately split into small, dependency-injected pieces —
 * signature verification, the per-repo queue, the workspace pool, metrics and
 * the HTTP handler — so every policy (verify-before-parse, shed-on-backpressure,
 * per-repo isolation, return-on-error) is unit-testable without a network, a
 * credential, or a live DSH runtime. Only `apply()` touches real sockets and
 * real git.
 */
import { createHash, createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { ReviewRuntime } from '@dshrb/review-runtime'

export const name = 'dshrb-driver-webhook'
export const inject = ['reviewRuntime']

/** Version echoed by the unauthenticated health endpoint — and nothing else. */
export const DAEMON_VERSION = '0.1.0'

export interface Config {
  host: string
  port: number
  /** Per-forge webhook signing secrets. Read from KMS/Vault, never from disk. */
  secrets: Record<string, string>
  /** Concurrent reviews across repositories. Same-repo work stays serial to
   *  avoid workspace contention. */
  maxConcurrentRepos: number
  /** Queue depth per repository; beyond it, requests are shed with backpressure
   *  so one busy repo cannot starve the service. */
  maxQueuePerRepo: number
  /** Warm git workspace cache size. */
  workspacePoolSize: number
}

export const Config: Schema<Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.number().default(7723),
  secrets: Schema.dict(Schema.string()).default({}),
  maxConcurrentRepos: Schema.number().default(4),
  maxQueuePerRepo: Schema.number().default(16),
  workspacePoolSize: Schema.number().default(8),
})

/** Caps untrusted text before it lands in an error or a log line. */
function excerpt(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Signature verification
//
// A webhook signature is the ONLY thing standing between an unauthenticated
// caller and a service that holds credentials for many repos, so it must be
// verified before anything else — before the payload is parsed, before it is
// enqueued — and the failure response must not reveal WHY it failed (that would
// be an enumeration channel: "signature mismatch" vs "missing header" vs
// "missing secret" are three different clues to an attacker).
// ---------------------------------------------------------------------------

/** Constant-time UTF-8 equality. A length mismatch fails immediately (there is
 *  nothing to compare); equal lengths are compared with a non-short-circuiting
 *  XOR so a timing side channel cannot leak how close a guess is. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i]! ^ right[i]!
  }
  return diff === 0
}

/**
 * Verifies a GitHub/Gitea `X-Hub-Signature-256` / `X-Gitea-Signature` header
 * carrying `sha256=<hex>`. Only HMAC-SHA256 is accepted: a `sha1=` or any other
 * algorithm, or a header missing the `=` separator, fails closed.
 */
export function verifyHmacSha256(secret: string, body: Uint8Array, headerValue: string): boolean {
  if (secret === '') {
    return false
  }
  const separator = headerValue.indexOf('=')
  if (separator <= 0) {
    return false
  }
  const algorithm = headerValue.slice(0, separator)
  const hex = headerValue.slice(separator + 1)
  if (algorithm !== 'sha256' || hex === '') {
    return false
  }
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  return timingSafeEqual(expected, hex)
}

/**
 * Verifies a GitLab `X-Gitlab-Token` header. GitLab authenticates webhooks by
 * echoing the secret verbatim (no HMAC), so the check is a constant-time
 * equality — never `===`, which short-circuits on the first differing byte.
 */
export function verifyGitLabToken(secret: string, token: string): boolean {
  if (secret === '' || token === '') {
    return false
  }
  return timingSafeEqual(secret, token)
}

export type WebhookForge = 'github' | 'gitlab' | 'gitea'

/** Lower-cased header keys only. */
export type NormalizedHeaders = Readonly<Record<string, string>>

/**
 * Identifies the forge from its signature header. Exactly one of the three
 * recognized signatures must be present; otherwise the request is treated as
 * unauthenticated rather than guessed at from a `User-Agent`.
 */
export function detectForge(headers: NormalizedHeaders): WebhookForge | undefined {
  if (headers['x-hub-signature-256'] !== undefined) {
    return 'github'
  }
  if (headers['x-gitea-signature'] !== undefined) {
    return 'gitea'
  }
  if (headers['x-gitlab-token'] !== undefined) {
    return 'gitlab'
  }
  return undefined
}

/** The forge's delivery id header — the idempotency key's per-delivery part. */
export function deliveryIdFor(forge: WebhookForge, headers: NormalizedHeaders): string {
  switch (forge) {
    case 'github': return headers['x-github-delivery'] ?? ''
    case 'gitlab': return headers['x-gitlab-event-uuid'] ?? ''
    case 'gitea': return headers['x-gitea-delivery'] ?? ''
  }
}

/** Dispatches to the forge's signature algorithm. A missing secret fails closed. */
export function verifySignature(
  forge: WebhookForge,
  secrets: Readonly<Record<string, string>>,
  headers: NormalizedHeaders,
  body: Uint8Array,
): boolean {
  switch (forge) {
    case 'github':
      return verifyHmacSha256(secrets['github'] ?? '', body, headers['x-hub-signature-256'] ?? '')
    case 'gitea':
      return verifyHmacSha256(secrets['gitea'] ?? '', body, headers['x-gitea-signature'] ?? '')
    case 'gitlab':
      return verifyGitLabToken(secrets['gitlab'] ?? '', headers['x-gitlab-token'] ?? '')
  }
}

// ---------------------------------------------------------------------------
// Event identity
//
// The driver extracts only what the queue needs — the repo partition key and an
// optional same-MR/PR coalesce key — and leaves payload semantics to
// `review-runtime`, which re-validates every field it consumes. Extraction here
// is lenient on purpose: a missing repo just serializes under an empty key, and
// `ingest()` still fails the event if the payload is unusable.
// ---------------------------------------------------------------------------

export interface EventIdentity {
  readonly repo: string
  /** The change-request id (PR number / MR iid) used to coalesce queued tasks. */
  readonly changeRequestId?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Change-request ids arrive as strings OR positive integers (PR number / MR iid). */
function asIdString(value: unknown): string | undefined {
  const stringValue = asNonEmptyString(value)
  if (stringValue !== undefined) {
    return stringValue
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return String(value)
  }
  return undefined
}

export function readEventIdentity(forge: string, payload: unknown): EventIdentity {
  const root = asRecord(payload)
  if (root === undefined) {
    return { repo: '' }
  }

  if (forge === 'gitlab') {
    const project = asRecord(root.project)
    const attributes = asRecord(root.object_attributes)
    // The iid trap (docs/06): the project-scoped `iid` is the change-request id;
    // `id` is a fallback only for payload shapes that omit `iid`.
    const changeRequestId = asIdString(attributes?.iid) ?? asIdString(attributes?.id)
    return {
      repo: asNonEmptyString(project?.path_with_namespace) ?? '',
      ...(changeRequestId === undefined ? {} : { changeRequestId }),
    }
  }

  // GitHub and Gitea share the pull_request / issue / check_run payload shapes.
  const repository = asRecord(root.repository)
  const pullRequest = asRecord(root.pull_request)
  const issue = asRecord(root.issue)
  const checkRun = asRecord(root.check_run)
  let changeRequestId = asIdString(pullRequest?.number)
  if (changeRequestId === undefined) {
    const prs = checkRun?.pull_requests
    changeRequestId = Array.isArray(prs) ? asIdString(asRecord(prs[0])?.number) : undefined
  }
  changeRequestId ??= asIdString(issue?.number)
  return {
    repo: asNonEmptyString(repository?.full_name) ?? '',
    ...(changeRequestId === undefined ? {} : { changeRequestId }),
  }
}

// ---------------------------------------------------------------------------
// Metrics
//
// Counters and gauges only — no repo names, no payload fields, and never a
// secret, so a metrics scrape is not an enumeration channel either. The queue
// and pool update these through the injected `Metrics` interface.
// ---------------------------------------------------------------------------

export type CounterName =
  | 'enqueued' | 'completed' | 'failed' | 'shed' | 'signatureFailed'
  | 'deduped' | 'coalesced' | 'poolHits' | 'poolMisses'

export type GaugeName = 'queueDepth' | 'activeRepos' | 'poolSize' | 'poolLeased'

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<CounterName, number>>
  readonly gauges: Readonly<Record<GaugeName, number>>
}

export interface Metrics {
  inc(name: CounterName): void
  gauge(name: GaugeName, value: number): void
  snapshot(): MetricsSnapshot
}

export function createMetrics(): Metrics {
  const counters: Record<CounterName, number> = {
    enqueued: 0,
    completed: 0,
    failed: 0,
    shed: 0,
    signatureFailed: 0,
    deduped: 0,
    coalesced: 0,
    poolHits: 0,
    poolMisses: 0,
  }
  const gauges: Record<GaugeName, number> = {
    queueDepth: 0,
    activeRepos: 0,
    poolSize: 0,
    poolLeased: 0,
  }
  return {
    inc(name) {
      counters[name] += 1
    },
    gauge(name, value) {
      gauges[name] = value
    },
    snapshot() {
      return { counters: { ...counters }, gauges: { ...gauges } }
    },
  }
}

// ---------------------------------------------------------------------------
// Structured logging
//
// JSON lines, with the configured secret VALUES redacted from any field before
// serialization. The logger is defense-in-depth: callers are already required
// never to log a credential or repository content, but a secret that slips into
// a field is replaced with `[redacted]` rather than emitted.
// ---------------------------------------------------------------------------

export type LogLevel = 'info' | 'warn' | 'error'

export type LogFields = Readonly<Record<string, unknown>>

export interface Logger {
  info(fields: LogFields): void
  warn(fields: LogFields): void
  error(fields: LogFields): void
}

export interface LoggerOptions {
  /** Secret values to redact from any serialized field. */
  readonly redact?: readonly string[]
  readonly sink?: (line: string) => void
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const secrets = (options.redact ?? []).filter((secret) => secret !== '')
  const sink = options.sink ?? ((line: string) => {
    process.stderr.write(`${line}\n`)
  })

  function write(level: LogLevel, fields: LogFields): void {
    let line = JSON.stringify({ level, ...fields })
    for (const secret of secrets) {
      line = line.split(secret).join('[redacted]')
    }
    sink(line)
  }

  return {
    info: (fields) => write('info', fields),
    warn: (fields) => write('warn', fields),
    error: (fields) => write('error', fields),
  }
}

// ---------------------------------------------------------------------------
// Queue
//
// The queue is the backpressure boundary: same-repo tasks run serially (one
// workspace, no contention), cross-repo tasks run in parallel up to
// `maxConcurrentRepos`, and each repo's WAITING queue is capped at
// `maxQueuePerRepo`. A request that would overflow a repo's queue is shed (the
// caller gets an observable 503 + metric + log, never a silent drop).
//
// Idempotency: a `(forge, repo, delivery_id)` key is tracked while running AND
// after completion (in a bounded cache), so a forge redelivery executes at most
// once. A NEW event for the same MR/PR (different delivery id) may optionally
// coalesce with a still-queued older task via `coalesceKey`, replacing it.
// ---------------------------------------------------------------------------

export interface QueueTask {
  /** Dedupe key: `${forge}:${repo}:${deliveryId}`. */
  readonly key: string
  /** Queue partition: the repo. */
  readonly repo: string
  /** Same-MR/PR key: `${forge}:${repo}:${changeRequestId}`. */
  readonly coalesceKey?: string
  /** The enriched event payload handed to `runReview`. */
  readonly raw: unknown
}

export type EnqueueOutcome = 'accepted' | 'duplicate' | 'shed'

export interface QueueCallbacks {
  readonly onShed?: (task: QueueTask) => void
  readonly onDuplicate?: (task: QueueTask) => void
  readonly onCoalesced?: (repo: string, replaced: QueueTask) => void
  readonly onStarted?: (repo: string) => void
  readonly onFinished?: (repo: string, task: QueueTask, error: unknown) => void
}

export interface QueueOptions {
  readonly maxConcurrentRepos: number
  readonly maxQueuePerRepo: number
  readonly run: (task: QueueTask) => Promise<void>
  readonly callbacks?: QueueCallbacks
  readonly metrics?: Metrics
  /** Bound for the completed-key cache, so a long-lived daemon never grows unbounded. */
  readonly dedupeSize?: number
}

export interface Queue {
  enqueue(task: QueueTask): EnqueueOutcome
  /** Total WAITING tasks across all repos (running tasks excluded). */
  depth(): number
  /** Number of repos currently running a task. */
  active(): number
  /** Stop accepting, run out queued + in-flight tasks, resolve when empty. */
  drain(): Promise<void>
}

/** A FIFO set with a hard cap, evicting the oldest key when full. */
function createBoundedKeySet(maxSize: number): { has(key: string): boolean; add(key: string): void } {
  const keys = new Set<string>()
  return {
    has: (key) => keys.has(key),
    add: (key) => {
      if (keys.has(key)) {
        return
      }
      if (keys.size >= maxSize) {
        const oldest = keys.values().next().value
        if (oldest !== undefined) {
          keys.delete(oldest)
        }
      }
      keys.add(key)
    },
  }
}

export function createQueue(options: QueueOptions): Queue {
  const maxConcurrentRepos = Math.max(1, options.maxConcurrentRepos)
  const maxQueuePerRepo = Math.max(1, options.maxQueuePerRepo)
  const run = options.run
  const callbacks = options.callbacks ?? {}
  const metrics = options.metrics

  const completed = createBoundedKeySet(options.dedupeSize ?? 10_000)
  const inFlight = new Set<string>()
  const queues = new Map<string, QueueTask[]>()
  const active = new Set<string>()
  let accepting = true
  let waiters: Array<() => void> = []

  function waitingDepth(): number {
    let total = 0
    for (const list of queues.values()) {
      total += list.length
    }
    return total
  }

  function nextQueuedRepo(): string | undefined {
    for (const [repo, list] of queues) {
      // A repo already running stays serial: its queued tasks wait.
      if (list.length > 0 && !active.has(repo)) {
        return repo
      }
    }
    return undefined
  }

  function publishGauges(): void {
    metrics?.gauge('queueDepth', waitingDepth())
    metrics?.gauge('activeRepos', active.size)
  }

  function maybeResolveDrain(): void {
    if (!accepting && active.size === 0 && queues.size === 0) {
      const pending = waiters
      waiters = []
      for (const resolveWaiter of pending) {
        resolveWaiter()
      }
    }
  }

  function settle(repo: string, task: QueueTask, error: unknown): void {
    active.delete(repo)
    inFlight.delete(task.key)
    completed.add(task.key)
    if (error === undefined) {
      metrics?.inc('completed')
    } else {
      metrics?.inc('failed')
    }
    callbacks.onFinished?.(repo, task, error)
    publishGauges()
    pump()
    maybeResolveDrain()
  }

  function pump(): void {
    while (active.size < maxConcurrentRepos) {
      const repo = nextQueuedRepo()
      if (repo === undefined) {
        break
      }
      const list = queues.get(repo)!
      const task = list.shift()!
      if (list.length === 0) {
        queues.delete(repo)
      }
      active.add(repo)
      inFlight.add(task.key)
      publishGauges()
      callbacks.onStarted?.(repo)
      run(task).then(
        () => { settle(repo, task, undefined) },
        (error: unknown) => { settle(repo, task, error) },
      )
    }
  }

  function enqueue(task: QueueTask): EnqueueOutcome {
    if (!accepting) {
      metrics?.inc('shed')
      callbacks.onShed?.(task)
      return 'shed'
    }
    // Redelivery of a delivery id already running or completed: skip.
    if (inFlight.has(task.key) || completed.has(task.key)) {
      metrics?.inc('deduped')
      callbacks.onDuplicate?.(task)
      return 'duplicate'
    }

    // Coalesce: a NEW event for the same MR/PR replaces a still-queued older
    // task, so a burst of pushes does not grow a long, stale queue.
    if (task.coalesceKey !== undefined) {
      const list = queues.get(task.repo)
      if (list !== undefined) {
        const index = list.findIndex((queued) => queued.coalesceKey === task.coalesceKey)
        if (index !== -1) {
          const replaced = list[index]!
          list[index] = task
          // The superseded delivery id must not re-execute if the forge redelivers
          // it: without this, a redelivery of the coalesced-away id is seen as a
          // brand-new event (and would even re-coalesce over the newer task).
          completed.add(replaced.key)
          metrics?.inc('coalesced')
          callbacks.onCoalesced?.(task.repo, replaced)
          return 'accepted'
        }
      }
    }

    const list = queues.get(task.repo) ?? []
    if (list.length >= maxQueuePerRepo) {
      metrics?.inc('shed')
      callbacks.onShed?.(task)
      return 'shed'
    }
    list.push(task)
    queues.set(task.repo, list)
    metrics?.inc('enqueued')
    publishGauges()
    pump()
    return 'accepted'
  }

  function drain(): Promise<void> {
    accepting = false
    pump()
    if (active.size === 0 && queues.size === 0) {
      return Promise.resolve()
    }
    return new Promise((resolveWaiter) => {
      waiters.push(resolveWaiter)
    })
  }

  return {
    enqueue,
    depth: waitingDepth,
    active: () => active.size,
    drain,
  }
}

// ---------------------------------------------------------------------------
// Workspace pool
//
// A warm cache of git workspaces, one per repo, so the daemon does incremental
// `fetch` instead of a full clone per event. Leases are exclusive per repo
// (which matches the queue's per-repo serialization); on return the workspace
// is cleaned before re-caching so a prior run's dirty tree can never leak into
// the next run. The cache is LRU-bounded and evicts by destroying the oldest
// idle workspace.
//
// Isolation: every repo maps to a hash-derived root, and path joins are checked
// so a repo-relative path can never resolve outside its own workspace root.
// ---------------------------------------------------------------------------

export interface Workspace {
  readonly repo: string
  readonly root: string
}

export interface GitBackend {
  /** Full clone into a fresh workspace. Returns its root. */
  create(repo: string): Promise<string>
  /** Incremental fetch in an already-checked-out workspace. */
  refresh(root: string, repo: string): Promise<void>
  /** Remove leftover changes before reuse. */
  clean(root: string): Promise<void>
  /** Tear a workspace down on eviction / disposal. */
  destroy(root: string): Promise<void>
}

export interface Lease {
  readonly workspace: Workspace
  /** Return the workspace to the pool. Safe to call once; a second call is a no-op. */
  release(): Promise<void>
}

export interface WorkspacePoolOptions {
  readonly size: number
  readonly backend: GitBackend
  readonly metrics?: Metrics
  readonly now?: () => number
  readonly onEvict?: (repo: string) => void
}

export interface WorkspacePool {
  lease(repo: string): Promise<Lease>
  /** Cached (idle) workspace count. */
  cached(): number
  /** Leased (out) workspace count. */
  leased(): number
  dispose(): Promise<void>
}

/** Hash-derived workspace root: repo names cannot traverse the filesystem. */
export function deriveWorkspaceRoot(baseDir: string, repo: string): string {
  const digest = createHash('sha256').update(repo, 'utf8').digest('hex').slice(0, 32)
  return join(baseDir, digest)
}

/** Joins a repo-relative path under a workspace root, refusing escapes. */
export function resolveWithin(workspace: Workspace, relativePath: string): string {
  const root = normalize(workspace.root)
  const target = normalize(resolve(root, relativePath))
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`path '${excerpt(relativePath)}' escapes workspace root`)
  }
  return target
}

export function createWorkspacePool(options: WorkspacePoolOptions): WorkspacePool {
  const maxSize = Math.max(1, options.size)
  const backend = options.backend
  const metrics = options.metrics
  const now = options.now ?? (() => Date.now())
  const onEvict = options.onEvict

  interface Entry { readonly root: string; lastUsed: number }

  const cache = new Map<string, Entry>()
  const leased = new Map<string, string>()

  function publishGauges(): void {
    metrics?.gauge('poolSize', cache.size)
    metrics?.gauge('poolLeased', leased.size)
  }

  async function evictIfFull(): Promise<void> {
    while (cache.size > maxSize) {
      let oldestRepo: string | undefined
      let oldestUsed = Number.POSITIVE_INFINITY
      for (const [repo, entry] of cache) {
        if (entry.lastUsed < oldestUsed) {
          oldestUsed = entry.lastUsed
          oldestRepo = repo
        }
      }
      if (oldestRepo === undefined) {
        break
      }
      const entry = cache.get(oldestRepo)
      cache.delete(oldestRepo)
      if (entry !== undefined) {
        onEvict?.(oldestRepo)
        await backend.destroy(entry.root).catch(() => {})
      }
    }
    publishGauges()
  }

  async function lease(repo: string): Promise<Lease> {
    if (leased.has(repo)) {
      throw new Error(`workspace for '${repo}' is already leased`)
    }
    const cached = cache.get(repo)
    let root: string
    if (cached !== undefined) {
      cache.delete(repo)
      metrics?.inc('poolHits')
      await backend.refresh(cached.root, repo)
      root = cached.root
    } else {
      metrics?.inc('poolMisses')
      root = await backend.create(repo)
    }
    leased.set(repo, root)
    publishGauges()
    return {
      workspace: { repo, root },
      async release() {
        const current = leased.get(repo)
        if (current === undefined) {
          return
        }
        leased.delete(repo)
        try {
          await backend.clean(current)
        } catch {
          // A workspace that cannot be cleaned must not be re-cached dirty.
          await backend.destroy(current).catch(() => {})
          publishGauges()
          return
        }
        cache.set(repo, { root: current, lastUsed: now() })
        await evictIfFull()
      },
    }
  }

  async function dispose(): Promise<void> {
    const work: Array<Promise<void>> = []
    for (const [, entry] of cache) {
      work.push(backend.destroy(entry.root).catch(() => {}))
    }
    cache.clear()
    for (const [, root] of leased) {
      work.push(backend.destroy(root).catch(() => {}))
    }
    leased.clear()
    publishGauges()
    await Promise.all(work)
  }

  return {
    lease,
    cached: () => cache.size,
    leased: () => leased.size,
    dispose,
  }
}

// ---------------------------------------------------------------------------
// Git backend (runtime only)
//
// Shells out to `git` for the pool. Not unit-tested — it performs real I/O —
// but it is the one place `git` is invoked, and its `origin` resolver keeps the
// forge-specific clone URL out of the pool's pure logic.
// ---------------------------------------------------------------------------

export interface GitBackendOptions {
  readonly baseDir: string
  /** Maps a repo (`owner/name` or `namespace/project`) to a clone URL. */
  readonly origin: (repo: string) => string
}

export function createGitBackend(options: GitBackendOptions): GitBackend {
  const { baseDir, origin } = options

  function run(args: readonly string[], cwd?: string): Promise<void> {
    return new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk: unknown) => {
        stderr += String(chunk)
      })
      child.on('error', rejectRun)
      child.on('close', (code) => {
        if (code === 0) {
          resolveRun()
        } else {
          rejectRun(new Error(`git ${args.join(' ')} failed (${String(code ?? -1)}): ${excerpt(stderr)}`))
        }
      })
    })
  }

  return {
    async create(repo) {
      const root = deriveWorkspaceRoot(baseDir, repo)
      await mkdir(root, { recursive: true })
      await run(['clone', '--depth', '1', origin(repo), root])
      return root
    },
    async refresh(root, repo) {
      // Incremental fetch, then fast-forward the checked-out tree to it.
      await run(['fetch', '--depth', '1', 'origin', 'HEAD'], root)
      await run(['reset', '--hard', 'FETCH_HEAD'], root)
      void repo
    },
    async clean(root) {
      await run(['reset', '--hard', 'HEAD'], root)
      await run(['clean', '-fd'], root)
    },
    async destroy(root) {
      await rm(root, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
//
// The handler is a pure `(request) => response` function: the transport reads
// and bounds the body, and the handler enforces the daemon's security contract
// in a fixed order — verify signature, THEN parse, THEN dedupe/enqueue. A
// signature failure returns an empty body so the response cannot be used to
// enumerate why the request was rejected.
// ---------------------------------------------------------------------------

export const WEBHOOK_PATH = '/webhook'
export const HEALTH_PATH = '/healthz'
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

export interface HttpRequest {
  readonly method: string
  readonly path: string
  /** Lower-cased header names. */
  readonly headers: NormalizedHeaders
  readonly body: Uint8Array
}

export interface HttpResponse {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

export interface HandlerDeps {
  readonly secrets: Readonly<Record<string, string>>
  readonly queue: Queue
  readonly metrics: Metrics
  readonly logger: Logger
  readonly maxBodyBytes?: number
  readonly version?: string
}

export type Handler = (request: HttpRequest) => Promise<HttpResponse>

/** Lower-cases header names and takes the first value of a multi-value header. */
export function normalizeHeaders(
  raw: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [headerName, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue
    }
    out[headerName.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : value
  }
  return out
}

export function createHandler(deps: HandlerDeps): Handler {
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const version = deps.version ?? DAEMON_VERSION

  const empty = (status: number): HttpResponse => ({ status, body: '' })

  return async (request): Promise<HttpResponse> => {
    if (request.path === HEALTH_PATH) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ ok: true, version }),
      }
    }

    if (request.path !== WEBHOOK_PATH) {
      return { status: 404, body: 'not found' }
    }

    if (request.method !== 'POST') {
      return { status: 405, body: 'method not allowed' }
    }

    if (request.body.byteLength > maxBodyBytes) {
      return { status: 413, body: 'payload too large' }
    }

    // Signature FIRST, before the body is parsed or anything is enqueued.
    const forge = detectForge(request.headers)
    if (forge === undefined) {
      deps.metrics.inc('signatureFailed')
      deps.logger.warn({ event: 'signature-rejected', reason: 'no-recognized-signature-header' })
      return empty(401)
    }
    if (!verifySignature(forge, deps.secrets, request.headers, request.body)) {
      deps.metrics.inc('signatureFailed')
      deps.logger.warn({ event: 'signature-rejected', forge })
      return empty(401)
    }

    // Signature valid — now the payload is fair game.
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(request.body).toString('utf8'))
    } catch {
      deps.logger.warn({ event: 'invalid-payload', forge })
      return { status: 400, body: 'invalid payload' }
    }
    if (!isRecord(payload)) {
      deps.logger.warn({ event: 'invalid-payload', forge })
      return { status: 400, body: 'invalid payload' }
    }

    const deliveryId = deliveryIdFor(forge, request.headers)
    if (deliveryId === '') {
      deps.logger.warn({ event: 'missing-delivery-id', forge })
      return { status: 400, body: 'missing delivery id' }
    }

    const identity = readEventIdentity(forge, payload)
    const coalesceKey = identity.changeRequestId === undefined
      ? undefined
      : `${forge}:${identity.repo}:${identity.changeRequestId}`

    const outcome = deps.queue.enqueue({
      key: `${forge}:${identity.repo}:${deliveryId}`,
      repo: identity.repo,
      ...(coalesceKey === undefined ? {} : { coalesceKey }),
      raw: { ...payload, deliveryId, forge },
    })

    switch (outcome) {
      case 'accepted': return { status: 202, body: '' }
      case 'duplicate': return { status: 200, body: '' }
      case 'shed': return { status: 503, body: 'backpressure: request shed' }
    }
  }
}

// ---------------------------------------------------------------------------
// Transport (runtime only)
// ---------------------------------------------------------------------------

class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds the configured limit')
    this.name = 'BodyTooLargeError'
  }
}

/** Streams the request body, rejecting as soon as it exceeds the cap. */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.byteLength
    if (total > maxBytes) {
      throw new BodyTooLargeError()
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function handleHttp(
  req: IncomingMessage, res: ServerResponse, handler: Handler, maxBodyBytes: number,
): Promise<void> {
  try {
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?', 1)[0] ?? '/'
    const headers = normalizeHeaders(req.headers)
    const body = await readBody(req, maxBodyBytes)
    const response = await handler({ method, path, headers, body })
    res.writeHead(response.status, {
      'content-type': 'text/plain; charset=utf-8',
      ...response.headers,
    })
    res.end(response.body ?? '')
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('payload too large')
      return
    }
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('internal error')
  }
}

function startServer(
  handler: Handler, config: Config, maxBodyBytes: number,
): { stop: () => Promise<void> } {
  const server = createServer((req, res) => {
    void handleHttp(req, res, handler, maxBodyBytes)
  })
  server.listen(config.port, config.host)
  return {
    stop: () => new Promise<void>((resolveStop, rejectStop) => {
      server.close((error) => {
        if (error !== undefined) {
          rejectStop(error)
        } else {
          resolveStop()
        }
      })
      // Drop keep-alive/idle connections so `close()` settles promptly.
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
    }),
  }
}

// ---------------------------------------------------------------------------
// Plugin wiring
// ---------------------------------------------------------------------------

function workspaceBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSHRB_WORKSPACE_ROOT ?? join(tmpdir(), 'dshrb-workspaces')
}

function gitOrigin(env: NodeJS.ProcessEnv = process.env): (repo: string) => string {
  const template = env.DSHRB_GIT_ORIGIN ?? 'https://github.com/{repo}.git'
  return (repo) => template.replace('{repo}', repo)
}

/**
 * Wires the daemon together: an HTTP server feeding a bounded per-repo queue,
 * each task running `ctx.reviewRuntime.runReview` inside an exclusively leased
 * workspace. Everything is registered through `ctx.effect`, so unloading the
 * plugin stops the listener, drains the queue, and disposes the workspace pool —
 * no residual port or listener.
 */
export function apply(ctx: Context, config: Config): void {
  const reviewRuntime: ReviewRuntime = ctx.reviewRuntime
  const metrics = createMetrics()
  const logger = createLogger({ redact: Object.values(config.secrets) })

  const pool = createWorkspacePool({
    size: config.workspacePoolSize,
    backend: createGitBackend({
      baseDir: workspaceBaseDir(),
      origin: gitOrigin(),
    }),
    metrics,
    onEvict: (repo) => logger.info({ event: 'pool-evict', repo }),
  })

  const queue = createQueue({
    maxConcurrentRepos: config.maxConcurrentRepos,
    maxQueuePerRepo: config.maxQueuePerRepo,
    metrics,
    run: async (task) => {
      const lease = await pool.lease(task.repo)
      try {
        await reviewRuntime.runReview(task.raw)
      } finally {
        await lease.release()
      }
    },
    callbacks: {
      onShed: (task) => logger.warn({ event: 'shed', repo: task.repo }),
      onDuplicate: (task) => logger.info({ event: 'duplicate', repo: task.repo }),
      onCoalesced: (repo) => logger.info({ event: 'coalesced', repo }),
      onFinished: (repo, _task, error) => {
        if (error === undefined) {
          logger.info({ event: 'task-completed', repo })
        } else {
          logger.error({ event: 'task-failed', repo, message: (error as Error).message })
        }
      },
    },
  })

  const handler = createHandler({
    secrets: config.secrets,
    queue,
    metrics,
    logger,
    version: DAEMON_VERSION,
  })

  ctx.effect(() => {
    const { stop } = startServer(handler, config, DEFAULT_MAX_BODY_BYTES)
    return async () => {
      await stop()          // stop accepting new events
      await queue.drain()   // finish in-flight and queued tasks
      await pool.dispose()  // tear down workspaces
    }
  })
}
