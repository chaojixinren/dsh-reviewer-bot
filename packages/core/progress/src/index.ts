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
 * else's text.
 */
import type { CommentId, ReviewTarget } from '@dshrb/review-core'
import type { CommentSink } from '@dshrb/forge'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-progress'

/** Marker kinds, one sticky comment per kind. */
export type StickyMarker = 'summary' | 'diagnosis' | 'write'

export type Stage = 'received' | 'reviewing' | 'publishing' | 'done'

export interface ProgressReporter {
  begin(target: ReviewTarget, marker: StickyMarker): Promise<CommentId>
  /** Throttled: model streams produce far more events than comments should. */
  advance(stage: Stage, detail?: string): Promise<void>
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

export function createProgressReporter(
  _sink: CommentSink, _botId: string, _config: Config,
): ProgressReporter {
  throw new Error('not implemented: createProgressReporter (M1)')
}

export function apply(_ctx: Context, _config: Config): void {
  // TODO(M1): ctx.on('session/event') → map assistant/chunk and turn
  //           boundaries onto throttled stage updates.
  throw new Error('not implemented: M1')
}
