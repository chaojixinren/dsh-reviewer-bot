/**
 * Local git ForgeGateway provider.
 *
 * Makes the developer's own working tree look like just another forge so
 * `review-runtime` never has to learn whether it is running in CI or on a
 * laptop. This is the key that makes B4 (local dry-run) work: `review --local`
 * checks out nothing, talks to no network, and holds no credential — it just
 * diffs two commits in the local repository and prints its "comments" to the
 * terminal.
 *
 * Capability mapping follows docs/06-forge-abstraction.md:
 *   - DiffSource        -> real (`git diff` + working-tree read)
 *   - CommentSink       -> printed to the terminal (the local equivalent)
 *   - ActorResolver     -> the local actor is always the owner
 *   - MutationSink      -> declared but NOT implemented; throws at the M3
 *                          boundary, matching forge-github
 *   - CheckReader       -> unsupported (no CI in a local dry-run), so the
 *                          capability is deliberately NOT advertised
 *   - sticky-comment    -> N/A (no persistent comment store), not advertised
 */
import { execFile } from 'node:child_process'
import { readFile as readFileNode } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  ActorResolver, BotIdentity, CommentSink, DiffFile, DiffHunk, DiffSource,
  ForgeCapability, ForgePermission, MutationSink, PublishStats, PullRequestSpec,
  UnifiedDiff,
} from '@dshrb/forge'
import {
  commentId, commitSha, forgeId, isAnchored, isSafeRelativePath,
} from '@dshrb/review-core'
import type { CommentId, CommitSha, Finding, ForgeId, Patch, ReviewTarget } from '@dshrb/review-core'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-forge-local'
export const inject = ['forges']

export const FORGE_ID: ForgeId = forgeId('local')

/** Advertised so `review --local` resolves every capability the pipeline asks for. */
export const CAPABILITIES: readonly ForgeCapability[] = [
  'diff-source', 'comment-sink', 'inline-comments', 'actor-resolver', 'mutation-sink',
]

/**
 * Declared for interface parity with the other providers but not yet
 * implemented; the methods throw `ForgeUnimplementedError` rather than report a
 * success they did not perform. Exported so a caller can assert the M3 boundary
 * up front instead of discovering it mid-pipeline.
 */
export const UNIMPLEMENTED_CAPABILITIES: readonly ForgeCapability[] = ['mutation-sink']

/** Terminal prefix for every "comment" this provider prints. */
export const COMMENT_PREFIX = '[dshrb:local]'

export interface Config {
  /** Absolute path to the local git working tree. */
  root: string
}

export const Config: Schema<Config> = Schema.object({
  root: Schema.string().default(process.cwd()),
})

/** Runs `git <args>` in `root` and resolves stdout; rejects on non-zero exit. */
export type GitRunner = (args: readonly string[]) => Promise<string>

/** Reads a repo-relative path from the working tree as UTF-8 text. */
export type FileReader = (relPath: string) => Promise<string>

/** Writes one rendered "comment" line to the terminal. */
export type LineWriter = (line: string) => void

export interface LocalDeps {
  readonly git: GitRunner
  readonly readFile: FileReader
  readonly write: LineWriter
}

/** The M3 boundary, as an explicit refusal rather than a silent success. */
export class ForgeUnimplementedError extends Error {
  readonly code = 'E_FORGE_M3_UNIMPLEMENTED'
  constructor(operation: string) {
    super(`local: ${operation} is declared for M3 but not implemented yet`)
    this.name = 'ForgeUnimplementedError'
  }
}

/** A `git` invocation failed. Never includes a credential (local mode has none). */
export class LocalGitError extends Error {
  constructor(readonly args: readonly string[], readonly detail: string) {
    super(`local: git ${args.join(' ')} failed: ${detail}`)
    this.name = 'LocalGitError'
  }
}

export interface LocalGateway
  extends DiffSource, CommentSink, ActorResolver, MutationSink {}

// ---------------------------------------------------------------------------
// Input validation
//
// SHAs and paths arrive from a locally assembled ReviewTarget, but the same
// invariants the hosted providers enforce still apply: a malformed SHA must
// fail here, not as an opaque git error after we fork a subprocess.
// ---------------------------------------------------------------------------

function assertSha(sha: CommitSha): CommitSha {
  // Re-runs the 7-40 hex invariant and normalizes case, so the value is safe
  // to hand to `git diff` as a positional argument.
  return commitSha(sha)
}

