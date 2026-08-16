/**
 * GitHub ForgeGateway provider.
 *
 * Holds the only GitHub credential in the process. The token lives in this
 * module's closure, is attached only to outbound requests built here, and is
 * never returned from a public method nor placed in an error message — so it
 * cannot reach the agent workspace or a validation subprocess.
 *
 * Every REST path is built from `baseUrl`, so GitHub Enterprise Server works
 * unchanged. See docs/06-forge-abstraction.md.
 */
import { publishIdempotencyKey } from '@dshrb/forge'
import type {
  ActorResolver, BotIdentity, CheckReader, CheckRun, CommentSink, DiffFile, DiffHunk,
  DiffSource, ForgeCapability, ForgePermission, MutationSink, PublishStats, PullRequestSpec,
  UnifiedDiff,
} from '@dshrb/forge'
import {
  buildFindingBadge, commentId as brandCommentId, commitSha, forgeId, isAnchored, isSafeRelativePath,
} from '@dshrb/review-core'
import type {
  CommentId, CommitSha, Finding, ForgeId, Patch, ReviewTarget,
} from '@dshrb/review-core'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-forge-github'
export const inject = ['forges']

export const FORGE_ID: ForgeId = forgeId('github')

export const CAPABILITIES: readonly ForgeCapability[] = [
  'diff-source', 'comment-sink', 'inline-comments', 'sticky-comment',
  'actor-resolver', 'check-reader', 'mutation-sink',
]

/** Marks our sticky comment. Must be the FIRST line to be recognized as ours. */
export const STICKY_MARKER_PREFIX = '<!-- dshrb:sticky:'

/** Carries the per-finding publish idempotency key inside a posted comment. */
const IDEMPOTENCY_MARKER_PREFIX = '<!-- dshrb:key:'
const IDEMPOTENCY_MARKER_RE = /<!--\s*dshrb:key:([0-9a-f]{64})\s*-->\s*$/u

/** Bounds pagination so a pathological PR cannot spin forever. */
const MAX_PAGES = 20
const PER_PAGE = 100

export interface Config {
  token: string
  /** GitHub Enterprise Server base URL. */
  baseUrl: string
}

export const Config: Schema<Config> = Schema.object({
  token: Schema.string().default(''),
  baseUrl: Schema.string().default('https://api.github.com'),
})

/**
 * The subset of `fetch` this provider uses, named so tests can supply a stub:
 * the suite must never reach the live GitHub API.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface GitHubDeps {
  readonly fetch: FetchLike
  /**
   * Resolves the bearer token on each request. Defaults to `config.token`;
   * the bundle wires this to the shared `ctx.dshrb` config so a token edited
   * in the Web UI takes effect without a restart.
   */
  readonly getToken?: () => string
}

/** Thrown for any non-2xx REST response. Never includes the token. */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`GitHub ${method} ${path} failed with ${String(status)}: ${detail}`)
    this.name = 'GitHubApiError'
  }
}

export interface GitHubGateway
  extends DiffSource, CommentSink, ActorResolver, CheckReader, MutationSink {}

// ---------------------------------------------------------------------------
// Input validation
//
// Repo, PR number, login and numeric ids all arrive from untrusted webhook
// payloads and land inside a URL path. Validated against strict patterns so a
// value like `../../orgs/x` cannot escape its path segment.
// ---------------------------------------------------------------------------

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u

/** Stable user id of the `github-actions[bot]` app account (used when the
 * token is an integration and `GET /user` is not accessible). */
const GITHUB_ACTIONS_BOT_ID = '41898282'

function assertRepo(repo: string): string {
  const trimmed = repo.trim()
  if (!REPO_RE.test(trimmed)) {
    throw new TypeError(`github: repo must be 'owner/name', got '${excerpt(repo)}'`)
  }
  return trimmed
}

function assertPullNumber(raw: string): string {
  return assertNumericId('changeRequestId', raw)
}

