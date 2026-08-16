import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  DEFAULT_MAX_BODY_BYTES, HEALTH_PATH, WEBHOOK_PATH,
  createHandler, createLogger, createMetrics, createQueue, createWorkspacePool,
  deliveryIdFor, deriveWorkspaceRoot, detectForge, normalizeHeaders, readEventIdentity,
  resolveWithin, timingSafeEqual, verifyGitLabToken, verifyHmacSha256, verifySignature,
} from '../src/index.ts'
import type { GitBackend, HttpRequest, QueueTask } from '../src/index.ts'

/** Flushes pending microtasks/macrotasks so a queued async worker can settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn!: () => void
  const promise = new Promise<void>((resolve) => { resolveFn = () => resolve() })
  return { promise, resolve: resolveFn }
}

// --- Signature ---------------------------------------------------------------

describe('timingSafeEqual', () => {
  it('compares equal-length strings and fails on any difference or length mismatch', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'ab')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(true)
  })
})

describe('verifyHmacSha256', () => {
  const body = Buffer.from('hello', 'utf8')
  const sig = createHmac('sha256', 'secret').update(body).digest('hex')

  it('accepts a valid HMAC-SHA256 signature', () => {
    expect(verifyHmacSha256('secret', body, `sha256=${sig}`)).toBe(true)
  })

  it('rejects a tampered body', () => {
    expect(verifyHmacSha256('secret', Buffer.from('HELLO', 'utf8'), `sha256=${sig}`)).toBe(false)
  })

  it('rejects the wrong algorithm, a malformed header, or a length mismatch', () => {
    expect(verifyHmacSha256('secret', body, `sha1=${sig}`)).toBe(false)
    expect(verifyHmacSha256('secret', body, '')).toBe(false)
    expect(verifyHmacSha256('secret', body, `sha256=${sig.slice(0, 63)}`)).toBe(false)
  })

  it('fails closed when no secret is configured', () => {
    expect(verifyHmacSha256('', body, `sha256=${sig}`)).toBe(false)
  })
})

describe('verifyGitLabToken', () => {
  it('verifies a token with constant-time equality', () => {
    expect(verifyGitLabToken('tok', 'tok')).toBe(true)
    expect(verifyGitLabToken('tok', 't0k')).toBe(false)
    expect(verifyGitLabToken('tok', 'tokk')).toBe(false)
    expect(verifyGitLabToken('', 'tok')).toBe(false)
    expect(verifyGitLabToken('tok', '')).toBe(false)
  })
})

describe('detectForge / deliveryIdFor / verifySignature', () => {
  it('detects the forge from its signature header only', () => {
    expect(detectForge({ 'x-hub-signature-256': 'sha256=x' })).toBe('github')
    expect(detectForge({ 'x-gitea-signature': 'sha256=x' })).toBe('gitea')
    expect(detectForge({ 'x-gitlab-token': 'x' })).toBe('gitlab')
    expect(detectForge({ 'user-agent': 'GitHub-Hookshot/abc' })).toBeUndefined()
  })

  it('reads the delivery id per forge', () => {
    expect(deliveryIdFor('github', { 'x-github-delivery': 'd1' })).toBe('d1')
    expect(deliveryIdFor('gitlab', { 'x-gitlab-event-uuid': 'u1' })).toBe('u1')
    expect(deliveryIdFor('gitea', { 'x-gitea-delivery': 'g1' })).toBe('g1')
    expect(deliveryIdFor('github', {})).toBe('')
  })

  it('dispatches to the forge algorithm and fails closed without a secret', () => {
    const body = Buffer.from('x', 'utf8')
    const sig = createHmac('sha256', 's').update(body).digest('hex')
    const secrets = { github: 's', gitea: 's', gitlab: 'tok' }
    expect(verifySignature('github', secrets, { 'x-hub-signature-256': `sha256=${sig}` }, body)).toBe(true)
    expect(verifySignature('gitea', secrets, { 'x-gitea-signature': `sha256=${sig}` }, body)).toBe(true)
    expect(verifySignature('gitlab', secrets, { 'x-gitlab-token': 'tok' }, body)).toBe(true)
    expect(verifySignature('gitlab', secrets, { 'x-gitlab-token': 'bad' }, body)).toBe(false)
    expect(verifySignature('github', {}, { 'x-hub-signature-256': `sha256=${sig}` }, body)).toBe(false)
  })
})

// --- Event identity ----------------------------------------------------------

describe('readEventIdentity', () => {
  it('reads repo and change-request id from a GitHub payload', () => {
    expect(readEventIdentity('github', {
      repository: { full_name: 'acme/widgets' },
      pull_request: { number: 7 },
    })).toEqual({ repo: 'acme/widgets', changeRequestId: '7' })
  })

  it('reads a check_run change-request id', () => {
    expect(readEventIdentity('github', {
      repository: { full_name: 'acme/widgets' },
      check_run: { pull_requests: [{ number: 9 }] },
    })).toEqual({ repo: 'acme/widgets', changeRequestId: '9' })
  })

  it('prefers the GitLab iid over the global id', () => {
    expect(readEventIdentity('gitlab', {
      project: { path_with_namespace: 'acme/widgets' },
      object_attributes: { iid: 3, id: 99 },
    })).toEqual({ repo: 'acme/widgets', changeRequestId: '3' })
  })

  it('falls back to an empty repo for unknown shapes', () => {
    expect(readEventIdentity('github', {})).toEqual({ repo: '' })
    expect(readEventIdentity('gitea', 'not an object')).toEqual({ repo: '' })
  })
})

// --- Metrics -----------------------------------------------------------------

describe('createMetrics', () => {
  it('counts and snapshots counters and gauges', () => {
    const metrics = createMetrics()
    metrics.inc('enqueued')
    metrics.inc('enqueued')
    metrics.inc('shed')
    metrics.gauge('queueDepth', 5)
    const snapshot = metrics.snapshot()
    expect(snapshot.counters.enqueued).toBe(2)
    expect(snapshot.counters.shed).toBe(1)
    expect(snapshot.gauges.queueDepth).toBe(5)
    expect(snapshot.counters.signatureFailed).toBe(0)
  })
})

// --- Logger ------------------------------------------------------------------

describe('createLogger', () => {
  it('redacts configured secret values from serialized fields', () => {
    const lines: string[] = []
    const logger = createLogger({ redact: ['topsecret'], sink: (line) => lines.push(line) })
    logger.info({ message: 'the secret is topsecret' })
    expect(lines[0]).toContain('[redacted]')
    expect(lines[0]).not.toContain('topsecret')
  })
})

// --- Queue -------------------------------------------------------------------

describe('createQueue', () => {
  it('runs same-repo tasks serially', async () => {
    const started: string[] = []
    const gates = new Map<string, () => void>()
    const queue = createQueue({
      maxConcurrentRepos: 2,
      maxQueuePerRepo: 16,
      run: async (task) => {
        started.push(String(task.raw))
        const gate = deferred()
        gates.set(task.key, gate.resolve)
        await gate.promise
      },
    })
    queue.enqueue({ key: 'g:r:d1', repo: 'r', raw: 'one' })
    queue.enqueue({ key: 'g:r:d2', repo: 'r', raw: 'two' })
    expect(started).toEqual(['one'])
    expect(queue.depth()).toBe(1)
    gates.get('g:r:d1')!()
    await tick()
    expect(started).toEqual(['one', 'two'])
    expect(queue.depth()).toBe(0)
  })

  it('runs different-repo tasks in parallel', () => {
    const started: string[] = []
    const queue = createQueue({
      maxConcurrentRepos: 4,
      maxQueuePerRepo: 16,
      run: async (task) => {
        started.push(String(task.raw))
        await new Promise<void>(() => {})
      },
    })
    queue.enqueue({ key: 'g:a:d1', repo: 'a', raw: 'a' })
    queue.enqueue({ key: 'g:b:d1', repo: 'b', raw: 'b' })
    expect(started).toEqual(['a', 'b'])
  })

  it('bounds cross-repo concurrency by maxConcurrentRepos', () => {
    const started: string[] = []
    const queue = createQueue({
      maxConcurrentRepos: 1,
      maxQueuePerRepo: 16,
      run: async (task) => {
        started.push(String(task.raw))
        await new Promise<void>(() => {})
      },
    })
    queue.enqueue({ key: 'g:a:d1', repo: 'a', raw: 'a' })
    queue.enqueue({ key: 'g:b:d1', repo: 'b', raw: 'b' })
    expect(started).toEqual(['a'])
    expect(queue.depth()).toBe(1)
  })

  it('sheds a request that overflows a repo queue without affecting other repos', () => {
    const started: string[] = []
    const queue = createQueue({
      maxConcurrentRepos: 1,
      maxQueuePerRepo: 1,
      run: async (task) => {
        started.push(String(task.raw))
        await new Promise<void>(() => {})
      },
    })
    expect(queue.enqueue({ key: 'g:a:d1', repo: 'a', raw: 'a1' })).toBe('accepted')
    expect(queue.enqueue({ key: 'g:a:d2', repo: 'a', raw: 'a2' })).toBe('accepted')
    expect(queue.enqueue({ key: 'g:a:d3', repo: 'a', raw: 'a3' })).toBe('shed')
    expect(queue.enqueue({ key: 'g:b:d1', repo: 'b', raw: 'b1' })).toBe('accepted')
    expect(started).toEqual(['a1'])
    expect(queue.depth()).toBe(2)
  })

  it('dedupes a redelivered delivery id while running and after completion', async () => {
    const started: string[] = []
    const gates = new Map<string, () => void>()
    const queue = createQueue({
      maxConcurrentRepos: 1,
      maxQueuePerRepo: 16,
      run: async (task) => {
        started.push(String(task.raw))
        const gate = deferred()
        gates.set(task.key, gate.resolve)
        await gate.promise
      },
    })
    expect(queue.enqueue({ key: 'g:r:d1', repo: 'r', raw: 'one' })).toBe('accepted')
    expect(queue.enqueue({ key: 'g:r:d1', repo: 'r', raw: 'one' })).toBe('duplicate')
    gates.get('g:r:d1')!()
    await tick()
    expect(queue.enqueue({ key: 'g:r:d1', repo: 'r', raw: 'one' })).toBe('duplicate')
    expect(started).toEqual(['one'])
  })

  it('coalesces a still-queued task for the same change request', () => {
    const started: string[] = []
    const queue = createQueue({
      maxConcurrentRepos: 1,
      maxQueuePerRepo: 16,
      run: async (task) => {
        started.push(String(task.raw))
        await new Promise<void>(() => {})
      },
    })
    queue.enqueue({ key: 'g:r:d1', repo: 'r', raw: 'a1', coalesceKey: 'g:r:7' })
    queue.enqueue({ key: 'g:r:d2', repo: 'r', raw: 'a2', coalesceKey: 'g:r:7' })
    queue.enqueue({ key: 'g:r:d3', repo: 'r', raw: 'a3', coalesceKey: 'g:r:7' })
    // a2 was replaced by a3, so the queue holds a single waiting task.
    expect(queue.depth()).toBe(1)
    expect(started).toEqual(['a1'])
  })

  it('dedupes a redelivery of a delivery id that was coalesced away', () => {
    const started: string[] = []
    const queue = createQueue({
      maxConcurrentRepos: 1,
      maxQueuePerRepo: 16,
      run: async (task) => {
        started.push(String(task.raw))
        await new Promise<void>(() => {})
      },
    })
    queue.enqueue({ key: 'g:r:d1', repo: 'r', raw: 'a1', coalesceKey: 'g:r:7' })
    queue.enqueue({ key: 'g:r:d2', repo: 'r', raw: 'a2', coalesceKey: 'g:r:7' })
    queue.enqueue({ key: 'g:r:d3', repo: 'r', raw: 'a3', coalesceKey: 'g:r:7' })
    // d2 was superseded; a forge redelivery of d2 must be a no-op, not re-insert
    // the stale event over the newer d3.
    expect(queue.enqueue({ key: 'g:r:d2', repo: 'r', raw: 'a2-again', coalesceKey: 'g:r:7' })).toBe('duplicate')
    expect(queue.depth()).toBe(1)
    expect(started).toEqual(['a1'])
  })

  it('drains queued and in-flight tasks, then rejects new work', async () => {
    const started: string[] = []
    const gates = new Map<string, () => void>()
    const queue = createQueue({
      maxConcurrentRepos: 1,
      maxQueuePerRepo: 16,
      run: async (task) => {
        started.push(String(task.raw))
        const gate = deferred()
        gates.set(task.key, gate.resolve)
        await gate.promise
      },
    })
    queue.enqueue({ key: 'g:r:d1', repo: 'r', raw: 'a1' })
    queue.enqueue({ key: 'g:r:d2', repo: 'r', raw: 'a2' })
    const drained = queue.drain()
    expect(queue.enqueue({ key: 'g:r:d3', repo: 'r', raw: 'a3' })).toBe('shed')
    gates.get('g:r:d1')!()
    await tick()
    gates.get('g:r:d2')!()
    await drained
    expect(started).toEqual(['a1', 'a2'])
  })
})

// --- Workspace pool ----------------------------------------------------------

function fakeBackend(): { backend: GitBackend; calls: string[] } {
  const calls: string[] = []
  const backend: GitBackend = {
    async create(repo) {
      calls.push(`create:${repo}`)
      return `/ws/${repo}`
    },
    async refresh(root, repo) {
      calls.push(`refresh:${repo}:${root}`)
    },
    async clean(root) {
      calls.push(`clean:${root}`)
    },
    async destroy(root) {
      calls.push(`destroy:${root}`)
    },
  }
  return { backend, calls }
}

describe('createWorkspacePool', () => {
  it('creates on a miss, cleans on return, and refreshes on a hit', async () => {
    const { backend, calls } = fakeBackend()
    const pool = createWorkspacePool({ size: 4, backend })
    const first = await pool.lease('a')
    expect(first.workspace.root).toBe('/ws/a')
    expect(calls).toContain('create:a')

    await first.release()
    expect(calls).toContain('clean:/ws/a')
    expect(pool.leased()).toBe(0)
    expect(pool.cached()).toBe(1)

    const second = await pool.lease('a')
    expect(second.workspace.root).toBe('/ws/a')
    expect(calls).toContain('refresh:a:/ws/a')
    expect(calls.filter((call) => call === 'create:a')).toHaveLength(1)
    await second.release()
  })

  it('evicts the least-recently-used workspace when the pool is full', async () => {
    const { backend, calls } = fakeBackend()
    const evicted: string[] = []
    const pool = createWorkspacePool({ size: 1, backend, onEvict: (repo) => evicted.push(repo) })
    const a = await pool.lease('a')
    await a.release()
    const b = await pool.lease('b')
    await b.release()
    expect(pool.cached()).toBe(1)
    expect(evicted).toEqual(['a'])
    expect(calls).toContain('destroy:/ws/a')
  })

  it('returns the workspace to the pool even when the task throws', async () => {
    const { backend } = fakeBackend()
    const pool = createWorkspacePool({ size: 2, backend })
    const lease = await pool.lease('a')
    await expect((async () => {
      try {
        throw new Error('boom')
      } finally {
        await lease.release()
      }
    })()).rejects.toThrow('boom')
    expect(pool.leased()).toBe(0)
    expect(pool.cached()).toBe(1)
  })

  it('destroys a workspace that cannot be cleaned instead of re-caching it dirty', async () => {
    const calls: string[] = []
    const backend: GitBackend = {
      async create(repo) {
        return `/ws/${repo}`
      },
      async refresh() {},
      async clean() {
        calls.push('clean')
        throw new Error('clean failed')
      },
      async destroy(root) {
        calls.push(`destroy:${root}`)
      },
    }
    const pool = createWorkspacePool({ size: 2, backend })
    const lease = await pool.lease('a')
    await lease.release()
    expect(pool.leased()).toBe(0)
    expect(pool.cached()).toBe(0)
    expect(calls).toContain('destroy:/ws/a')
  })

  it('refuses to lease the same repo twice', async () => {
    const { backend } = fakeBackend()
    const pool = createWorkspacePool({ size: 4, backend })
    await pool.lease('a')
    await expect(pool.lease('a')).rejects.toThrow(/already leased/)
  })

  it('disposes every cached and leased workspace', async () => {
    const { backend, calls } = fakeBackend()
    const pool = createWorkspacePool({ size: 4, backend })
    await (await pool.lease('a')).release()
    await pool.lease('b') // still leased at dispose time
    await pool.dispose()
    expect(calls).toContain('destroy:/ws/a')
    expect(calls).toContain('destroy:/ws/b')
    expect(pool.cached()).toBe(0)
    expect(pool.leased()).toBe(0)
  })
})

describe('workspace isolation', () => {
  it('derives distinct, traversal-free roots per repo', () => {
    const rootA = deriveWorkspaceRoot('/base', 'acme/widgets')
    const rootB = deriveWorkspaceRoot('/base', 'acme/gadgets')
    expect(rootA).not.toBe(rootB)
    expect(rootA).toContain('/base/')
    expect(rootA).not.toContain('..')
    expect(rootA.split('/').pop()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('resolves inside the root and refuses any escape', () => {
    const workspace = { repo: 'a', root: '/ws/a' }
    expect(resolveWithin(workspace, 'src/index.ts')).toBe('/ws/a/src/index.ts')
    expect(() => resolveWithin(workspace, '../b/x.ts')).toThrow(/escapes/)
    expect(() => resolveWithin(workspace, '/etc/passwd')).toThrow(/escapes/)
  })
})

// --- HTTP handler ------------------------------------------------------------

function githubRequest(body: string, deliveryId: string, secret = 's3cret'): HttpRequest {
  const bytes = Buffer.from(body, 'utf8')
  const sig = createHmac('sha256', secret).update(bytes).digest('hex')
  return {
    method: 'POST',
    path: WEBHOOK_PATH,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${sig}`,
      'x-github-delivery': deliveryId,
    },
    body: bytes,
  }
}

function makeHandler(options: {
  maxQueuePerRepo?: number
  run?: (task: QueueTask) => Promise<void>
} = {}): {
  handler: ReturnType<typeof createHandler>
  metrics: ReturnType<typeof createMetrics>
  queue: ReturnType<typeof createQueue>
  executed: Array<Record<string, unknown>>
  logs: string[]
} {
  const metrics = createMetrics()
  const executed: Array<Record<string, unknown>> = []
  const queue = createQueue({
    maxConcurrentRepos: 1,
    maxQueuePerRepo: options.maxQueuePerRepo ?? 16,
    metrics,
    run: options.run ?? (async (task) => { executed.push(task.raw as Record<string, unknown>) }),
  })
  const logs: string[] = []
  const handler = createHandler({
    secrets: { github: 's3cret', gitea: 'gitea-secret', gitlab: 'gitlab-token' },
    queue,
    metrics,
    logger: createLogger({ sink: (line) => logs.push(line) }),
  })
  return { handler, metrics, queue, executed, logs }
}

describe('createHandler', () => {
  it('serves a version-only health check without a signature', async () => {
    const { handler } = makeHandler()
    const response = await handler({ method: 'GET', path: HEALTH_PATH, headers: {}, body: new Uint8Array(0) })
    expect(response.status).toBe(200)
    const body = JSON.parse(response.body ?? '{}') as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.version).toBe('0.1.0')
    expect(response.body).not.toMatch(/queue|repo|secret|depth/)
  })

  it('rejects a bad signature with an empty body and does not enqueue', async () => {
    const { handler, metrics, executed } = makeHandler()
    const response = await handler({
      method: 'POST',
      path: WEBHOOK_PATH,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
        'x-github-delivery': 'd1',
      },
      body: Buffer.from('{"repository":{"full_name":"acme/w"},"pull_request":{"number":1}}', 'utf8'),
    })
    expect(response.status).toBe(401)
    expect(response.body).toBe('')
    expect(response.body).not.toMatch(/secret|signature|token|mismatch/)
    expect(executed).toHaveLength(0)
    expect(metrics.snapshot().counters.signatureFailed).toBe(1)
  })

  it('verifies the signature before parsing the payload', async () => {
    const { handler } = makeHandler()
    const response = await handler({
      method: 'POST',
      path: WEBHOOK_PATH,
      headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}`, 'x-github-delivery': 'd1' },
      body: Buffer.from('not json at all', 'utf8'),
    })
    // A bad signature is 401, not a parse error (400).
    expect(response.status).toBe(401)
    expect(response.body).toBe('')
  })

  it('rejects an oversized body directly with 413', async () => {
    const { handler } = makeHandler()
    const response = await handler({
      method: 'POST',
      path: WEBHOOK_PATH,
      headers: { 'x-hub-signature-256': 'sha256=00' },
      body: new Uint8Array(DEFAULT_MAX_BODY_BYTES + 1),
    })
    expect(response.status).toBe(413)
  })

  it('accepts a valid GitHub event, tags it with forge + delivery id, and enqueues it', async () => {
    const { handler, executed, queue } = makeHandler()
    const response = await handler(githubRequest(
      '{"repository":{"full_name":"acme/widgets"},"pull_request":{"number":7}}', 'delivery-1',
    ))
    expect(response.status).toBe(202)
    await tick()
    expect(executed).toHaveLength(1)
    expect(executed[0]!.deliveryId).toBe('delivery-1')
    expect(executed[0]!.forge).toBe('github')
    expect(queue.depth()).toBe(0)
  })

  it('dedupes a duplicate delivery as a 200 no-op', async () => {
    const { handler, executed } = makeHandler()
    const body = '{"repository":{"full_name":"acme/widgets"},"pull_request":{"number":7}}'
    expect((await handler(githubRequest(body, 'delivery-1'))).status).toBe(202)
    expect((await handler(githubRequest(body, 'delivery-1'))).status).toBe(200)
    await tick()
    expect(executed).toHaveLength(1)
  })

  it('returns 503 when a repo queue overflows (backpressure)', async () => {
    const { handler, metrics } = makeHandler({
      maxQueuePerRepo: 1,
      run: async () => { await new Promise<void>(() => {}) },
    })
    // Distinct change requests so coalesce does not absorb them; the third
    // request overflows the repo's single-slot queue and is shed.
    const body = (number: number): string =>
      `{"repository":{"full_name":"acme/widgets"},"pull_request":{"number":${number}}}`
    expect((await handler(githubRequest(body(1), 'd1'))).status).toBe(202)
    expect((await handler(githubRequest(body(2), 'd2'))).status).toBe(202)
    expect((await handler(githubRequest(body(3), 'd3'))).status).toBe(503)
    expect(metrics.snapshot().counters.shed).toBe(1)
  })

  it('rejects a valid-signature request missing a delivery id', async () => {
    const { handler } = makeHandler()
    const bytes = Buffer.from('{"repository":{"full_name":"acme/w"}}', 'utf8')
    const sig = createHmac('sha256', 's3cret').update(bytes).digest('hex')
    const response = await handler({
      method: 'POST',
      path: WEBHOOK_PATH,
      headers: { 'x-hub-signature-256': `sha256=${sig}` },
      body: bytes,
    })
    expect(response.status).toBe(400)
    expect(response.body).toBe('missing delivery id')
  })

  it('verifies GitLab and Gitea signatures', async () => {
    const { handler, executed } = makeHandler()
    const body = '{"project":{"path_with_namespace":"acme/widgets"},"object_attributes":{"iid":2}}'
    const bytes = Buffer.from(body, 'utf8')

    const giteaSig = createHmac('sha256', 'gitea-secret').update(bytes).digest('hex')
    const gitea = await handler({
      method: 'POST',
      path: WEBHOOK_PATH,
      headers: { 'x-gitea-signature': `sha256=${giteaSig}`, 'x-gitea-delivery': 'g1' },
      body: bytes,
    })
    expect(gitea.status).toBe(202)

    const gitlab = await handler({
      method: 'POST',
      path: WEBHOOK_PATH,
      headers: { 'x-gitlab-token': 'gitlab-token', 'x-gitlab-event-uuid': 'u1' },
      body: bytes,
    })
    expect(gitlab.status).toBe(202)

    const badGitlab = await handler({
      method: 'POST',
      path: WEBHOOK_PATH,
      headers: { 'x-gitlab-token': 'wrong', 'x-gitlab-event-uuid': 'u2' },
      body: bytes,
    })
    expect(badGitlab.status).toBe(401)

    await tick()
    expect(executed).toHaveLength(2)
  })

  it('returns 404 for unknown paths and 405 for non-POST webhook requests', async () => {
    const { handler } = makeHandler()
    expect((await handler({ method: 'GET', path: '/nope', headers: {}, body: new Uint8Array(0) })).status).toBe(404)
    expect((await handler({ method: 'GET', path: WEBHOOK_PATH, headers: {}, body: new Uint8Array(0) })).status).toBe(405)
  })
})

// --- Header normalization ----------------------------------------------------

describe('normalizeHeaders', () => {
  it('lower-cases names and takes the first value of a multi-value header', () => {
    expect(normalizeHeaders({
      'X-Hub-Signature-256': 'a',
      'X-GitHub-Delivery': ['d1', 'd2'],
      'X-Unset': undefined,
    })).toEqual({ 'x-hub-signature-256': 'a', 'x-github-delivery': 'd1' })
  })
})
