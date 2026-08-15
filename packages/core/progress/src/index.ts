/**
 * Sticky progress comment lifecycle.
 *
 * The sticky comment is created AFTER authorization but BEFORE context assembly,
 * so a later timeout still leaves the user with "received, working on it"
 * instead of silence.
 *
 * Update safety (docs/04-trust-model.md): a comment is updated only when it was
 * authored by the expected numeric bot id AND carries our own marker on the
 * first line. Anything else gets a fresh comment; we never overwrite someone
 * else's text. That check lives in `CommentSink.findStickyComment` — this
 * reporter only ever edits the id the sink returned as ours, and falls back to
 * `createComment` when the sink finds nothing.
 */
import type { CommentId, ReviewTarget } from '@dshrb/review-core'
import type { CommentSink } from '@dshrb/forge'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-progress'
export const inject = ['sessions']

/** Marker kinds, one sticky comment per kind. */
export type StickyMarker = 'summary' | 'diagnosis' | 'write'

export type Stage = 'received' | 'reviewing' | 'publishing' | 'done'

export interface ProgressReporter {
  /**
   * Anchors this reporter to one review run: finds the run's sticky comment or
   * creates it (stage `received`). Returns the sticky id, or `undefined` when
   * `progressComment` is disabled and no lifecycle comment is maintained.
   */
  begin(target: ReviewTarget, marker: StickyMarker): Promise<CommentId | undefined>
  /** Throttled: model streams produce far more events than comments should. */
  advance(stage: Stage, detail?: string): Promise<void>
  /** Always writes the terminal body, even when throttling suppressed `advance`. */
  finish(body: string): Promise<void>
}

export interface Config {
  /** Controls sticky lifecycle updates only; final results post regardless. */
  progressComment: boolean
  /** Minimum milliseconds between sticky edits, to respect forge rate limits. */
  throttleMs: number
}

export const Config: Schema<Config> = Schema.object({
  progressComment: Schema.boolean().default(true),
  throttleMs: Schema.number().default(5000),
})

/**
 * Our sticky marker, written as the FIRST line of every comment this reporter
 * creates or edits. Must byte-match `stickyMarker()` in `@dshrb/forge-github`,
 * which is what `findStickyComment` compares against: the marker is a shared
 * contract, not a local formatting choice. See docs/06-forge-abstraction.md.
 */
const STICKY_MARKER_PREFIX = '<!-- dshrb:sticky:'

export function stickyMarker(marker: string): string {
  return `${STICKY_MARKER_PREFIX}${marker} -->`
}

const STAGE_TEXT: Readonly<Record<Stage, string>> = {
  received: 'received — working on it',
  reviewing: 'reviewing — analyzing the change',
  publishing: 'publishing — posting review comments',
  done: 'done',
}

/** Marker on the first line, then the stage text and any optional detail. */
function stageBody(marker: StickyMarker, stage: Stage, detail?: string): string {
  const text = detail === undefined || detail.trim() === ''
    ? STAGE_TEXT[stage]
    : `${STAGE_TEXT[stage]}\n${detail}`
  return `${stickyMarker(marker)}\n${text}`
}

/** Marker on the first line, then the terminal body verbatim. */
function finalBody(marker: StickyMarker, body: string): string {
  return `${stickyMarker(marker)}\n${body}`
}

/**
 * Builds a reporter that drives one sticky comment through
 * `received → reviewing → publishing → done`.
 *
 * `botId` must be the numeric id, never a login: logins can be renamed, ids
 * cannot, and `findStickyComment` matches on the id. `now` is injectable so the
 * throttle can be tested with a fake clock rather than real timers.
 */
