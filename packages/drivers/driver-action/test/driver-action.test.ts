import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commentId, commitSha, forgeId, requestId,
} from '@dshrb/review-core'
import type { ReviewResult } from '@dshrb/review-core'
import { buildOutputs, buildResultJson, readEventPayload, readInputs, writeOutputs } from '../src/index.ts'
import { InputError } from '../src/index.ts'

// --- readInputs -------------------------------------------------------------

describe('readInputs', () => {
  it('requires the deepseek api key', () => {
    expect(() => readInputs({})).toThrow(InputError)
    expect(() => readInputs({})).toThrow(/deepseek-api-key/)
  })

  it('parses every input from the INPUT_* environment', () => {
    const inputs = readInputs({
      INPUT_DEEPSEEK_API_KEY: 'sk-123',
      INPUT_GITHUB_TOKEN: 'gh-token',
      INPUT_ALLOW_WRITE: 'true',
      INPUT_RUN_TESTS: 'false',
      INPUT_TEST_COMMANDS: '[["echo","hi"]]',
      INPUT_CONTAINER_IMAGE: 'sha256:abc',
      INPUT_PROGRESS_COMMENT: 'false',
      INPUT_TIMEOUT_MINUTES: '30',
      INPUT_MIN_SEVERITY: 'major',
      INPUT_RULE_PACKS: '["@dshrb/rules-baseline"]',
    })
    expect(inputs['deepseek-api-key']).toBe('sk-123')
    expect(inputs['github-token']).toBe('gh-token')
    expect(inputs['allow-write']).toBe('true')
    expect(inputs['run-tests']).toBe('false')
    expect(inputs['test-commands']).toEqual([['echo', 'hi']])
    expect(inputs['container-image']).toBe('sha256:abc')
    expect(inputs['progress-comment']).toBe('false')
    expect(inputs['timeout-minutes']).toBe('30')
    expect(inputs['min-severity']).toBe('major')
    expect(inputs['rule-packs']).toEqual(['@dshrb/rules-baseline'])
  })

  it('omits unset optional inputs', () => {
    const inputs = readInputs({ INPUT_DEEPSEEK_API_KEY: 'sk-123' })
    expect(inputs['github-token']).toBeUndefined()
    expect(inputs['test-commands']).toBeUndefined()
    expect(inputs['rule-packs']).toBeUndefined()
  })

  it('fails loudly on malformed test-commands JSON', () => {
    expect(() => readInputs({ INPUT_DEEPSEEK_API_KEY: 'k', INPUT_TEST_COMMANDS: 'not json' }))
      .toThrow(/test-commands/)
  })

  it('fails loudly when test-commands is not an array of argv arrays', () => {
    expect(() => readInputs({ INPUT_DEEPSEEK_API_KEY: 'k', INPUT_TEST_COMMANDS: '["echo"]' }))
      .toThrow(/array of strings/)
  })

  it('fails loudly on malformed rule-packs JSON', () => {
    expect(() => readInputs({ INPUT_DEEPSEEK_API_KEY: 'k', INPUT_RULE_PACKS: '{nope}' }))
      .toThrow(/rule-packs/)
  })

  it('fails loudly when rule-packs is not an array of strings', () => {
    expect(() => readInputs({ INPUT_DEEPSEEK_API_KEY: 'k', INPUT_RULE_PACKS: '[1,2]' }))
      .toThrow(/package names/)
  })
})

// --- readEventPayload -------------------------------------------------------

describe('readEventPayload', () => {
  it('throws when GITHUB_EVENT_PATH is unset', () => {
    expect(() => readEventPayload({})).toThrow(/GITHUB_EVENT_PATH/)
  })

  it('injects the deliveryId and reads the payload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshrb-event-'))
    const path = join(dir, 'event.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, JSON.stringify({ number: 7, repository: { full_name: 'a/b' } }), 'utf8')
    const payload = readEventPayload({ GITHUB_EVENT_PATH: path, GITHUB_RUN_ID: 'run-1' }) as Record<string, unknown>
    expect(payload.deliveryId).toBe('run-1')
    expect(payload.number).toBe(7)
    await rm(dir, { recursive: true, force: true })
  })
})

// --- buildOutputs / buildResultJson ----------------------------------------

