import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { commitSha, findingId, requestId, ruleId } from '@dshrb/review-core'
import type { ReviewResult } from '@dshrb/review-core'
import { createReviewRuleRegistry } from '@dshrb/rule-registry'
import type { RulePack } from '@dshrb/rule-registry'
import type { ReplaySnapshot } from '@dshrb/review-runtime'
import {
  CliError, collectDoctorChecks, doctor, main, parseArgs, renderDoctor, renderRules,
  renderToTty, replay, reviewLocal, rulesExplain,
} from '../src/index.ts'
import type { CliDeps } from '../src/index.ts'

// --- fixtures ---------------------------------------------------------------

const BASE_SHA = 'a'.repeat(40)

/** A committed v1 snapshot; the cross-version read fixture (docs/07 line 179). */
function fixtureSnapshot(): unknown {
  const url = new URL('./fixtures/snapshot-v1.json', import.meta.url)
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as unknown
}

const DIFF = [
  'diff --git a/src/index.ts b/src/index.ts',
  'index 111..222 100644',
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
].join('\n')

function resultFixture(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    requestId: requestId('evt-1'),
    verdict: { status: 'success', findingsCount: 1, blockersCount: 0, durationMs: 5 },
    findings: [],
    discarded: [],
    ...over,
  }
}

// --- parseArgs --------------------------------------------------------------

describe('parseArgs', () => {
  it('parses the four subcommands and their options', () => {
    expect(parseArgs(['review', '--local'])).toEqual({ command: 'review', local: true })
    expect(parseArgs(['review', '--pr', '42'])).toEqual({ command: 'review', pr: '42' })
    expect(parseArgs(['review', '--pr=42'])).toEqual({ command: 'review', pr: '42' })
    expect(parseArgs(['replay', 'abc123'])).toEqual({ command: 'replay', runId: 'abc123' })
    expect(parseArgs(['rules', '--explain', 'src/a.ts'])).toEqual({ command: 'rules', explain: 'src/a.ts' })
    expect(parseArgs(['doctor'])).toEqual({ command: 'doctor' })
    expect(parseArgs(['review', '--local', '--json'])).toEqual({ command: 'review', local: true, json: true })
  })

  it('rejects invalid input with a clear error instead of crashing', () => {
    expect(() => parseArgs([])).toThrow(CliError)
    expect(() => parseArgs(['bogus'])).toThrow(/unknown command 'bogus'/)
    expect(() => parseArgs(['review'])).toThrow(/requires --local or --pr/)
    expect(() => parseArgs(['review', '--local', '--pr', '1'])).toThrow(/not both/)
    expect(() => parseArgs(['replay'])).toThrow(/requires a <run-id>/)
    expect(() => parseArgs(['replay', 'a', 'b'])).toThrow(/exactly one <run-id>/)
    expect(() => parseArgs(['rules'])).toThrow(/requires --explain/)
    expect(() => parseArgs(['rules', '--local'])).toThrow(/--local is only valid with `review`/)
    expect(() => parseArgs(['doctor', '--explain', 'x'])).toThrow(/--explain is only valid with `rules`/)
    expect(() => parseArgs(['doctor', 'stray'])).toThrow(/unexpected argument 'stray'/)
    expect(() => parseArgs(['review', '--unknown'])).toThrow(/unknown option '--unknown'/)
    expect(() => parseArgs(['review', '--pr'])).toThrow(/--pr requires a value/)
  })
})

// --- renderToTty ------------------------------------------------------------

describe('renderToTty', () => {
  it('renders findings, discarded entries, replay id, and failure', () => {
    const output = renderToTty(resultFixture({
      operation: 'review',
      replayId: 'replay-1',
      findings: [{
        findingId: findingId('f-1'),
        severity: 'major',
        title: 'loose equality',
        body: 'use strict equality',
        anchor: { path: 'src/index.ts', line: 2, side: 'right', anchored: true },
      }],
      discarded: [{ reason: 'missing-title', rawTitle: 'nope' }],
      failure: { code: 'E_DENIED', phase: 'authorize', title: 'denied', message: 'fork PR', guidance: 'n/a', retryable: false },
    }))

    expect(output).toContain('review — success')
    expect(output).toContain('replay: replay-1')
    expect(output).toContain('[major] src/index.ts:2 — loose equality')
    expect(output).toContain('missing-title — nope')
    expect(output).toContain('failure [E_DENIED] authorize: fork PR')
  })

  it('renders a non-fatal snapshot failure as a warning, not a failed run', () => {
    const output = renderToTty(resultFixture({
      operation: 'review',
      snapshotError: 'disk full',
    }))

    expect(output).toContain('snapshot: unavailable — disk full')
    expect(output).not.toContain('failure [')
  })
})

