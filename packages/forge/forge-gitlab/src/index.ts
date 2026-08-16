/**
 * GitLab ForgeGateway provider (REST v4).
 *
 * The iid trap: a merge request has both a global `id` and a project-scoped
 * `iid`. Note APIs take the `iid`, while webhook payloads carry both. Mixing
 * them posts comments onto an unrelated MR. This provider normalizes to `iid`
 * only, surfaced as `ChangeRequestId`, and never reads `object_attributes.id`.
 * See docs/06-forge-abstraction.md.
 *
 * `CommentId` here is the note's numeric id prefixed with the MR `iid`
 * (`"<iid>:<noteId>"`). GitLab has no project-global note-update endpoint — a
 * note is only addressable under its noteable — and `CommentSink.updateComment`
 * receives only `repo` + `id`, so the id carries its own routing context.
 */
import { publishIdempotencyKey } from '@dshrb/forge'
import type {
  ActorResolver, BotIdentity, CheckReader, CheckRun, CommentSink, DiffFile, DiffHunk,
  DiffSource, ForgeCapability, ForgePermission, MutationSink, PublishStats, PullRequestSpec,
  UnifiedDiff,
} from '@dshrb/forge'
import {
  changeRequestId, commentId, commitSha, forgeId, isAnchored, isSafeRelativePath,
} from '@dshrb/review-core'
import type {
  ChangeRequestId, CommentId, CommitSha, Finding, ForgeId, Patch, ReviewTarget,
} from '@dshrb/review-core'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-forge-gitlab'
export const inject = ['forges']

export const FORGE_ID: ForgeId = forgeId('gitlab')

export const CAPABILITIES: readonly ForgeCapability[] = [
  'diff-source', 'comment-sink', 'inline-comments', 'sticky-comment',
  'actor-resolver', 'check-reader', 'mutation-sink',
]

/** Marks our sticky comment. Must be the FIRST line to be recognized as ours. */
export const STICKY_MARKER_PREFIX = '<!-- dshrb:sticky:'

/** Carries the per-finding publish idempotency key inside a posted note. */
const IDEMPOTENCY_MARKER_PREFIX = '<!-- dshrb:key:'
const IDEMPOTENCY_MARKER_RE = /<!--\s*dshrb:key:([0-9a-f]{64})\s*-->\s*$/u

/** Bounds pagination so a pathological MR cannot spin forever. */
const MAX_PAGES = 20
const PER_PAGE = 100

export interface Config {
  token: string
  /** GitLab instance base URL, including the `/api/v4` suffix. */
  baseUrl: string
}

export const Config: Schema<Config> = Schema.object({
  token: Schema.string().default(''),
  baseUrl: Schema.string().default('https://gitlab.com/api/v4'),
})

/** The subset of `fetch` this provider uses, named so tests can supply a stub. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface GitLabDeps {
  readonly fetch: FetchLike
  /**
   * Resolves the private token on each request. Defaults to `config.token`;
   * the bundle wires this to the shared `ctx.dshrb` config so a token edited
   * in the Web UI takes effect without a restart.
   */
  readonly getToken?: () => string
}

/** Thrown for any non-2xx REST response. Never includes the token. */
export class GitLabApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`gitlab: ${method} ${path} failed with ${String(status)}: ${detail}`)
    this.name = 'GitLabApiError'
  }
}

export interface GitLabGateway
  extends DiffSource, CommentSink, ActorResolver, CheckReader, MutationSink {}

// ---------------------------------------------------------------------------
// Input validation
//
// Repo path, MR iid, login and numeric ids all arrive from untrusted webhook
// payloads and land inside a URL path. Validated against strict patterns so a
// value like `../orgs/x` cannot escape its path segment.
// ---------------------------------------------------------------------------