describe('buildOutputs', () => {
  function resultFixture(over: Partial<ReviewResult> = {}): ReviewResult {
    return {
      requestId: requestId('req-1'),
      verdict: { status: 'success', findingsCount: 2, blockersCount: 1, durationMs: 1234 },
      findings: [],
      discarded: [],
      operation: 'review',
      forgeId: forgeId('github'),
      trust: 'trusted-read',
      summary: 'two findings',
      stickyCommentId: commentId('c-9'),
      replayId: 'snap-1',
      ...over,
    }
  }

  it('maps every scalar output field for field (gate 7)', () => {
    const outputs = buildOutputs(resultFixture())
    expect(outputs.conclusion).toBe('success')
    expect(outputs.operation).toBe('review')
    expect(outputs.summary).toBe('two findings')
    expect(outputs['review-summary']).toBe('two findings')
    expect(outputs['findings-count']).toBe('2')
    expect(outputs['blockers-count']).toBe('1')
    expect(outputs['branch-name']).toBe('')
    expect(outputs['pull-request-url']).toBe('')
    expect(outputs['commit-sha']).toBe('')
    expect(outputs.trust).toBe('trusted-read')
    expect(outputs.forge).toBe('github')
    expect(outputs['duration-ms']).toBe('1234')
    expect(outputs['comment-id']).toBe('c-9')
    expect(outputs['replay-id']).toBe('snap-1')
    expect(outputs['error-code']).toBe('')
    expect(outputs['error-message']).toBe('')
    expect(JSON.parse(outputs['result-json']!).schemaVersion).toBe(1)
  })

  it('maps write results onto the write scalar outputs', () => {
    const outputs = buildOutputs(resultFixture({
      write: {
        appliedPatches: [],
        commitSha: commitSha('deadbeef'),
        pullRequestUrl: 'https://github.com/a/b/pull/9',
        validation: { ran: false, commands: [], passed: true, exitCodes: [] },
      },
    }))
    expect(outputs['commit-sha']).toBe('deadbeef')
    expect(outputs['pull-request-url']).toBe('https://github.com/a/b/pull/9')
  })

  it('maps failure and timed_out onto conclusion and error outputs', () => {
    const outputs = buildOutputs(resultFixture({
      verdict: { status: 'timed_out', findingsCount: 0, blockersCount: 0, durationMs: 5 },
      failure: { code: 'E_TIMEOUT', phase: 'reason', title: 'timed out', message: 'over budget', guidance: 'g', retryable: true },
    }))
    expect(outputs.conclusion).toBe('failure')
    expect(outputs['error-code']).toBe('E_TIMEOUT')
    expect(outputs['error-message']).toBe('over budget')
    const envelope = JSON.parse(outputs['result-json']!) as Record<string, unknown>
    expect(envelope.status).toBe('timed_out')
  })

  it('maps neutral to the neutral conclusion', () => {
    const outputs = buildOutputs(resultFixture({
      operation: 'none',
      verdict: { status: 'neutral', findingsCount: 0, blockersCount: 0, durationMs: 0 },
    }))
    expect(outputs.conclusion).toBe('neutral')
  })

  it('versions the result-json envelope at schemaVersion 1', () => {
    const envelope = buildResultJson(resultFixture())
    expect(envelope.schemaVersion).toBe(1)
    expect(envelope.status).toBe('success')
    expect(envelope.policy).toEqual({ trustLevel: 'trusted-read', capabilities: null })
    expect(envelope.rules).toEqual([])
    expect(envelope.isolation).toBeNull()
  })
})

// --- writeOutputs -----------------------------------------------------------

describe('writeOutputs', () => {
  it('writes scalar outputs and result-json to GITHUB_OUTPUT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshrb-out-'))
    const path = join(dir, 'outputs')
    const previous = process.env.GITHUB_OUTPUT
    process.env.GITHUB_OUTPUT = path
    try {
      await writeOutputs({
        requestId: requestId('req-1'),
        verdict: { status: 'success', findingsCount: 1, blockersCount: 0, durationMs: 1 },
        findings: [],
        discarded: [],
        operation: 'review',
        forgeId: forgeId('github'),
        trust: 'trusted-read',
        summary: 'one\nline\nsummary',
      })
      const content = await readFile(path, 'utf8')
      expect(content).toContain('conclusion=success\n')
      expect(content).toContain('findings-count=1\n')
      expect(content).toMatch(/summary<<dshrb-summary-\d+\none\nline\nsummary\n/)
      expect(content).toContain('result-json={"schemaVersion":1')
    } finally {
      process.env.GITHUB_OUTPUT = previous
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op when GITHUB_OUTPUT is unset', async () => {
    const previous = process.env.GITHUB_OUTPUT
    delete process.env.GITHUB_OUTPUT
    try {
      await expect(writeOutputs({
        requestId: requestId('req-1'),
        verdict: { status: 'neutral', findingsCount: 0, blockersCount: 0, durationMs: 0 },
        findings: [],
        discarded: [],
      })).resolves.toBeUndefined()
    } finally {
      if (previous !== undefined) process.env.GITHUB_OUTPUT = previous
    }
  })
})