function assertLogin(login: string): string {
  const trimmed = login.trim()
  // GitHub App actors render as `name[bot]` (e.g. `dependabot[bot]`); rejecting
  // them here would hard-fail resolvePermission instead of failing closed to
  // `none`. Brackets are still safe path segments (no `/`, `?`, `#`, `%`).
  if (!/^[A-Za-z0-9][A-Za-z0-9[\]-]{0,38}$/u.test(trimmed)) {
    throw new TypeError(`github: invalid actor login '${excerpt(login)}'`)
  }
  return trimmed
}

function assertNumericId(kind: string, raw: string): string {
  const trimmed = raw.trim()
  if (!/^[1-9][0-9]*$/u.test(trimmed)) {
    throw new TypeError(`github: ${kind} must be a positive integer, got '${excerpt(raw)}'`)
  }
  return trimmed
}

function assertSafePath(path: string): string {
  const trimmed = path.trim()
  if (!isSafeRelativePath(trimmed)) {
    throw new TypeError(`github: path must be repo-relative, got '${excerpt(path)}'`)
  }
  return trimmed
}

function excerpt(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value
}

// ---------------------------------------------------------------------------
// Permission mapping
// ---------------------------------------------------------------------------

/**
 * `GET /repos/{repo}/collaborators/{login}/permission` returns one of these in
 * its `permission` field. Anything else — a newly added tier, a null, a typo —
 * fails closed to `none`: over-granting here would hand an unknown actor write
 * capability, which is the exact mistake this mapping exists to prevent.
 *
 * `push`/`pull` are included because the same field is spelled that way on some
 * responses and on GitHub Enterprise Server.
 */
const PERMISSION_MAP: Readonly<Record<string, ForgePermission>> = Object.freeze({
  admin: 'admin',
  maintain: 'maintain',
  write: 'write',
  push: 'write',
  triage: 'triage',
  read: 'read',
  pull: 'read',
  none: 'none',
})

export function mapPermission(raw: unknown): ForgePermission {
  if (typeof raw !== 'string') {
    return 'none'
  }
  const key = raw.trim().toLowerCase()
  // Own-property check, not a bare index: a payload of `constructor` or
  // `toString` would otherwise resolve through Object.prototype and hand back a
  // function in place of a ForgePermission, defeating the fail-closed default.
  if (!Object.hasOwn(PERMISSION_MAP, key)) {
    return 'none'
  }
  return PERMISSION_MAP[key] ?? 'none'
}

const KNOWN_CONCLUSIONS: readonly CheckRun['conclusion'][] = [
  'failure', 'cancelled', 'timed_out', 'success', 'neutral',
]

/** Conclusions that mean "this check did not pass". */
const FAILED_CONCLUSIONS: readonly CheckRun['conclusion'][] = ['failure', 'cancelled', 'timed_out']

function mapConclusion(raw: unknown): CheckRun['conclusion'] | undefined {
  return KNOWN_CONCLUSIONS.find((value) => value === raw)
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u

/**
 * Splits a GitHub `files[].patch` blob into hunks. That field omits the
 * `---`/`+++` preamble, so it is a bare sequence of `@@` sections.
 *
 * A header without an explicit count means exactly one line (`@@ -3 +3 @@`),
 * which is why the count groups default to 1 and not 0.
 */
export function parseHunks(patch: string): readonly DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: { header: RegExpExecArray; lines: string[] } | undefined

  const flush = (): void => {
    if (current === undefined) {
      return
    }
    const [, oldStart, oldLines, newStart, newLines] = current.header
    hunks.push({
      oldStart: Number(oldStart),
      oldLines: oldLines === undefined ? 1 : Number(oldLines),
      newStart: Number(newStart),
      newLines: newLines === undefined ? 1 : Number(newLines),
      text: [current.header[0], ...current.lines].join('\n'),
    })
    current = undefined
  }

  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER_RE.exec(line)
    if (header !== null) {
      flush()
      current = { header, lines: [] }
    } else if (current !== undefined) {
      current.lines.push(line)
    }
  }
  flush()
  return hunks
}

// ---------------------------------------------------------------------------
// Unified diff application (MutationSink.commitPatches)
//
// The Git Data API takes full file content (as a blob), not a diff, so each
// patch's diff is applied to the base content fetched at the repository default
// branch before the blob is created.
// ---------------------------------------------------------------------------