function assertSafePath(path: string): string {
  const trimmed = path.trim()
  if (!isSafeRelativePath(trimmed)) {
    throw new TypeError(`local: path must be repo-relative, got '${excerpt(path)}'`)
  }
  return trimmed
}

function excerpt(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value
}

// ---------------------------------------------------------------------------
// Unified diff parsing
//
// `git diff` output is the raw unified diff with `diff --git`, `---`/`+++`,
// `rename from/to`, and `Binary files` headers. This is a different shape from
// GitHub's per-file `patch` field (which omits the preamble), so the local
// provider parses the full output rather than reusing `parseHunks` alone.
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u

/**
 * Splits a bare sequence of `@@` hunk sections into `DiffHunk`s. A header
 * without an explicit count means exactly one line (`@@ -3 +3 @@`), which is
 * why the count groups default to 1 and not 0.
 */
export function parseHunks(text: string): readonly DiffHunk[] {
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

  for (const line of text.split('\n')) {
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

/** Strips a leading `a/` or `b/` git path prefix. */
function stripGitPrefix(path: string, prefix: 'a/' | 'b/'): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * Undoes git's C-style path quoting for the common case (a quoted path with
 * escaped `\"` and `\\`). Octal escapes are not decoded: they cannot appear in
 * the ASCII paths this repo deals with and would only matter for non-UTF-8
 * filenames, which a review dry-run does not target.
 */
function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/gu, '$1')
  }
  return trimmed
}

function splitFileSections(output: string): readonly string[] {
  const sections: string[] = []
  let current: string[] | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current !== undefined) sections.push(current.join('\n'))
      current = [line]
    } else if (current !== undefined) {
      current.push(line)
    }
  }
  if (current !== undefined) sections.push(current.join('\n'))
  return sections
}

function parseFileSection(section: string): DiffFile | undefined {
  const lines = section.split('\n')
  let oldPath: string | undefined
  let newPath: string | undefined

  for (const line of lines) {
    if (line.startsWith('rename from ')) {
      oldPath ??= unquoteGitPath(line.slice('rename from '.length))
    } else if (line.startsWith('rename to ')) {
      newPath ??= unquoteGitPath(line.slice('rename to '.length))
    } else if (line.startsWith('--- ')) {
      const raw = unquoteGitPath(line.slice(4))
      if (raw !== '/dev/null') {
        oldPath ??= stripGitPrefix(raw, 'a/')
      }
    } else if (line.startsWith('+++ ')) {
      const raw = unquoteGitPath(line.slice(4))
      if (raw !== '/dev/null') {
        newPath ??= stripGitPrefix(raw, 'b/')
      }
    }
  }

  // Binary files and mode-only changes omit `---`/`+++`; fall back to the
  // `diff --git` header, which carries both paths.
  if (newPath === undefined && oldPath === undefined) {
    const header = lines[0] ?? ''
    const match = /^diff --git a\/(.*?) b\/(.*)$/u.exec(header)
    if (match !== null) {
      oldPath = unquoteGitPath(match[1] ?? '')
      newPath = unquoteGitPath(match[2] ?? '')
    }
  }

  const path = newPath ?? oldPath
  if (path === undefined || path === '' || path === '/dev/null' || !isSafeRelativePath(path)) {
    // Nothing outside the repo can be reported on or written to, so a bogus or
    // escaping path is dropped rather than anchoring a comment onto it.
    return undefined
  }

  const previousPath = oldPath !== undefined && oldPath !== path && isSafeRelativePath(oldPath)
    ? oldPath
    : undefined

  const binary = lines.some((line) => line.startsWith('Binary files '))

  return {
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
    hunks: parseHunks(section),
    binary,
  }
}