// --- replay -----------------------------------------------------------------

describe('replay', () => {
  it('rebuilds a ReviewResult from a v1 snapshot fixture', async () => {
    const result = await replay('fixture-00000001', async () => fixtureSnapshot())

    expect(result.requestId).toBe('fixture-request')
    expect(result.verdict).toEqual({ status: 'success', findingsCount: 2, blockersCount: 1, durationMs: 0 })
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0]?.title).toBe('Null dereference')
    expect(result.findings[1]?.severity).toBe('blocker')
    expect(result.discarded).toHaveLength(1)
    expect(result.replayId).toBe('fixture-00000001')
  })

  it('rejects a finding that fails findingInvariantViolation', async () => {
    const corrupt = JSON.parse(JSON.stringify(fixtureSnapshot())) as { findings: Array<Record<string, unknown>> }
    corrupt.findings[0] = { ...corrupt.findings[0], title: '' }
    await expect(replay('x', async () => corrupt)).rejects.toThrow(/empty title/)
  })

  it('rejects a snapshot from a future version with an upgrade hint', async () => {
    const future = { ...JSON.parse(JSON.stringify(fixtureSnapshot())) as Record<string, unknown>, version: 2 }
    await expect(replay('x', async () => future)).rejects.toThrow(/newer than this build supports/)
  })
})

// --- rules --explain --------------------------------------------------------

describe('rulesExplain', () => {
  function packFixture(id: string, version: string, title: string): RulePack {
    return {
      id,
      version,
      title,
      rules: [{
        id: ruleId(`${id}/rule`),
        severity: 'major',
        applies: ['src/**'],
        guidance: `${id} guidance`,
        requiresScenario: false,
      }],
    }
  }

  it('lists the effective rules and the pack each came from', () => {
    const registry = createReviewRuleRegistry({ disabled: [], minSeverity: 'minor' })
    registry.register(packFixture('pack-a', '1.0.0', 'Pack A'))
    registry.register(packFixture('pack-b', '2.0.0', 'Pack B'))

    const explanation = rulesExplain('src/index.ts', registry)

    expect(explanation.path).toBe('src/index.ts')
    expect(explanation.packs).toEqual([
      { id: 'pack-a', version: '1.0.0', title: 'Pack A' },
      { id: 'pack-b', version: '2.0.0', title: 'Pack B' },
    ])
    expect(explanation.rules).toEqual([
      { id: 'pack-a/rule', severity: 'major', pack: 'pack-a', guidance: 'pack-a guidance' },
      { id: 'pack-b/rule', severity: 'major', pack: 'pack-b', guidance: 'pack-b guidance' },
    ])
    expect(renderRules(explanation)).toContain('(from pack-a)')
  })
})

// --- doctor -----------------------------------------------------------------

describe('doctor', () => {
  it('never prints a secret value', () => {
    const checks = collectDoctorChecks({
      DEEPSEEK_API_KEY: 'sk-super-secret-123',
      FORGE_TOKEN: 'ghp_forge_secret_456',
      GITHUB_TOKEN: 'ghp_github_secret_789',
    }, () => true)

    const report = doctor(checks)
    const rendered = renderDoctor(report)

    expect(rendered).not.toContain('sk-super-secret-123')
    expect(rendered).not.toContain('ghp_forge_secret_456')
    expect(rendered).not.toContain('ghp_github_secret_789')
    expect(rendered).toContain('DeepSeek API key')
    expect(report.healthy).toBe(true)
  })

  it('flags missing credentials and an invalid config as unhealthy', () => {
    const report = doctor([
      { name: 'repo config', present: true },
      { name: 'GitHub token', present: false },
      { name: 'forge token', present: true, valid: false },
    ])
    expect(report.healthy).toBe(false)
    expect(report.checks.map((check) => check.status)).toEqual(['ok', 'missing', 'error'])
  })
})