export function createProgressReporter(
  sink: CommentSink,
  botId: string,
  config: Config,
  now: () => number = Date.now,
): ProgressReporter {
  let target: ReviewTarget | undefined
  let marker: StickyMarker | undefined
  let stickyId: CommentId | undefined
  let lastWriteMs = Number.NEGATIVE_INFINITY
  let finished = false
  // Every comment write is serialized through this chain so a slow in-flight
  // advance can never complete after finish()'s terminal body. A rejected
  // write does not poison the chain for the writes that follow it.
  let writeChain: Promise<unknown> = Promise.resolve()

  function enqueueWrite(run: () => Promise<void>): Promise<void> {
    const next = writeChain.then(run, run)
    writeChain = next.then(() => undefined, () => undefined)
    return next
  }

  return {
    async begin(t, m): Promise<CommentId | undefined> {
      if (target !== undefined) {
        throw new Error('progress: begin() already called for this reporter')
      }
      target = t
      marker = m
      if (!config.progressComment) {
        // Lifecycle disabled: no "received" comment, and `finish` will post the
        // final result as a fresh comment instead of editing a sticky.
        return undefined
      }
      const existing = await sink.findStickyComment(t, m, botId)
      if (existing !== undefined) {
        // Found a comment the sink already verified as ours (bot id + marker),
        // so it is safe to edit. Reset it to the received stage so a previous
        // run's `done` summary cannot survive into this run's context window.
        stickyId = existing
        await sink.updateComment(t.repo, stickyId, stageBody(m, 'received'))
        lastWriteMs = now()
      } else {
        stickyId = await sink.createComment(t, stageBody(m, 'received'))
        lastWriteMs = now()
      }
      return stickyId
    },

    async advance(stage, detail): Promise<void> {
      if (target === undefined || marker === undefined) {
        throw new Error('progress: advance() before begin()')
      }
      if (finished || !config.progressComment || stickyId === undefined) {
        return
      }
      if (now() - lastWriteMs < config.throttleMs) {
        return
      }
      // Reserve the throttle slot synchronously: streaming handlers fire many
      // concurrent advance() calls, and updating the timestamp only after the
      // awaited write would let the whole flood pass the throttle check.
      lastWriteMs = now()
      const repo = target.repo
      const id = stickyId
      const m = marker
      await enqueueWrite(async () => {
        // finish() may have run while this write was queued; its terminal body
        // must be the last thing written, so a stale stage update drops here.
        if (finished) return
        await sink.updateComment(repo, id, stageBody(m, stage, detail))
      })
    },

    async finish(body): Promise<void> {
      if (target === undefined || marker === undefined) {
        throw new Error('progress: finish() before begin()')
      }
      // Mark finished synchronously so any advance() that runs from now on
      // short-circuits, then queue the terminal write behind any in-flight
      // advance: the final body is always the last write, never throttled.
      finished = true
      if (stickyId !== undefined) {
        const repo = target.repo
        const id = stickyId
        const m = marker
        await enqueueWrite(() => sink.updateComment(repo, id, finalBody(m, body)))
      } else {
        stickyId = await sink.createComment(target, finalBody(marker, body))
      }
    },
  }
}

/**
 * The binding point for the controller. `review-runtime` creates a reporter,
 * `begin`s it, then `track`s it against the session the agent runs in; the
 * session event subscription below then drives its throttled stage updates.
 */
export interface ProgressService {
  /**
   * Attach `reporter` to the session identified by `sessionId`. From then on,
   * that session's `assistant/chunk` events and turn starts advance the
   * reporter's `reviewing` stage. Returns a disposer that detaches it.
   */
  track(sessionId: string, reporter: ProgressReporter): () => void
}

export function apply(ctx: Context, _config: Config): void {
  const reporters = new Map<string, ProgressReporter>()
  const service: ProgressService = {
    track(sessionId, reporter) {
      reporters.set(sessionId, reporter)
      return () => {
        if (reporters.get(sessionId) === reporter) {
          reporters.delete(sessionId)
        }
      }
    },
  }
  // Fiber-owned: the service unregisters when this plugin's fiber unloads.
  ctx.provide('progress', service)

  // Map the model's stream onto throttled stage updates. `assistant/chunk`
  // fires per token and `turn/start` opens each turn, so both signal "the
  // model is reasoning"; the reporter's throttle collapses the flood.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const reporter = reporters.get(session.id)
    if (reporter === undefined) {
      return
    }
    if (event.type === 'assistant/chunk' || event.type === 'turn/start') {
      void reporter.advance('reviewing').catch(() => {
        // Progress is best-effort: a failed throttled edit must not take down
        // the session event dispatch or the review run it is annotating.
      })
    }
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    progress: ProgressService
  }
}