/** Parses full `git diff` output into the normalized `UnifiedDiff`. */
export function parseGitDiff(output: string): UnifiedDiff {
  const files: DiffFile[] = []
  for (const section of splitFileSections(output)) {
    const file = parseFileSection(section)
    if (file !== undefined) files.push(file)
  }
  return { files }
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export function createLocalGateway(config: Config, deps: LocalDeps): LocalGateway {
  let commentSeq = 0

  function nextCommentId(): CommentId {
    commentSeq += 1
    return commentId(`local-${String(commentSeq)}`)
  }

  function commentBody(finding: Finding): string {
    return `${finding.severity}: ${finding.title}`
  }

  // -- DiffSource -----------------------------------------------------------

  async function fetchDiff(target: ReviewTarget): Promise<UnifiedDiff> {
    const base = assertSha(target.baseSha)
    const head = assertSha(target.headSha)
    const output = await deps.git([
      'diff', '--no-color', '--no-ext-diff', '--find-renames', '--unified=3', base, head,
    ])
    return parseGitDiff(output)
  }

  /**
   * `repo` and `sha` are accepted for interface parity only. A local dry-run
   * has one repository and reads the working tree as it currently stands, so
   * there is no repo to route on and no ref to resolve — the caller is already
   * inside the checkout it wants to inspect.
   */
  async function fetchFile(_repo: string, path: string, _sha: CommitSha): Promise<string> {
    return await deps.readFile(assertSafePath(path))
  }

  // -- CommentSink ----------------------------------------------------------

  async function createComment(target: ReviewTarget, body: string): Promise<CommentId> {
    deps.write(`${COMMENT_PREFIX} comment (${target.repo}):\n${body}`)
    return nextCommentId()
  }

  async function updateComment(_repo: string, id: CommentId, body: string): Promise<void> {
    deps.write(`${COMMENT_PREFIX} update-comment ${id}:\n${body}`)
  }

  async function createInlineComments(
    _target: ReviewTarget, findings: readonly Finding[], _botId: string,
  ): Promise<PublishStats> {
    let published = 0
    let degradedToSummary = 0
    for (const finding of findings) {
      // An unanchored finding is never "posted inline" — even to a terminal — a
      // misplaced comment is worse than a summary entry. It is counted so the
      // caller folds it into the summary, exactly as forge-github does.
      if (!isAnchored(finding.anchor)) {
        degradedToSummary += 1
        continue
      }
      deps.write(
        `${COMMENT_PREFIX} inline ${finding.anchor.path}:${String(finding.anchor.line)} `
        + `${commentBody(finding)}`,
      )
      published += 1
    }
    return { published, degradedToSummary, failed: 0 }
  }

  /**
   * There is no persistent comment store in a local dry-run, so there is never
   * a sticky comment to reuse. Returning `undefined` makes the progress
   * reporter fall back to `createComment` for every stage, which prints the
   * lifecycle to the terminal instead of silently editing nothing.
   */
  async function findStickyComment(
    _target: ReviewTarget, _marker: string, _botId: string,
  ): Promise<CommentId | undefined> {
    return undefined
  }

  // -- ActorResolver --------------------------------------------------------

  /** The local actor is always the owner of the working tree it is standing in. */
  async function resolvePermission(_repo: string, _actorLogin: string): Promise<ForgePermission> {
    return 'admin'
  }

  /** A local working tree is never a fork by definition. */
  async function isFork(_target: ReviewTarget): Promise<boolean> {
    return false
  }

  /** No credential, no remote identity: the "bot" is just the local operator. */
  async function botIdentity(): Promise<BotIdentity> {
    return { id: 'local', login: 'local' }
  }

  // -- MutationSink (M3) ----------------------------------------------------

  async function commitPatches(
    _repo: string, _branch: string, _patches: readonly Patch[], _message: string,
  ): Promise<CommitSha> {
    throw new ForgeUnimplementedError('commitPatches')
  }

  async function openPullRequest(_spec: PullRequestSpec): Promise<string> {
    throw new ForgeUnimplementedError('openPullRequest')
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
    commitPatches,
    openPullRequest,
  }
}

// ---------------------------------------------------------------------------
// Default deps and registration
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)

/** Builds the real deps from a working-tree root. Exported for driver reuse. */
export function createLocalDeps(root: string): LocalDeps {
  return {
    git: async (args) => {
      try {
        const { stdout } = await execFileAsync('git', args, {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        })
        return stdout
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new LocalGitError(args, excerpt(detail))
      }
    },
    readFile: async (relPath) => readFileNode(join(root, relPath), 'utf8'),
    write: (line) => {
      console.log(line)
    },
  }
}

/**
 * Registration is effect-based: `ctx.effect` ties the registry disposer to this
 * plugin's fiber, so unloading the plugin unregisters the gateway.
 */
export function apply(ctx: Context, config: Config): void {
  const gateway = createLocalGateway(config, createLocalDeps(config.root))
  ctx.effect(() => ctx.forges.register(gateway))
}