function assertRepo(repo: string): string {
  const trimmed = repo.trim()
  const segments = trimmed.split('/')
  // `path_with_namespace` is one or more namespace slugs plus the project slug,
  // so at least two segments; each slug is alphanumeric plus `._-` (spaces are
  // URL-encoded away in GitLab's own `path`, unlike its display `name`).
  const valid = segments.length >= 2 && segments.every((seg) => /^[A-Za-z0-9._-]+$/u.test(seg))
  if (!valid) {
    throw new TypeError(`gitlab: repo must be a namespace/project path, got '${excerpt(repo)}'`)
  }
  return trimmed
}

/** URL-encodes the whole path so `acme/widgets` becomes the `:id` GitLab expects. */
function projectSegment(repo: string): string {
  return encodeURIComponent(assertRepo(repo))
}

function assertIid(raw: string): string {
  return assertNumericId('changeRequestId (iid)', raw)
}

function assertLogin(login: string): string {
  const trimmed = login.trim()
  // GitLab usernames are `[A-Za-z0-9_.-]+` (no brackets, unlike GitHub bot logins).
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u.test(trimmed)) {
    throw new TypeError(`gitlab: invalid actor login '${excerpt(login)}'`)
  }
  return trimmed
}

function assertNumericId(kind: string, raw: string): string {
  const trimmed = raw.trim()
  if (!/^[1-9][0-9]*$/u.test(trimmed)) {
    throw new TypeError(`gitlab: ${kind} must be a positive integer, got '${excerpt(raw)}'`)
  }
  return trimmed
}

