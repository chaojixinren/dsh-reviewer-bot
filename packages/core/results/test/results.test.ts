import { Context, symbols } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { apply, normalizeEnvelope, type ReviewRun } from '../src/index.ts'
import { TYPERT } from '../src/typert.ts'

/** A representative `result-json` envelope (driver-action#buildResultJson). */
function sampleEnvelope() {
  return {
    schemaVersion: 1,
    status: 'success',
    policy: { trustLevel: 'trusted-read', capabilities: null },
    operation: 'review',
    forge: 'github',
    findings: {
      items: [
        { findingId: 'f1', severity: 'blocker', title: 'SQL injection', body: 'x', anchor: { path: 'a.ts', line: 10, side: 'right', anchored: true }, ruleId: 'sec-sql' },
        { findingId: 'f2', severity: 'minor', title: 'Naming', anchor: { path: 'b.ts', line: 3, side: 'right', anchored: true }, ruleId: 'style' },
        { findingId: 'f3', severity: 'minor', title: 'Naming2', anchor: { path: 'c.ts', line: 5, side: 'right', anchored: true }, ruleId: 'style' },
      ],
      discarded: [
        { findingId: 'd1', severity: 'info', title: 'Trivial', anchor: { path: 'x.ts', line: 1, side: 'right', anchored: false } },
      ],
      suppressed: [
        { findingId: 's1', severity: 'nit', title: 'Known', anchor: { path: 'y.ts', line: 2, side: 'right', anchored: true }, ruleId: 'style' },
      ],
    },
    write: { appliedPatches: [], commitSha: undefined, pullRequestUrl: undefined },
    failure: null,
    replay: null,
    rules: [],
    timing: { durationMs: 1234 },
  }
}

