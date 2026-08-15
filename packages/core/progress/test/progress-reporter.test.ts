import { describe, expect, it } from 'vitest'
import { changeRequestId, commentId, commitSha, forgeId } from '@dshrb/review-core'
import type { CommentId, Finding, ReviewTarget } from '@dshrb/review-core'
import type { CommentSink, PublishStats } from '@dshrb/forge'
import { createProgressReporter, stickyMarker } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/**
 * The sticky comment is a safety boundary: it must only ever edit a comment the
 * forge sink verified as ours (numeric bot id + first-line marker). These tests
 * use a fake sink that reproduces that check, plus an injected clock, so the
 * throttle is asserted without real timers or a network.
 */

const BOT_ID = '1234'

function target(over: Partial<ReviewTarget> = {}): ReviewTarget {
  return {
    repo: 'acme/widgets',
    changeRequestId: changeRequestId('42'),
    baseSha: commitSha('aaaaaaa'),
    headSha: commitSha('bbbbbbb'),
    isFork: false,
    ...over,
  }
}

function firstLine(body: string): string {
  return body.split('\n', 1)[0]?.trim() ?? ''
}

interface StickyComment {
  readonly id: string
  readonly authorId: string
  readonly body: string
}

interface FakeCommentSink extends CommentSink {
  readonly comments: StickyComment[]
  readonly created: string[]
  readonly updated: Array<{ repo: string; id: CommentId; body: string }>
  /** When set, updateComment awaits this before recording, to model slow writes. */
  updateBarrier?: () => Promise<void>
  seed(comment: StickyComment): void
}

function createFakeSink(): FakeCommentSink {
  const sink: FakeCommentSink = {
    id: forgeId('fake'),
    capabilities: ['comment-sink', 'sticky-comment'],
    comments: [],
    created: [],
    updated: [],

    seed(comment) {
      this.comments.push(comment)
    },

    async createComment(_target, body) {
      const id = String(this.created.length + 1)
      this.created.push(body)
      return commentId(id)
    },

    async updateComment(repo, id, body) {
      if (this.updateBarrier !== undefined) {
        await this.updateBarrier()
      }
      this.updated.push({ repo, id, body })
    },

    async createInlineComments(
      _target: ReviewTarget, _findings: readonly Finding[], _botId: string,
    ): Promise<PublishStats> {
      return { published: 0, degradedToSummary: 0, failed: 0 }
    },

    async findStickyComment(_target, marker, botId) {
      const found = this.comments.find((c) =>
        c.authorId === botId && firstLine(c.body) === stickyMarker(marker))
      return found === undefined ? undefined : commentId(found.id)
    },
  }
  return sink
}

const config: Config = { progressComment: true, throttleMs: 5000 }

describe('stickyMarker', () => {
  it('formats the first-line marker to byte-match the forge providers', () => {
    expect(stickyMarker('summary')).toBe('<!-- dshrb:sticky:summary -->')
    expect(stickyMarker('diagnosis')).toBe('<!-- dshrb:sticky:diagnosis -->')
    expect(stickyMarker('write')).toBe('<!-- dshrb:sticky:write -->')
  })
})

describe('createProgressReporter.begin', () => {
  it('creates a sticky comment with the marker on the first line', async () => {
    const sink = createFakeSink()
    const reporter = createProgressReporter(sink, BOT_ID, config)

    const id = await reporter.begin(target(), 'summary')

    expect(id).toEqual(commentId('1'))
    expect(sink.created).toHaveLength(1)
    expect(firstLine(sink.created[0]!)).toBe(stickyMarker('summary'))
    expect(sink.created[0]).toContain('received')
  })

  it('reuses an existing sticky and resets it to the received stage', async () => {
    const sink = createFakeSink()
    sink.seed({
      id: '99',
      authorId: BOT_ID,
      body: `${stickyMarker('summary')}\ndone — previous run summary`,
    })
    const reporter = createProgressReporter(sink, BOT_ID, config)

    const id = await reporter.begin(target(), 'summary')

    expect(id).toEqual(commentId('99'))
    expect(sink.created).toHaveLength(0)
    expect(sink.updated).toHaveLength(1)
    expect(sink.updated[0]!.id).toEqual(commentId('99'))
    expect(sink.updated[0]!.repo).toBe('acme/widgets')
    expect(firstLine(sink.updated[0]!.body)).toBe(stickyMarker('summary'))
    expect(sink.updated[0]!.body).toContain('received')
    expect(sink.updated[0]!.body).not.toContain('previous run summary')
  })

  it('ignores a forged marker from a different author and creates a fresh comment', async () => {
    const sink = createFakeSink()
    // Correct-looking marker, but not our numeric bot id. Must never be edited.
    sink.seed({ id: '7', authorId: '9999', body: `${stickyMarker('summary')}\nnot ours` })
    const reporter = createProgressReporter(sink, BOT_ID, config)

    const id = await reporter.begin(target(), 'summary')

    expect(id).toEqual(commentId('1'))
    expect(sink.created).toHaveLength(1)
    expect(sink.updated).toHaveLength(0)
  })

  it('scopes the sticky per marker kind', async () => {
    const sink = createFakeSink()
    sink.seed({ id: '1', authorId: BOT_ID, body: `${stickyMarker('summary')}\nreceived` })
    const reporter = createProgressReporter(sink, BOT_ID, config)

    const id = await reporter.begin(target(), 'diagnosis')

    expect(id).toEqual(commentId('1'))
    expect(sink.created).toHaveLength(1)
    expect(firstLine(sink.created[0]!)).toBe(stickyMarker('diagnosis'))
  })

  it('throws when begin() is called twice', async () => {
    const sink = createFakeSink()
    const reporter = createProgressReporter(sink, BOT_ID, config)
    await reporter.begin(target(), 'summary')
    await expect(reporter.begin(target(), 'summary')).rejects.toThrow(/already/)
  })
})