interface ApplyPatchResult {
  readonly ok: boolean
  readonly content?: string
  readonly reason?: string
}

interface PatchLine {
  readonly text: string
  readonly newline: boolean
}

function splitPatchLines(content: string): PatchLine[] {
  if (content === '') return []
  const endsWithNewline = content.endsWith('\n')
  const parts = content.split('\n')
  const texts = endsWithNewline ? parts.slice(0, -1) : parts
  return texts.map((text, i) => ({ text, newline: endsWithNewline || i < texts.length - 1 }))
}

function joinPatchLines(lines: readonly PatchLine[]): string {
  let out = ''
  for (const line of lines) {
    out += line.text
    if (line.newline) out += '\n'
  }
  return out
}

/**
 * Applies a single-file unified diff to `content`, mirroring the runtime's
 * `applyUnifiedDiff` semantics: deterministic, offline, and a hunk that does
 * not line up fails rather than guessing. A bad patch is the model's output and
 * must be reported, never silently mis-applied.
 */
export function applyPatch(content: string, diff: string): ApplyPatchResult {
  const oldLines = splitPatchLines(content)
  const result: PatchLine[] = []
  let cursor = 0
  const lines = diff.split('\n')
  let index = 0

  // Skip any file preamble until the first hunk header.
  while (index < lines.length && HUNK_HEADER_RE.exec(lines[index] ?? '') === null) {
    index++
  }

  let sawHunk = false
  while (index < lines.length) {
    const header = HUNK_HEADER_RE.exec(lines[index] ?? '')
    if (header === null) {
      index++
      continue
    }
    sawHunk = true
    const oldStart = Number(header[1])
    const oldCount = header[2] === undefined ? 1 : Number(header[2])
    // A pure insertion (`oldCount === 0`) anchors to `oldStart` — "insert after
    // that old line" in 0-based terms — not the running cursor.
    const target = oldCount === 0 ? oldStart : oldStart - 1
    if (target < cursor) {
      return { ok: false, reason: 'hunk overlaps a previous hunk' }
    }
    while (cursor < target) {
      result.push(oldLines[cursor] ?? { text: '', newline: true })
      cursor++
    }

    index++
    let lastKind: 'add' | 'remove' | 'context' | null = null
    while (index < lines.length && HUNK_HEADER_RE.exec(lines[index] ?? '') === null) {
      const line = lines[index] ?? ''
      if (line === '\\ No newline at end of file') {
        if (lastKind === 'add' || lastKind === 'context') {
          const prev = result[result.length - 1]
          if (prev !== undefined) result[result.length - 1] = { text: prev.text, newline: false }
        }
        lastKind = null
      } else if (line.startsWith('+')) {
        result.push({ text: line.slice(1), newline: true })
        lastKind = 'add'
      } else if (line.startsWith('-')) {
        const removed = oldLines[cursor]
        if (removed === undefined || removed.text !== line.slice(1)) {
          return { ok: false, reason: `hunk removes a line that does not match the file at line ${cursor + 1}` }
        }
        cursor++
        lastKind = 'remove'
      } else if (line.startsWith(' ')) {
        const context = oldLines[cursor]
        if (context === undefined || context.text !== line.slice(1)) {
          return { ok: false, reason: `hunk context does not match the file at line ${cursor + 1}` }
        }
        result.push({ text: context.text, newline: context.newline })
        cursor++
        lastKind = 'context'
      } else if (line === '') {
        // Trailing blank line artifact after the final hunk.
      } else {
        return { ok: false, reason: `unexpected patch line '${excerpt(line)}'` }
      }
      index++
    }
  }

  if (!sawHunk) {
    return { ok: false, reason: 'patch contains no hunk header' }
  }
  while (cursor < oldLines.length) {
    result.push(oldLines[cursor] ?? { text: '', newline: true })
    cursor++
  }
  return { ok: true, content: joinPatchLines(result) }
}