function assertSafePath(path: string): string {
  const trimmed = path.trim()
  if (!isSafeRelativePath(trimmed)) {
    throw new TypeError(`gitlab: path must be repo-relative, got '${excerpt(path)}'`)
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
 * GitLab `access_level` numeric tiers → `ForgePermission`. GitLab has no exact
 * `triage` tier, so `Reporter` (20) maps to `read` rather than inventing a
 * privilege GitLab does not grant. Anything unrecognized — a future tier, a
 * null, a typo — fails closed to `none`.
 */
const ACCESS_LEVEL_MAP: Readonly<Record<number, ForgePermission>> = Object.freeze({
  50: 'admin',       // Owner
  40: 'maintain',     // Maintainer
  30: 'write',        // Developer
  20: 'read',         // Reporter
  10: 'read',         // Guest
  5: 'none',          // Minimal access
  0: 'none',          // No access
})

export function mapAccessLevel(raw: unknown): ForgePermission {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return 'none'
  }
  return ACCESS_LEVEL_MAP[raw] ?? 'none'
}

/** GitLab job status → `CheckRun.conclusion`; only failed statuses matter here. */
function mapJobConclusion(status: string): CheckRun['conclusion'] | undefined {
  if (status === 'failed') return 'failure'
  if (status === 'canceled') return 'cancelled'
  return undefined
}

// ---------------------------------------------------------------------------
// Diff parsing
//
// GitLab's `changes[].diff` is the bare `@@` hunk sequence (no file preamble),
// the same shape as GitHub's `patch`. The parser skips any preamble anyway, so
// it accepts both shapes.
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u

export function parseHunks(patch: string): readonly DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: { header: RegExpExecArray; lines: string[] } | undefined

  const flush = (): void => {
    if (current === undefined) return
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
// Comment bodies (byte-identical conventions to forge-github so a marker never
// drifts between providers)
// ---------------------------------------------------------------------------

export function stickyMarker(marker: string): string {
  return `${STICKY_MARKER_PREFIX}${marker} -->`
}

export function withIdempotencyMarker(body: string, key: string): string {
  return `${body}\n\n${IDEMPOTENCY_MARKER_PREFIX}${key} -->`
}

export function extractIdempotencyKey(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined
  return IDEMPOTENCY_MARKER_RE.exec(body)?.[1]
}

function hasStickyMarkerOnFirstLine(body: unknown, marker: string): boolean {
  if (typeof body !== 'string') return false
  return (body.split('\n', 1)[0] ?? '').trim() === stickyMarker(marker)
}

function findingCommentBody(finding: Finding): string {
  return `**${finding.severity}**: ${finding.title}\n\n${finding.body}`
}

// ---------------------------------------------------------------------------
// Unified diff application (MutationSink.commitPatches)
//
// The Commits API `actions` take full file content, not a diff, so each patch's
// diff is applied to the base content fetched at the project default branch.
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

function splitLines(content: string): PatchLine[] {
  if (content === '') return []
  const endsWithNewline = content.endsWith('\n')
  const parts = content.split('\n')
  const texts = endsWithNewline ? parts.slice(0, -1) : parts
  return texts.map((text, i) => ({ text, newline: endsWithNewline || i < texts.length - 1 }))
}

function joinLines(lines: readonly PatchLine[]): string {
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
 * must be reported, not silently mis-applied.
 */
export function applyPatch(content: string, diff: string): ApplyPatchResult {
  const oldLines = splitLines(content)
  const result: PatchLine[] = []
  let cursor = 0
  const lines = diff.split('\n')
  let index = 0

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
  return { ok: true, content: joinLines(result) }
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/** Constant-time comparison: a timing side channel here leaks how close a guess is. */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < bufA.length; i += 1) {
    diff |= bufA[i]! ^ bufB[i]!
  }
  return diff === 0
}

/**
 * Verifies a GitLab webhook's `X-Gitlab-Token` header against the configured
 * secret. GitLab signs webhooks by echoing the secret verbatim (no HMAC), so the
 * check is a constant-time equality — never `===`, which short-circuits on the
 * first differing byte and leaks the secret length/prefix.
 */
export function verifyGitLabToken(secret: string, token: string): boolean {
  if (secret === '' || token === '') return false
  return timingSafeEqual(secret, token)
}

// ---------------------------------------------------------------------------
// Webhook payload normalization (iid, never id)
// ---------------------------------------------------------------------------

export interface NormalizedMergeRequest {
  readonly repo: string
  /** The project-scoped `iid`, never the global `id`. */
  readonly changeRequestId: ChangeRequestId
  readonly isFork: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/**
 * Normalizes a GitLab `merge_request` webhook payload into the fields the
 * runtime consumes. The global `object_attributes.id` is deliberately never
 * read: the `ChangeRequestId` is the project-scoped `iid`, and `isFork` is
 * `source_project_id !== target_project_id` (docs/06:96). A payload with an
 * `id` but no `iid` is rejected rather than silently falling back.
 */
export function normalizeMergeRequest(payload: unknown): NormalizedMergeRequest {
  const root = asRecord(payload)
  const attributes = root === undefined ? undefined : asRecord(root.object_attributes)
  if (attributes === undefined) {
    throw new TypeError('gitlab: merge_request payload has no object_attributes')
  }

  const iid = numberField(attributes, 'iid')
  if (iid === undefined || iid < 1) {
    throw new TypeError('gitlab: merge_request payload has no usable object_attributes.iid')
  }

  const project = root === undefined ? undefined : asRecord(root.project)
  const repo = project === undefined ? undefined
    : (typeof project.path_with_namespace === 'string' ? project.path_with_namespace.trim() : undefined)
  const fallbackRepo = asRecord(attributes.target)?.path_with_namespace
  const resolvedRepo = repo ?? (typeof fallbackRepo === 'string' ? fallbackRepo.trim() : undefined)
  if (resolvedRepo === undefined || resolvedRepo === '') {
    throw new TypeError('gitlab: merge_request payload has no project.path_with_namespace')
  }

  const source = numberField(attributes, 'source_project_id')
  const target = numberField(attributes, 'target_project_id')
  // Missing project ids mean the API shape changed; fail closed to fork.
  const isFork = source === undefined || target === undefined ? true : source !== target

  return {
    repo: assertRepo(resolvedRepo),
    changeRequestId: changeRequestId(String(iid)),
    isFork,
  }
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export function createGitLabGateway(config: Config, deps: GitLabDeps): GitLabGateway {
  const baseUrl = config.baseUrl.replace(/\/+$/u, '')
  if (!/^https?:\/\//u.test(baseUrl)) {
    throw new TypeError('gitlab: baseUrl must be an http(s) URL')
  }
  const { token } = config
  const getToken = deps.getToken ?? (() => token)

  async function request(method: string, path: string, extra?: {
    body?: unknown
    accept?: string
  }): Promise<Response> {
    const headers: Record<string, string> = {
      // The credential is attached here and nowhere else in the process.
      'PRIVATE-TOKEN': getToken(),
      accept: extra?.accept ?? 'application/json',
      'user-agent': 'dsh-reviewer-bot',
    }
    // Redirects must not be followed: the credential would travel with them to
    // whatever host GitLab points at. GitLab's API answers directly, so any
    // redirect is an unexpected shape and fails loudly here.
    const init: RequestInit = { method, headers, redirect: 'error' }
    if (extra?.body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(extra.body)
    }
    const response = await deps.fetch(`${baseUrl}${path}`, init)
    if (!response.ok) {
      const detail = await response.text().then(excerpt).catch(() => '<unreadable>')
      throw new GitLabApiError(response.status, method, path, detail)
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
      const batch = await getJson<T[]>(`${path}${separator}per_page=${String(PER_PAGE)}&page=${String(page)}`)
      if (!Array.isArray(batch)) {
        throw new TypeError(`gitlab: expected an array from ${path}`)
      }
      items.push(...batch)
      if (batch.length < PER_PAGE) {
        break
      }
    }
    return items
  }

  function mrPath(target: ReviewTarget): string {
    return `/projects/${projectSegment(target.repo)}/merge_requests/${assertIid(target.changeRequestId)}`
  }

  // -- DiffSource -----------------------------------------------------------

  async function fetchDiff(target: ReviewTarget): Promise<UnifiedDiff> {
    interface RawChange {
      old_path?: unknown
      new_path?: unknown
      diff?: unknown
    }
    const raw = await getJson<{ changes?: unknown }>(`${mrPath(target)}/changes`)
    const changes = Array.isArray(raw.changes) ? raw.changes as RawChange[] : []
    const files: DiffFile[] = []
    for (const entry of changes) {
      const path = typeof entry.new_path === 'string' ? entry.new_path.trim() : ''
      if (!isSafeRelativePath(path)) {
        continue
      }
      const oldPath = typeof entry.old_path === 'string' ? entry.old_path.trim() : ''
      const previousPath = oldPath !== '' && oldPath !== path && isSafeRelativePath(oldPath)
        ? oldPath
        : undefined
      const patch = typeof entry.diff === 'string' ? entry.diff : ''
      // GitLab returns an empty `diff` for binary blobs (no line diff exists).
      files.push({
        path,
        binary: patch === '',
        hunks: patch === '' ? [] : parseHunks(patch),
        ...(previousPath === undefined ? {} : { previousPath }),
      })
    }
    return { files }
  }

  async function fetchFile(repo: string, path: string, sha: CommitSha): Promise<string> {
    const safePath = assertSafePath(path)
    // GitLab's repository-files endpoint takes the file path as a single
    // URL-encoded segment: `src/app.ts` → `src%2Fapp.ts`.
    const encoded = encodeURIComponent(safePath)
    const response = await request(
      'GET',
      `/projects/${projectSegment(repo)}/repository/files/${encoded}/raw?ref=${encodeURIComponent(sha)}`,
      { accept: 'text/plain' },
    )
    return await response.text()
  }

  // -- CommentSink ----------------------------------------------------------

  async function createComment(target: ReviewTarget, body: string): Promise<CommentId> {
    const iid = assertIid(target.changeRequestId)
    const created = await (await request('POST', `${mrPath(target)}/notes`, {
      body: { body },
    })).json() as { id?: unknown }
    const noteId = typeof created.id === 'number' ? String(created.id)
      : typeof created.id === 'string' ? created.id
        : ''
    return commentId(`${iid}:${noteId}`)
  }

  function parseCommentId(id: CommentId): { readonly iid: string; readonly noteId: string } {
    const separator = id.indexOf(':')
    if (separator <= 0 || separator === id.length - 1) {
      throw new TypeError(`gitlab: comment id must be '<iid>:<noteId>', got '${excerpt(id)}'`)
    }
    const iid = assertIid(id.slice(0, separator))
    const noteId = assertNumericId('noteId', id.slice(separator + 1))
    return { iid, noteId }
  }

  async function updateComment(repo: string, id: CommentId, body: string): Promise<void> {
    const { iid, noteId } = parseCommentId(id)
    await request('PUT', `/projects/${projectSegment(repo)}/merge_requests/${iid}/notes/${noteId}`, {
      body: { body },
    })
  }

  async function createInlineComments(
    target: ReviewTarget, findings: readonly Finding[], botId: string,
  ): Promise<PublishStats> {
    const iid = assertIid(target.changeRequestId)

    interface RawNote { id?: unknown; body?: unknown; author?: { id?: unknown } | null }
    const existing = await getPaged<RawNote>(`${mrPath(target)}/notes`)
    const publishedKeys = new Set<string>()
    for (const note of existing) {
      const authorId = note.author?.id
      if (authorId === undefined || authorId === null || String(authorId) !== botId) {
        continue
      }
      const key = extractIdempotencyKey(note.body)
      if (key !== undefined) {
        publishedKeys.add(key)
      }
    }

    let published = 0
    let degradedToSummary = 0
    let failed = 0

    interface DiffRefs { readonly baseSha: string; readonly headSha: string; readonly startSha: string }
    let diffRefs: DiffRefs | undefined

    // The three position SHAs must come from the MR's `diff_refs`, never the
    // head sha (docs/06:113). Missing `diff_refs` is an explicit failure, not a
    // default — a self-hosted instance that omits it must not have its inline
    // notes silently placed with a fabricated SHA. It is resolved lazily so an
    // all-unanchored batch, or a batch whose anchored findings were already
    // published, degrades to the summary instead of failing on a `diff_refs`
    // that no finding here actually needs.
    async function resolveDiffRefs(): Promise<DiffRefs> {
      if (diffRefs !== undefined) {
        return diffRefs
      }
      const mr = await getJson<{ diff_refs?: unknown }>(mrPath(target))
      const refs = asRecord(mr.diff_refs)
      const baseSha = refs === undefined ? undefined
        : (typeof refs.base_sha === 'string' ? refs.base_sha : undefined)
      const headSha = refs === undefined ? undefined
        : (typeof refs.head_sha === 'string' ? refs.head_sha : undefined)
      const startSha = refs === undefined ? undefined
        : (typeof refs.start_sha === 'string' ? refs.start_sha : undefined)
      if (baseSha === undefined || headSha === undefined || startSha === undefined) {
        throw new TypeError(`gitlab: merge request ${iid} has no usable diff_refs; cannot anchor inline notes`)
      }
      diffRefs = { baseSha, headSha, startSha }
      return diffRefs
    }

    for (const finding of findings) {
      if (!isAnchored(finding.anchor)) {
        degradedToSummary += 1
        continue
      }
      const key = publishIdempotencyKey(finding)
      if (publishedKeys.has(key)) {
        continue
      }
      const safePath = assertSafePath(finding.anchor.path)
      const refs = await resolveDiffRefs()
      const position = finding.anchor.side === 'left'
        ? {
            base_sha: refs.baseSha, head_sha: refs.headSha, start_sha: refs.startSha,
            old_path: safePath, old_line: finding.anchor.line,
            new_path: safePath, new_line: null, position_type: 'text',
          }
        : {
            base_sha: refs.baseSha, head_sha: refs.headSha, start_sha: refs.startSha,
            new_path: safePath, new_line: finding.anchor.line,
            old_path: safePath, old_line: null, position_type: 'text',
          }
      try {
        await request('POST', `${mrPath(target)}/notes`, {
          body: {
            body: withIdempotencyMarker(findingCommentBody(finding), key),
            position,
          },
        })
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
    const iid = assertIid(target.changeRequestId)
    interface RawNote { id?: unknown; body?: unknown; author?: { id?: unknown } | null }
    const notes = await getPaged<RawNote>(`${mrPath(target)}/notes`)
    for (const note of notes) {
      const authorId = note.author?.id
      if (authorId === undefined || authorId === null || String(authorId) !== botId) {
        continue
      }
      if (!hasStickyMarkerOnFirstLine(note.body, marker)) {
        continue
      }
      const noteId = typeof note.id === 'number' ? String(note.id)
        : typeof note.id === 'string' ? note.id
          : ''
      return commentId(`${iid}:${noteId}`)
    }
    return undefined
  }

  // -- ActorResolver --------------------------------------------------------

  async function resolvePermission(repo: string, actorLogin: string): Promise<ForgePermission> {
    const login = assertLogin(actorLogin)
    const project = projectSegment(repo)
    try {
      const users = await getJson<unknown>(`/users?username=${encodeURIComponent(login)}`)
      const first = Array.isArray(users) ? users[0] : undefined
      const record = asRecord(first)
      const userId = record === undefined ? undefined : numberField(record, 'id')
      if (userId === undefined) {
        return 'none'
      }
      interface RawMember { access_level?: unknown }
      const member = await getJson<RawMember>(`/projects/${project}/members/${String(userId)}`)
      return mapAccessLevel(member.access_level)
    } catch (error) {
      // 404 means "not a visible member" and 403 means "not visible to this
      // token", both of which are `none`. Any other status is a real fault.
      if (error instanceof GitLabApiError && (error.status === 404 || error.status === 403)) {
        return 'none'
      }
      throw error
    }
  }

  async function isFork(target: ReviewTarget): Promise<boolean> {
    const raw = await getJson<Record<string, unknown>>(mrPath(target))
    const source = numberField(raw, 'source_project_id')
    const targetId = numberField(raw, 'target_project_id')
    // Missing ids mean the API shape changed; fail closed to fork.
    if (source === undefined || targetId === undefined) {
      return true
    }
    return source !== targetId
  }

  async function botIdentity(): Promise<BotIdentity> {
    interface RawUser { id?: unknown; username?: unknown }
    const raw = await getJson<RawUser>('/user')
    if (typeof raw.id !== 'number' && typeof raw.id !== 'string') {
      throw new TypeError('gitlab: /user returned no usable numeric id')
    }
    return {
      id: String(raw.id),
      login: typeof raw.username === 'string' ? raw.username : '',
    }
  }

  // -- CheckReader ----------------------------------------------------------

  async function listFailedChecks(repo: string, sha: CommitSha): Promise<readonly CheckRun[]> {
    const project = projectSegment(repo)
    interface RawPipeline { id?: unknown; status?: unknown }
    const pipelines = await getPaged<RawPipeline>(`/projects/${project}/pipelines?sha=${encodeURIComponent(sha)}`)
    const runs: CheckRun[] = []
    for (const pipeline of pipelines) {
      if (pipeline.status !== 'failed' && pipeline.status !== 'canceled') {
        continue
      }
      const pipelineId = typeof pipeline.id === 'number' ? String(pipeline.id)
        : typeof pipeline.id === 'string' ? pipeline.id
          : ''
      if (pipelineId === '') {
        continue
      }
      interface RawJob { id?: unknown; name?: unknown; status?: unknown }
      const jobs = await getPaged<RawJob>(`/projects/${project}/pipelines/${pipelineId}/jobs`)
      for (const job of jobs) {
        if (typeof job.status !== 'string') {
          continue
        }
        const conclusion = mapJobConclusion(job.status)
        if (conclusion === undefined) {
          continue
        }
        runs.push({
          id: typeof job.id === 'number' ? String(job.id) : (typeof job.id === 'string' ? job.id : ''),
          name: typeof job.name === 'string' ? job.name : '',
          conclusion,
        })
      }
    }
    return runs
  }

  async function fetchLog(repo: string, checkId: string): Promise<string> {
    const project = projectSegment(repo)
    const jobId = assertNumericId('checkId (job id)', checkId)
    const response = await request('GET', `/projects/${project}/jobs/${jobId}/trace`, {
      accept: 'text/plain',
    })
    return await response.text()
  }

  // -- MutationSink ---------------------------------------------------------

  async function commitPatches(
    repo: string, branch: string, patches: readonly Patch[], message: string,
  ): Promise<CommitSha> {
    const project = projectSegment(repo)
    if (patches.length === 0) {
      throw new TypeError('gitlab: commitPatches received no patches')
    }
    // The head branch does not exist yet; fork it from the project default
    // branch, which is the only sane base the `MutationSink` interface exposes
    // (it passes no base sha/branch).
    interface RawProject { default_branch?: unknown }
    const rawProject = await getJson<RawProject>(`/projects/${project}`)
    if (typeof rawProject.default_branch !== 'string' || rawProject.default_branch.trim() === '') {
      throw new TypeError('gitlab: project returned no usable default_branch')
    }
    const baseBranch = rawProject.default_branch.trim()

    interface RawAction { action: 'create' | 'update'; file_path: string; content: string }
    const actions: RawAction[] = []
    // Group patches by path so multiple hunks against the same file apply
    // cumulatively (the runtime's mutate stage applies them sequentially).
    // Without grouping, two patches on one path would emit duplicate
    // `file_path` actions, which GitLab's Commits API rejects with a 400.
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
      const encoded = encodeURIComponent(filePath)
      let content = ''
      let exists = true
      try {
        const response = await request(
          'GET',
          `/projects/${project}/repository/files/${encoded}/raw?ref=${encodeURIComponent(baseBranch)}`,
          { accept: 'text/plain' },
        )
        content = await response.text()
      } catch (error) {
        if (error instanceof GitLabApiError && error.status === 404) {
          exists = false
        } else {
          throw error
        }
      }
      for (const patch of group) {
        const applied = applyPatch(content, patch.diff)
        if (!applied.ok || applied.content === undefined) {
          throw new TypeError(`gitlab: patch for '${excerpt(patch.path)}' does not apply: ${applied.reason ?? 'unknown'}`)
        }
        content = applied.content
      }
      actions.push({ action: exists ? 'update' : 'create', file_path: filePath, content })
    }

    interface RawCommit { id?: unknown }
    const commit = await (await request('POST', `/projects/${project}/repository/commits`, {
      body: {
        branch,
        start_branch: baseBranch,
        commit_message: message,
        actions,
      },
    })).json() as RawCommit
    if (typeof commit.id !== 'string' || commit.id.trim() === '') {
      throw new TypeError('gitlab: commit response returned no usable id')
    }
    return commitSha(commit.id)
  }

  async function openPullRequest(spec: PullRequestSpec): Promise<string> {
    const project = projectSegment(spec.repo)
    interface RawMr { web_url?: unknown }
    const mr = await (await request('POST', `/projects/${project}/merge_requests`, {
      body: {
        source_branch: spec.headBranch,
        target_branch: spec.baseBranch,
        title: spec.title,
        description: spec.body,
      },
    })).json() as RawMr
    if (typeof mr.web_url !== 'string' || mr.web_url.trim() === '') {
      throw new TypeError('gitlab: merge request response returned no usable web_url')
    }
    return mr.web_url.trim()
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
  const gateway = createGitLabGateway(config, {
    fetch: globalThis.fetch,
    // Shared config first (Web UI + env fallback), then this plugin's own
    // config for standalone deployments without the bundle.
    getToken: () => (dshrb === undefined ? config.token : dshrb.get().gitlabToken || config.token),
  })
  ctx.effect(() => ctx.forges.register(gateway))
}
