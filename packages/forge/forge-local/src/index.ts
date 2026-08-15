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
 *   - MutationSink      -> real (`git commit` on a branch of the working tree)
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

/** Terminal prefix for every "comment" this provider prints. */
export const COMMENT_PREFIX = '[dshrb:local]'

export interface Config {
  /** Absolute path to the local git working tree. */
  root: string
  /**
   * When true, `fetchDiff` diffs the working tree (tracked staged + unstaged
   * changes) against `baseSha` with a single-argument `git diff`, and the
   * `headSha` is ignored. This is how `dshrb review --local` reviews uncommitted
   * changes — there is no head commit to diff, so `headSha` cannot express it.
   */
  workingTree: boolean
}

export const Config: Schema<Config> = Schema.object({
  root: Schema.string().default(process.cwd()),
  workingTree: Schema.boolean().default(false),
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
export class NoChangesToCommitError extends Error {
  readonly code = 'E_NO_CHANGES'
  constructor() {
    super('local: nothing to commit — the applied patches left the working tree unchanged')
    this.name = 'NoChangesToCommitError'
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

/**
 * Rejects branch names git itself would not accept as a single `checkout`
 * argument (docs/03 write-mode: the controller-derived branch is an untrusted
 * string). `git check-ref-format` is the authority, but this pure pre-check
 * keeps malformed names from ever reaching a subprocess.
 */
function assertSafeBranch(branch: string): string {
  const trimmed = branch.trim()
  const forbidden = '~^:?*[]\\'
  const hasControl = [...trimmed].some((ch) => {
    const code = ch.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })
  const unsafe = trimmed === '' || trimmed === '@'
    || trimmed.startsWith('-') || trimmed.startsWith('/')
    || trimmed.endsWith('/') || trimmed.endsWith('.')
    || trimmed.includes('..') || trimmed.includes('@{') || trimmed.includes('//')
    || /\s/u.test(trimmed) || hasControl
    || [...trimmed].some((ch) => forbidden.includes(ch))
  if (unsafe) {
    throw new TypeError(`local: invalid branch name '${excerpt(branch)}'`)
  }
  return trimmed
}

/** Checks out (creating when absent) the write branch for a mutation. */
async function ensureBranch(git: GitRunner, branch: string): Promise<void> {
  const safeBranch = assertSafeBranch(branch)
  try {
    await git(['rev-parse', '--verify', safeBranch])
    await git(['checkout', safeBranch])
  } catch {
    await git(['checkout', '-b', safeBranch])
  }
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
 * Undoes git's C-style path quoting. Git wraps a path in double quotes and
 * escapes the bytes it cannot print verbatim: `\\` and `\"`, the common control
 * escapes, and octal `\NNN` for non-ASCII bytes. A UTF-8 filename is escaped
 * one byte at a time, so the bytes are reassembled before UTF-8 decoding. The
 * decoded path is validated by `isSafeRelativePath` before it is ever used.
 */
function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed
  }
  const body = trimmed.slice(1, -1)
  const bytes: number[] = []
  const simpleEscapes: Record<string, number> = {
    '\\': 0x5c, '"': 0x22, a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d,
  }
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!
    if (ch !== '\\') {
      bytes.push(ch.charCodeAt(0))
      continue
    }
    const next = body[i + 1]
    if (next === undefined) {
      bytes.push(ch.charCodeAt(0))
      continue
    }
    const simple = simpleEscapes[next]
    if (simple !== undefined) {
      bytes.push(simple)
      i += 1
      continue
    }
    if (next >= '0' && next <= '7') {
      let octal = ''
      let digits = 0
      while (digits < 3 && body[i + 1 + digits] !== undefined
        && body[i + 1 + digits]! >= '0' && body[i + 1 + digits]! <= '7') {
        octal += body[i + 1 + digits]!
        digits += 1
      }
      bytes.push(Number.parseInt(octal, 8) & 0xff)
      i += digits
      continue
    }
    // Unknown escape: keep the backslash literally and let the following
    // character be consumed as an ordinary byte on the next iteration.
    bytes.push(ch.charCodeAt(0))
  }
  return Buffer.from(bytes).toString('utf8')
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

/**
 * Splits the two path halves of a `diff --git` header. Git emits one of two
 * shapes:
 *
 *   diff --git a/foo b/foo          (unquoted — a plain space is not quoted)
 *   diff --git "a/foo" "b/foo"      (C-quoted — non-ASCII, quotes, backslashes)
 *
 * A quoted half is delimited by its quotes, so a space inside it cannot split
 * the pair. An unquoted half is split on the first ` b/` that follows the `a/`
 * half (a path containing the literal substring ` b/` is pathological and out
 * of scope, matching the ambiguity of git's own unquoted format).
 */
function parseDiffGitHeader(header: string): readonly [string, string] | undefined {
  const prefix = 'diff --git '
  if (!header.startsWith(prefix)) return undefined
  const rest = header.slice(prefix.length)

  if (rest.startsWith('"')) {
    const halves: string[] = []
    let i = 0
    while (i < rest.length && halves.length < 2) {
      while (i < rest.length && rest[i] === ' ') i += 1
      if (i >= rest.length || rest[i] !== '"') break
      let j = i + 1
      while (j < rest.length) {
        if (rest[j] === '\\' && j + 1 < rest.length) {
          j += 2
          continue
        }
        if (rest[j] === '"') break
        j += 1
      }
      if (j >= rest.length) return undefined // unterminated quote
      halves.push(rest.slice(i, j + 1))
      i = j + 1
    }
    if (halves.length !== 2) return undefined
    return [halves[0]!, halves[1]!]
  }

  const sep = rest.indexOf(' b/')
  if (sep < 0) return undefined
  return [rest.slice(0, sep), rest.slice(sep + 1)]
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
  // `diff --git` header, which carries both paths (quoted or not).
  if (newPath === undefined && oldPath === undefined) {
    const parsed = parseDiffGitHeader(lines[0] ?? '')
    if (parsed !== undefined) {
      oldPath = stripGitPrefix(unquoteGitPath(parsed[0]), 'a/')
      newPath = stripGitPrefix(unquoteGitPath(parsed[1]), 'b/')
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
    const args = config.workingTree
      ? ['diff', '--no-color', '--no-ext-diff', '--find-renames', '--unified=3', base]
      : ['diff', '--no-color', '--no-ext-diff', '--find-renames', '--unified=3', base, assertSha(target.headSha)]
    const output = await deps.git(args)
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
    _repo: string, branch: string, patches: readonly Patch[], message: string,
  ): Promise<CommitSha> {
    // The runtime's mutate stage already landed the bytes through `ctx.fs`; the
    // local sink's job is only to turn the working-tree change set into a commit.
    await ensureBranch(deps.git, branch)
    const paths = patches.map((patch) => assertSafePath(patch.path))
    if (paths.length === 0) {
      throw new NoChangesToCommitError()
    }
    await deps.git(['add', '--', ...paths])

    // Second confirmation that the applied patches actually changed a file
    // (docs/03): a no-op patch stages nothing and must not produce a commit.
    const staged = await deps.git(['diff', '--cached', '--name-only'])
    if (staged.trim() === '') {
      throw new NoChangesToCommitError()
    }

    await deps.git(['commit', '-m', message])
    const sha = (await deps.git(['rev-parse', 'HEAD'])).trim()
    return commitSha(sha)
  }

  async function openPullRequest(spec: PullRequestSpec): Promise<string> {
    const head = assertSafeBranch(spec.headBranch)
    deps.write(`${COMMENT_PREFIX} pull-request (local): ${head} → ${spec.baseBranch}`)
    // A hosted provider returns the PR URL; the local dry-run has no remote, so
    // the branch reference is the honest stand-in.
    return `local://branch/${head}`
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