describe('createProgressReporter.advance', () => {
  it('throttles edits within throttleMs', async () => {
    let clock = 0
    const sink = createFakeSink()
    const reporter = createProgressReporter(sink, BOT_ID, config, () => clock)

    await reporter.begin(target(), 'summary') // write at t=0
    clock = 1000
    await reporter.advance('reviewing') // 1000 - 0 < 5000 -> skipped
    expect(sink.updated).toHaveLength(0)

    clock = 6000
    await reporter.advance('reviewing') // 6000 - 0 >= 5000 -> written
    expect(sink.updated).toHaveLength(1)
    expect(sink.updated[0]!.body).toContain('reviewing')
  })

  it('writes the stage text and an optional detail line', async () => {
    let clock = 0
    const sink = createFakeSink()
    const reporter = createProgressReporter(sink, BOT_ID, { ...config, throttleMs: 0 }, () => clock)

    await reporter.begin(target(), 'summary')
    clock = 100
    await reporter.advance('reviewing', 'shard 2/5')

    expect(sink.updated).toHaveLength(1)
    expect(firstLine(sink.updated[0]!.body)).toBe(stickyMarker('summary'))
    expect(sink.updated[0]!.body).toContain('reviewing — analyzing the change')
    expect(sink.updated[0]!.body).toContain('shard 2/5')
  })

  it('routes the update through the target repo', async () => {
    let clock = 0
    const sink = createFakeSink()
    const reporter = createProgressReporter(sink, BOT_ID, { ...config, throttleMs: 0 }, () => clock)

    await reporter.begin(target(), 'summary')
    clock = 100
    await reporter.advance('publishing')

    expect(sink.updated[0]!.repo).toBe('acme/widgets')
    expect(sink.updated[0]!.id).toEqual(commentId('1'))
  })

  it('reserves the throttle slot synchronously so concurrent advances collapse', async () => {
    const sink = createFakeSink()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    sink.updateBarrier = () => gate
    let clock = 0
    const reporter = createProgressReporter(sink, BOT_ID, config, () => clock)

    await reporter.begin(target(), 'summary') // writes at t=0
    clock = 6000
    const first = reporter.advance('reviewing') // 6000-0 >= 5000 -> reserved, blocked in sink
    const second = reporter.advance('reviewing') // 6000-6000 < 5000 -> throttled
    release()
    await Promise.all([first, second])

    expect(sink.updated).toHaveLength(1)
    expect(sink.updated[0]!.body).toContain('reviewing')
  })

  it('throws before begin()', async () => {
    const sink = createFakeSink()
    const reporter = createProgressReporter(sink, BOT_ID, config)
    await expect(reporter.advance('reviewing')).rejects.toThrow(/before begin/)
  })
})

describe('createProgressReporter.finish', () => {
  it('always writes the terminal body, even when advance() was throttled away', async () => {
    let clock = 0
    const sink = createFakeSink()
    const reporter = createProgressReporter(sink, BOT_ID, config, () => clock)

    await reporter.begin(target(), 'summary')
    clock = 100
    await reporter.advance('reviewing') // suppressed by throttle
    expect(sink.updated).toHaveLength(0)

    await reporter.finish('review complete: 3 findings')

    expect(sink.updated).toHaveLength(1)
    expect(firstLine(sink.updated[0]!.body)).toBe(stickyMarker('summary'))
    expect(sink.updated[0]!.body).toContain('review complete: 3 findings')
  })

  it('finish always lands after an in-flight advance write', async () => {
    const sink = createFakeSink()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    sink.updateBarrier = () => gate
    const reporter = createProgressReporter(sink, BOT_ID, { ...config, throttleMs: 0 })

    await reporter.begin(target(), 'summary')
    const advancePromise = reporter.advance('reviewing')
    // Let the queued advance write start (pass its `finished` re-check) and
    // block inside updateComment before finish() is called.
    await Promise.resolve()
    await Promise.resolve()
    const finishPromise = reporter.finish('final review body')
    release()
    await Promise.all([advancePromise, finishPromise])

    expect(sink.updated[0]!.body).toContain('reviewing')
    expect(sink.updated.at(-1)!.body).toContain('final review body')
  })

  it('throws before begin()', async () => {
    const sink = createFakeSink()
    const reporter = createProgressReporter(sink, BOT_ID, config)
    await expect(reporter.finish('done')).rejects.toThrow(/before begin/)
  })
})

describe('createProgressReporter with progressComment disabled', () => {
  const disabled: Config = { progressComment: false, throttleMs: 5000 }

  it('skips the lifecycle (begin/advance) but finish() still posts the result', async () => {
    const sink = createFakeSink()
    const reporter = createProgressReporter(sink, BOT_ID, disabled)

    const id = await reporter.begin(target(), 'summary')
    expect(id).toBeUndefined()
    expect(sink.created).toHaveLength(0)

    await reporter.advance('reviewing')
    expect(sink.updated).toHaveLength(0)

    await reporter.finish('final review body')
    expect(sink.created).toHaveLength(1)
    expect(firstLine(sink.created[0]!)).toBe(stickyMarker('summary'))
    expect(sink.created[0]).toContain('final review body')
  })
})