// --- review --local ---------------------------------------------------------

describe('reviewLocal', () => {
  it('runs the pipeline through forge-local and writes a snapshot', async () => {
    const written: ReplaySnapshot[] = []
    const comments: string[] = []

    const result = await reviewLocal({
      repo: 'acme/widgets',
      baseSha: commitSha(BASE_SHA),
      headSha: commitSha(BASE_SHA),
      git: async (args) => {
        expect(args[0]).toBe('diff')
        return DIFF
      },
      readFile: async () => 'content',
      write: (line) => {
        comments.push(line)
      },
      runAgent: async () => [{
        severity: 'major',
        title: 'loose equality',
        body: 'use strict equality',
        path: 'src/index.ts',
        line: 2,
      }],
      writeSnapshot: async (snapshot) => {
        written.push(snapshot)
      },
      now: () => 1234,
    })

    expect(result.verdict.status).toBe('success')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.title).toBe('loose equality')
    expect(result.replayId).toBeTruthy()
    expect(written).toHaveLength(1)
    expect(written[0]?.version).toBe(1)
    expect(written[0]?.findings).toHaveLength(1)
    // forge-local's "comments" are printed to the terminal rather than posted.
    expect(comments.some((line) => line.includes('[dshrb:local]'))).toBe(true)
  })

  it('skips the snapshot when no writer is supplied', async () => {
    const result = await reviewLocal({
      repo: 'acme/widgets',
      baseSha: commitSha(BASE_SHA),
      headSha: commitSha(BASE_SHA),
      git: async () => DIFF,
      readFile: async () => 'content',
      write: () => {},
      runAgent: async () => [{
        severity: 'major',
        title: 'loose equality',
        body: 'use strict equality',
        path: 'src/index.ts',
        line: 2,
      }],
    })

    expect(result.verdict.status).toBe('success')
    expect(result.replayId).toBeUndefined()
  })
})

// --- main -------------------------------------------------------------------

describe('main', () => {
  function makeDeps(over: Partial<CliDeps> = {}): { deps: CliDeps; stdout: string[]; stderr: string[] } {
    const stdout: string[] = []
    const stderr: string[] = []
    const registry = createReviewRuleRegistry({ disabled: [], minSeverity: 'minor' })
    const deps: CliDeps = {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      readSnapshot: async () => fixtureSnapshot(),
      registry,
      doctorChecks: [{ name: 'repo config', present: true }],
      review: async () => resultFixture(),
      ...over,
    }
    return { deps, stdout, stderr }
  }

  it('returns 2 and no stack for a usage error', async () => {
    const { deps, stderr } = makeDeps()
    const code = await main(['bogus'], deps)
    expect(code).toBe(2)
    expect(stderr.join('\n')).toContain("unknown command 'bogus'")
    expect(stderr.join('\n')).not.toContain('at ')
  })

  it('returns 0 for a successful review and 1 for a failed one', async () => {
    const ok = makeDeps()
    expect(await main(['review', '--local'], ok.deps)).toBe(0)

    const failed = makeDeps({
      review: async () => resultFixture({ verdict: { status: 'failed', findingsCount: 0, blockersCount: 0, durationMs: 0 } }),
    })
    expect(await main(['review', '--local'], failed.deps)).toBe(1)
  })

  it('renders JSON when --json is set', async () => {
    const { deps, stdout } = makeDeps()
    await main(['review', '--local', '--json'], deps)
    expect(JSON.parse(stdout.join('\n'))).toHaveProperty('verdict')
  })

  it('returns 1 when doctor reports unhealthy', async () => {
    const { deps } = makeDeps({ doctorChecks: [{ name: 'GitHub token', present: false }] })
    expect(await main(['doctor'], deps)).toBe(1)
  })
})