// ---------------------------------------------------------------------------
// Comment bodies
// ---------------------------------------------------------------------------

export function stickyMarker(marker: string): string {
  return `${STICKY_MARKER_PREFIX}${marker} -->`
}

/**
 * Appends the idempotency key so a later run recognizes its own comment.
 * Appended rather than prefixed: the first line of an inline comment is what a
 * reviewer reads first, and the sticky comment reserves its own first line.
 */
export function withIdempotencyMarker(body: string, key: string): string {
  return `${body}\n\n${IDEMPOTENCY_MARKER_PREFIX}${key} -->`
}

export function extractIdempotencyKey(body: unknown): string | undefined {
  if (typeof body !== 'string') {
    return undefined
  }
  return IDEMPOTENCY_MARKER_RE.exec(body)?.[1]
}

/**
 * A sticky comment is ours only when the FIRST line carries the marker. A body
 * that mentions the marker further down is a forgery from an untrusted comment
 * author and must be ignored, never updated.
 */
function hasStickyMarkerOnFirstLine(body: unknown, marker: string): boolean {
  if (typeof body !== 'string') {
    return false
  }
  return (body.split('\n', 1)[0] ?? '').trim() === stickyMarker(marker)
}

function findingCommentBody(finding: Finding): string {
  // The severity moves into the shields.io badge (color + alt text carry it),
  // so the title no longer repeats it inline.
  return `${buildFindingBadge(finding)}\n\n**${finding.title}**\n\n${finding.body}`
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export function createGitHubGateway(config: Config, deps: GitHubDeps): GitHubGateway {
  const baseUrl = config.baseUrl.replace(/\/+$/u, '')
  const getToken = deps.getToken ?? (() => config.token)

  async function request(method: string, path: string, extra?: {
    body?: unknown
    accept?: string
  }): Promise<Response> {
    const headers: Record<string, string> = {
      // The credential is attached here and nowhere else in the process.
      authorization: `Bearer ${getToken()}`,
      accept: extra?.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-reviewer-bot',
    }
    const init: RequestInit = { method, headers }
    if (extra?.body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(extra.body)
    }
    const response = await deps.fetch(`${baseUrl}${path}`, init)
    if (!response.ok) {
      // The body gives context; request headers are never echoed.
      const detail = await response.text().then(excerpt).catch(() => '<unreadable>')
      throw new GitHubApiError(response.status, method, path, detail)
    }
    return response
  }

  async function getJson<T>(path: string): Promise<T> {
    return await (await request('GET', path)).json() as T
  }

  /** Pages until a short batch arrives, capped at `MAX_PAGES`. */
  async function getPaged<T>(path: string): Promise<readonly T[]> {
    const items: T[] = []
    const separator = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await getJson<T[]>(
        `${path}${separator}per_page=${String(PER_PAGE)}&page=${String(page)}`,
      )
      if (!Array.isArray(batch)) {
        throw new TypeError(`github: expected an array from ${path}`)
      }
      items.push(...batch)
      // A short page always means the end on this API, and unlike `Link` it does
      // not have to be synthesized by a test stub.
      if (batch.length < PER_PAGE) {
        break
      }
    }
    return items
  }

  function pullPath(target: ReviewTarget): string {
    return `/repos/${assertRepo(target.repo)}/pulls/${assertPullNumber(target.changeRequestId)}`
  }

  // -- DiffSource -----------------------------------------------------------

  async function fetchDiff(target: ReviewTarget): Promise<UnifiedDiff> {
    interface RawFile {
      filename?: unknown
      previous_filename?: unknown
      patch?: unknown
    }
    const raw = await getPaged<RawFile>(`${pullPath(target)}/files`)
    const files: DiffFile[] = []
    for (const entry of raw) {
      const path = typeof entry.filename === 'string' ? entry.filename.trim() : ''
      if (!isSafeRelativePath(path)) {
        // Nothing outside the repo can be reported on or written to, so it is
        // dropped here rather than anchoring a comment onto a bogus location.
        continue
      }
      const patch = typeof entry.patch === 'string' ? entry.patch : undefined
      const previousPath = typeof entry.previous_filename === 'string'
        && isSafeRelativePath(entry.previous_filename.trim())
        ? entry.previous_filename.trim()
        : undefined
      files.push({
        path,
        // GitHub omits `patch` for binary blobs and for files over its size cap.
        binary: patch === undefined,
        hunks: patch === undefined ? [] : parseHunks(patch),
        ...(previousPath === undefined ? {} : { previousPath }),
      })
    }
    return { files }
  }

  async function fetchFile(repo: string, path: string, sha: CommitSha): Promise<string> {
    const safePath = assertSafePath(path)
    // `raw` media type returns the blob itself; the JSON form would need a
    // base64 round-trip and caps out at 1MB.
    const encoded = safePath.split('/').map(encodeURIComponent).join('/')
    const response = await request(
      'GET',
      `/repos/${assertRepo(repo)}/contents/${encoded}?ref=${encodeURIComponent(sha)}`,
      { accept: 'application/vnd.github.raw' },
    )
    return await response.text()
  }

  // -- CommentSink ----------------------------------------------------------

  async function createComment(target: ReviewTarget, body: string): Promise<CommentId> {
    const repo = assertRepo(target.repo)
    const number = assertPullNumber(target.changeRequestId)
    // A summary comment is an issue comment: the PR conversation thread.
    const created = await (await request('POST', `/repos/${repo}/issues/${number}/comments`, {
      body: { body },
    })).json() as { id?: unknown }
    return brandCommentId(String(created.id ?? ''))
  }

  async function updateComment(repo: string, id: CommentId, body: string): Promise<void> {
    const commentPath = `/repos/${assertRepo(repo)}/issues/comments/${assertNumericId('commentId', id)}`
    await request('PATCH', commentPath, { body: { body } })
  }

  /**
   * Posts one inline review comment per finding, skipping any finding whose
   * idempotency key is already present on the PR in a comment authored by the
   * bot. That makes a retry after a partial publish a no-op for the comments
   * that already landed, without letting a reader pre-seed a key to suppress a
   * finding.
   *
   * An unanchored finding is never posted inline — a misplaced comment is worse
   * than a summary entry — and is counted in `degradedToSummary` so the caller
   * knows to include it in the sticky comment instead. A per-finding REST
   * failure increments `failed` and does not abort the remaining findings.
   */
  async function createInlineComments(
    target: ReviewTarget, findings: readonly Finding[], botId: string,
  ): Promise<PublishStats> {
    const repo = assertRepo(target.repo)
    const number = assertPullNumber(target.changeRequestId)

    interface RawReviewComment { body?: unknown; user?: { id?: unknown } | null }
    const existing = await getPaged<RawReviewComment>(`/repos/${repo}/pulls/${number}/comments`)
    const publishedKeys = new Set<string>()
    for (const comment of existing) {
      // Only our own comments carry authoritative keys. A marker written by
      // anyone else is forgeable — a reader could pre-seed a key and suppress
      // the finding it belongs to — so non-bot comments are ignored (the same
      // author gate as findStickyComment).
      const authorId = comment.user?.id
      if (authorId === undefined || authorId === null || String(authorId) !== botId) {
        continue
      }
      const key = extractIdempotencyKey(comment.body)
      if (key !== undefined) {
        publishedKeys.add(key)
      }
    }

    let published = 0
    let degradedToSummary = 0
    let failed = 0

    for (const finding of findings) {
      if (!isAnchored(finding.anchor)) {
        degradedToSummary += 1
        continue
      }
      const key = publishIdempotencyKey(finding)
      if (publishedKeys.has(key)) {
        continue
      }
      try {
        await request('POST', `/repos/${repo}/pulls/${number}/comments`, {
          body: {
            body: withIdempotencyMarker(findingCommentBody(finding), key),
            commit_id: target.headSha,
            path: finding.anchor.path,
            line: finding.anchor.line,
            side: finding.anchor.side === 'left' ? 'LEFT' : 'RIGHT',
          },
        })
        // Recorded immediately, so a duplicate finding within one batch cannot
        // post twice either.
        publishedKeys.add(key)
        published += 1
      } catch {
        failed += 1
      }
    }
    return { published, degradedToSummary, failed }
  }

  async function findStickyComment(
    target: ReviewTarget, marker: string, botId: string,
  ): Promise<CommentId | undefined> {
    const repo = assertRepo(target.repo)
    const number = assertPullNumber(target.changeRequestId)
    interface RawIssueComment {
      id?: unknown
      body?: unknown
      user?: { id?: unknown } | null
    }
    const comments = await getPaged<RawIssueComment>(`/repos/${repo}/issues/${number}/comments`)
    for (const comment of comments) {
      // Both conditions are required: authored by our numeric bot id AND
      // carrying our marker on the first line. Either one alone is forgeable —
      // any user can write the marker, and our bot posts other comments too.
      const authorId = comment.user?.id
      if (authorId === undefined || authorId === null || String(authorId) !== botId) {
        continue
      }
      if (!hasStickyMarkerOnFirstLine(comment.body, marker)) {
        continue
      }
      return brandCommentId(String(comment.id ?? ''))
    }
    return undefined
  }

  // -- ActorResolver --------------------------------------------------------

  async function resolvePermission(repo: string, actorLogin: string): Promise<ForgePermission> {
    const path = `/repos/${assertRepo(repo)}/collaborators/${encodeURIComponent(assertLogin(actorLogin))}/permission`
    try {
      const raw = await getJson<{ permission?: unknown }>(path)
      return mapPermission(raw.permission)
    } catch (error) {
      // 403/404 mean "not a collaborator" or "not visible to this token", both
      // of which are `none`. Any other status is a real fault and propagates.
      if (error instanceof GitHubApiError && (error.status === 403 || error.status === 404)) {
        return 'none'
      }
      throw error
    }
  }

  /**
   * Reads `head.repo.fork` — the platform's own flag. Not a login comparison
   * (an org member can open a fork PR) and not a URL heuristic (a renamed repo
   * breaks it). A missing `head.repo` means the fork was deleted, which is
   * treated as a fork: the untrusted branch is the safe assumption.
   */
  async function isFork(target: ReviewTarget): Promise<boolean> {
    const raw = await getJson<{ head?: { repo?: { fork?: unknown } | null } | null }>(
      pullPath(target),
    )
    const headRepo = raw.head?.repo
    if (headRepo === undefined || headRepo === null) {
      return true
    }
    // `fork` must be an explicit boolean. A missing flag (or an unexpected type)
    // means the API shape changed; fail closed to `fork` rather than reporting a
    // potentially untrusted branch as trusted.
    if (typeof headRepo.fork !== 'boolean') {
      return true
    }
    return headRepo.fork
  }

  /**
   * Returns the numeric id as identity, since logins can be renamed.
   *
   * The Actions `GITHUB_TOKEN` is a GitHub App installation token, and `GET
   * /user` is not accessible to integrations (403 "Resource not accessible by
   * integration"). In the Action the comments are authored by the well-known
   * `github-actions` app, so a 403 falls back to that stable user id/login
   * instead of failing the whole publish. A user PAT keeps the `/user` path.
   */
  async function botIdentity(): Promise<BotIdentity> {
    let raw: { id?: unknown; login?: unknown }
    try {
      raw = await getJson<{ id?: unknown; login?: unknown }>('/user')
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 403) {
        return { id: GITHUB_ACTIONS_BOT_ID, login: 'github-actions[bot]' }
      }
      throw error
    }
    const id = raw.id
    if (typeof id !== 'number' && typeof id !== 'string') {
      throw new TypeError('github: /user returned no usable numeric id')
    }
    return {
      id: String(id),
      login: typeof raw.login === 'string' ? raw.login : '',
    }
  }

  // -- CheckReader ----------------------------------------------------------

  async function listFailedChecks(repo: string, sha: CommitSha): Promise<readonly CheckRun[]> {
    interface RawCheckRun { id?: unknown; name?: unknown; conclusion?: unknown }
    const path = `/repos/${assertRepo(repo)}/commits/${encodeURIComponent(sha)}/check-runs`
    const runs: CheckRun[] = []
    const separator = '?'
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const payload = await getJson<{ check_runs?: unknown }>(
        `${path}${separator}per_page=${String(PER_PAGE)}&page=${String(page)}`,
      )
      // This endpoint wraps its array in an object, unlike the list endpoints.
      const batch = Array.isArray(payload.check_runs) ? payload.check_runs as RawCheckRun[] : []
      for (const run of batch) {
        const conclusion = mapConclusion(run.conclusion)
        if (conclusion === undefined || !FAILED_CONCLUSIONS.includes(conclusion)) {
          continue
        }
        runs.push({
          id: String(run.id ?? ''),
          name: typeof run.name === 'string' ? run.name : '',
          conclusion,
        })
      }
      if (batch.length < PER_PAGE) {
        break
      }
    }
    return runs
  }

  /**
   * Check-run logs are Actions job logs: the endpoint 302s to a short-lived blob
   * URL. `fetch` follows that redirect by default, and the redirect target must
   * NOT carry our Authorization header — it is a signed storage URL, and
   * forwarding the token to a third-party host would leak the credential.
   * `fetch` strips the header on a cross-origin redirect, which is what makes
   * relying on the default safe here.
   */
  async function fetchLog(repo: string, checkId: string): Promise<string> {
    const path = `/repos/${assertRepo(repo)}/actions/jobs/${assertNumericId('checkId', checkId)}/logs`
    return await (await request('GET', path, { accept: 'application/vnd.github+json' })).text()
  }

  // -- MutationSink ---------------------------------------------------------

  async function commitPatches(
    repo: string, branch: string, patches: readonly Patch[], message: string,
  ): Promise<CommitSha> {
    const repoPath = assertRepo(repo)
    if (patches.length === 0) {
      throw new TypeError('github: commitPatches received no patches')
    }
    // The head branch does not exist yet; fork it from the repository default
    // branch, which is the only sane base the `MutationSink` interface exposes
    // (it passes no base sha/branch).
    interface RawRepo { default_branch?: unknown }
    const rawRepo = await getJson<RawRepo>(`/repos/${repoPath}`)
    if (typeof rawRepo.default_branch !== 'string' || rawRepo.default_branch.trim() === '') {
      throw new TypeError('github: repository returned no usable default_branch')
    }
    const baseBranch = rawRepo.default_branch.trim()

    // One call yields both the head commit sha (for the parent) and the base
    // tree sha (for the tree the new blobs are attached to).
    interface RawHeadCommit {
      sha?: unknown
      commit?: { tree?: { sha?: unknown } | null } | null
    }
    const head = await getJson<RawHeadCommit>(
      `/repos/${repoPath}/commits/${encodeURIComponent(baseBranch)}`,
    )
    if (typeof head.sha !== 'string' || head.sha.trim() === '') {
      throw new TypeError('github: default branch returned no usable commit sha')
    }
    const baseHeadSha = head.sha.trim()
    const baseTreeSha = head.commit?.tree?.sha
    if (typeof baseTreeSha !== 'string' || baseTreeSha.trim() === '') {
      throw new TypeError('github: default branch commit returned no usable tree sha')
    }

    interface RawTreeEntry { path: string; mode: '100644'; type: 'blob'; sha: string }
    const treeEntries: RawTreeEntry[] = []

    // Group patches by path so multiple hunks against the same file apply
    // cumulatively (the runtime's mutate stage applies them sequentially).
    // Without grouping, two patches on one path would emit duplicate tree
    // entries, which the Git Data API rejects.
    const patchesByPath = new Map<string, Patch[]>()
    for (const patch of patches) {
      const filePath = assertSafePath(patch.path)
      const group = patchesByPath.get(filePath)
      if (group === undefined) {
        patchesByPath.set(filePath, [patch])
      } else {
        group.push(patch)
      }
    }
    for (const [filePath, group] of patchesByPath) {
      const encoded = filePath.split('/').map(encodeURIComponent).join('/')
      let content = ''
      try {
        const response = await request(
          'GET',
          `/repos/${repoPath}/contents/${encoded}?ref=${encodeURIComponent(baseBranch)}`,
          { accept: 'application/vnd.github.raw' },
        )
        content = await response.text()
      } catch (error) {
        // 404 means the file does not exist on the base branch, so this patch
        // creates it from empty content.
        if (error instanceof GitHubApiError && error.status === 404) {
          content = ''
        } else {
          throw error
        }
      }
      for (const patch of group) {
        const applied = applyPatch(content, patch.diff)
        if (!applied.ok || applied.content === undefined) {
          throw new TypeError(`github: patch for '${excerpt(patch.path)}' does not apply: ${applied.reason ?? 'unknown'}`)
        }
        content = applied.content
      }
      interface RawBlob { sha?: unknown }
      const blob = await (await request('POST', `/repos/${repoPath}/git/blobs`, {
        body: { content, encoding: 'utf-8' },
      })).json() as RawBlob
      if (typeof blob.sha !== 'string' || blob.sha.trim() === '') {
        throw new TypeError('github: blob response returned no usable sha')
      }
      treeEntries.push({ path: filePath, mode: '100644', type: 'blob', sha: blob.sha })
    }

    interface RawTree { sha?: unknown }
    const tree = await (await request('POST', `/repos/${repoPath}/git/trees`, {
      body: { base_tree: baseTreeSha, tree: treeEntries },
    })).json() as RawTree
    if (typeof tree.sha !== 'string' || tree.sha.trim() === '') {
      throw new TypeError('github: tree response returned no usable sha')
    }

    interface RawCommit { sha?: unknown }
    const commit = await (await request('POST', `/repos/${repoPath}/git/commits`, {
      body: { message, tree: tree.sha, parents: [baseHeadSha] },
    })).json() as RawCommit
    if (typeof commit.sha !== 'string' || commit.sha.trim() === '') {
      throw new TypeError('github: commit response returned no usable sha')
    }

    // Create the write branch pointing at the new commit. The branch name is
    // derived from the request id (`dshrb-fix/<id>`), so it does not exist yet.
    await request('POST', `/repos/${repoPath}/git/refs`, {
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    })

    return commitSha(commit.sha)
  }

  async function openPullRequest(spec: PullRequestSpec): Promise<string> {
    const repoPath = assertRepo(spec.repo)
    interface RawPull { html_url?: unknown }
    const pull = await (await request('POST', `/repos/${repoPath}/pulls`, {
      body: {
        title: spec.title,
        head: spec.headBranch,
        base: spec.baseBranch,
        body: spec.body,
      },
    })).json() as RawPull
    if (typeof pull.html_url !== 'string' || pull.html_url.trim() === '') {
      throw new TypeError('github: pull request response returned no usable html_url')
    }
    return pull.html_url.trim()
  }

  return {
    id: FORGE_ID,
    capabilities: CAPABILITIES,
    fetchDiff,
    fetchFile,
    createComment,
    updateComment,
    createInlineComments,
    findStickyComment,
    resolvePermission,
    isFork,
    botIdentity,
    listFailedChecks,
    fetchLog,
    commitPatches,
    openPullRequest,
  }
}

/**
 * Registration is effect-based: `ctx.effect` ties the registry disposer to this
 * plugin's fiber, so unloading the plugin unregisters the gateway.
 */
export function apply(ctx: Context, config: Config): void {
  const dshrb = ctx.get('dshrb')
  const gateway = createGitHubGateway(config, {
    fetch: globalThis.fetch,
    // Shared config first (Web UI + env fallback), then this plugin's own
    // config for standalone deployments without the bundle. When the shared
    // namespace is present it is authoritative: the `dshrb` base layer already
    // carries the `FORGE_TOKEN` env fallback, so falling back to `config.token`
    // here would make a Web UI "Clear" ineffective (the legacy token would
    // resurface after the user cleared the settings document).
    getToken: () => (dshrb === undefined ? config.token : dshrb.get().githubToken),
  })
  ctx.effect(() => ctx.forges.register(gateway))
}