describe('@dshrb/results review-results store + browser remote', () => {
  it('normalizes a result-json envelope into a render-ready run', () => {
    const run = normalizeEnvelope(sampleEnvelope())
    expect(run.schemaVersion).toBe(1)
    expect(run.status).toBe('success')
    expect(run.trustLevel).toBe('trusted-read')
    expect(run.summary.total).toBe(3)
    expect(run.summary.bySeverity).toEqual({ blocker: 1, minor: 2 })
    expect(run.summary.byRule).toEqual({ 'sec-sql': 1, style: 2 })
    expect(run.summary.suppressed).toBe(1)
    expect(run.summary.discarded).toBe(1)
    expect(run.findings).toHaveLength(3)
    expect(run.findings[0]!.path).toBe('a.ts')
    expect(run.findings[0]!.line).toBe(10)
    expect(run.suppressed).toHaveLength(1)
    expect(run.discarded).toHaveLength(1)
    expect(run.timing?.durationMs).toBe(1234)
  })

  it('also tolerates a replay snapshot (version + flat findings)', () => {
    const run = normalizeEnvelope({
      version: 3,
      status: 'neutral',
      findings: [
        { findingId: 'r1', severity: 'major', title: 'T', anchor: { path: 'p.ts', line: 1, side: 'right', anchored: true } },
      ],
    })
    expect(run.schemaVersion).toBe(0)
    expect(run.summary.total).toBe(1)
    expect(run.summary.bySeverity.major).toBe(1)
  })

  it('normalizes a version-only replay snapshot (empty findings) as a zero run', () => {
    const run = normalizeEnvelope({ version: 5, status: 'neutral' })
    expect(run.schemaVersion).toBe(0)
    expect(run.summary.total).toBe(0)
    expect(run.findings).toHaveLength(0)
    expect(run.suppressed).toHaveLength(0)
    expect(run.discarded).toHaveLength(0)
  })

  it('normalizes a legacy flat-findings envelope (no schemaVersion/version)', () => {
    const run = normalizeEnvelope({
      status: 'neutral',
      findings: [
        { findingId: 'l1', severity: 'major', title: 'T', anchor: { path: 'p.ts', line: 1, side: 'right', anchored: true } },
        { findingId: 'l2', severity: 'minor', title: 'N', anchor: { path: 'q.ts', line: 2, side: 'right', anchored: true }, ruleId: 'style' },
      ],
      discarded: [
        { findingId: 'd1', severity: 'info', title: 'I', anchor: { path: 'r.ts', line: 3, side: 'right', anchored: false } },
      ],
    })
    expect(run.schemaVersion).toBe(0)
    expect(run.summary.total).toBe(2)
    expect(run.summary.bySeverity).toEqual({ major: 1, minor: 1 })
    expect(run.summary.discarded).toBe(1)
    expect(run.findings).toHaveLength(2)
  })

  it('normalizes failure/write/replay/rules and tolerates timing: null', () => {
    const run = normalizeEnvelope({
      schemaVersion: 1,
      status: 'failure',
      operation: 'review',
      forge: 'github',
      findings: {
        items: [
          { findingId: 'f1', severity: 'blocker', title: 'Boom', anchor: { path: 'a.ts', line: 1, side: 'right', anchored: true } },
        ],
        discarded: [],
        suppressed: [],
      },
      write: { appliedPatches: 2, commitSha: 'abc123', pullRequestUrl: 'https://github.com/x/y/pull/1' },
      failure: { code: 'review-failed', phase: 'analyze', title: 'Review failed', message: 'see logs', guidance: 'retry', retryable: true },
      replay: 'run-42',
      rules: [{ id: 'r1' }],
      timing: null,
    })
    expect(run.status).toBe('failure')
    expect(run.operation).toBe('review')
    expect(run.forge).toBe('github')
    expect(run.write).toBeDefined()
    expect(run.write!.appliedPatches).toBe(2)
    expect(run.write!.commitSha).toBe('abc123')
    expect(run.write!.pullRequestUrl).toBe('https://github.com/x/y/pull/1')
    expect(run.failure).toBeDefined()
    expect(run.failure!.code).toBe('review-failed')
    expect(run.failure!.retryable).toBe(true)
    expect(run.replay).toBe('run-42')
    expect(run.rules).toEqual([{ id: 'r1' }])
    // `timing: null` must be tolerated (typeof null === 'object') and left unset.
    expect(run.timing).toBeUndefined()
    expect(run.summary.total).toBe(1)
  })

  it('tolerates sparse / malformed findings with safe fallbacks', () => {
    const run = normalizeEnvelope({
      schemaVersion: 1,
      status: 'success',
      findings: {
        items: [
          { severity: 'blocker', title: 'Real', anchor: { path: 'a.ts', line: 1, side: 'right', anchored: true }, ruleId: 'sec' },
          { severity: 'bogus', title: 'Bad severity', anchor: { path: 'b.ts', line: 2, side: 'right', anchored: true }, ruleId: 'sec' },
          { title: 'No severity, no ruleId' },
          {},
        ],
        discarded: [],
        suppressed: [],
      },
    })
    expect(run.summary.total).toBe(4)
    expect(run.summary.bySeverity).toEqual({ blocker: 1, info: 3 })
    // missing / invalid ruleId collapses to 'untagged'
    expect(run.summary.byRule).toEqual({ sec: 2, untagged: 2 })
    // invalid severity falls back to 'info'; missing title falls back to ''
    expect(run.findings[1]!.severity).toBe('info')
    expect(run.findings[3]!.title).toBe('')
  })

  it('throws on an unrecognizable envelope', () => {
    expect(() => normalizeEnvelope({ hello: 'world' })).toThrow()
    expect(() => normalizeEnvelope(null)).toThrow()
  })

  it('exposes list/get/ingest/clear through ctx.results', () => {
    const root = new Context()
    apply(root)

    expect(root.get('results')).toBeDefined()
    const res = root.results.ingest(sampleEnvelope())
    expect(typeof res.id).toBe('string')

    const list = root.results.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.total).toBe(3)
    expect(list[0]!.blockers).toBe(1)
    expect(list[0]!.writeRequested).toBe(false)

    const full = root.results.get(res.id)
    expect(full?.summary.byRule.style).toBe(2)

    expect(root.results.get('nope')).toBeUndefined()
    root.results.clear(res.id)
    expect(root.results.list()).toHaveLength(0)
  })

  it('round-trips through the Typert Remote gateway', () => {
    const root = new Context()
    apply(root)

    const gateway = root.get('dshrbResultsRemote')
    expect(gateway).toBeDefined()

    const res = gateway.submitResult(sampleEnvelope())
    expect(typeof res.id).toBe('string')

    const full = gateway.getResult(res.id)
    expect(full).not.toBeNull()
    expect((full as ReviewRun).summary.total).toBe(3)

    expect(gateway.listResults()).toHaveLength(1)

    gateway.clearResults(res.id)
    expect(gateway.getResult(res.id)).toBeNull()
    expect(gateway.getResult('does-not-exist')).toBeNull()
  })

  it('gateway clear-all (no id) empties the store and rejects malformed envelopes', () => {
    const root = new Context()
    apply(root)
    const gateway = root.get('dshrbResultsRemote')
    gateway.submitResult(sampleEnvelope())
    expect(gateway.listResults()).toHaveLength(1)
    gateway.clearResults() // no id -> clear all
    expect(gateway.listResults()).toHaveLength(0)
    expect(() => gateway.submitResult({ not: 'a result' })).toThrow()
  })

  it('evicts the oldest run past maxRuns', () => {
    const root = new Context()
    apply(root, { maxRuns: 2 })
    const a = root.results.ingest({ schemaVersion: 1, status: 'neutral', findings: { items: [] } })
    root.results.ingest({ schemaVersion: 1, status: 'neutral', findings: { items: [] } })
    root.results.ingest({ schemaVersion: 1, status: 'neutral', findings: { items: [] } })
    const ids = root.results.list().map((r) => r.id)
    expect(ids).toHaveLength(2)
    expect(ids).not.toContain(a.id)
  })

  it('notifies watchers on ingest/clear and stops after unsubscribe', () => {
    const root = new Context()
    apply(root)
    const lengths: number[] = []
    const off = root.results.watch((list) => { lengths.push(list.length) })
    root.results.ingest(sampleEnvelope())
    root.results.ingest(sampleEnvelope())
    root.results.clear() // clear-all (no id)
    off()
    root.results.ingest(sampleEnvelope()) // after unsubscribe: no notify
    expect(lengths).toEqual([1, 2, 0])
  })

  it('carries a Typert binding the api-gateway validates', () => {
    const root = new Context()
    apply(root)

    const receiver = root.get('dshrbResultsRemote')
    const original = Reflect.get(receiver, symbols.original) ?? receiver
    const binding = receiver.typertRemote

    expect(binding.service).toBe(original)
    expect(binding.serviceKey).toBe('dshrbResultsRemote')
    expect(binding.namespace).toBe('dshrbResults')

    const methods = remoteMethods(original)
    expect(methods.map((m) => m.exportName ?? m.method).sort()).toEqual(
      ['clearResults', 'getResult', 'listResults', 'submitResult'].sort(),
    )
  })

  it('declares the four invocations under the dshrbResults wire namespace', () => {
    expect(TYPERT.face).toBe('host')
    expect(TYPERT.invocations).toHaveLength(4)
    const byMethod = new Map(TYPERT.invocations.map((i) => [i.method, i]))
    for (const method of ['listResults', 'getResult', 'submitResult', 'clearResults']) {
      const invocation = byMethod.get(method)
      expect(invocation?.service).toBe('dshrbResultsRemote')
      expect(invocation?.namespace).toBe('dshrbResults')
      expect(invocation?.invocation).toEqual({ kind: 'direct' })
    }
  })
})
