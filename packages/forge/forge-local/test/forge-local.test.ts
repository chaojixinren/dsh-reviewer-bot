import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  anchorAt, anchorFallback, commitSha, findingId,
} from '@dshrb/review-core'
import type { CommentId, Finding, ReviewTarget } from '@dshrb/review-core'
import {
  CAPABILITIES, COMMENT_PREFIX, ForgeUnimplementedError, UNIMPLEMENTED_CAPABILITIES,
  createLocalDeps, createLocalGateway, parseGitDiff, parseHunks,
} from '../src/index.ts'
import type { Config, FileReader, GitRunner, LineWriter } from '../src/index.ts'

/**
 * Every unit test drives the provider through stubbed `git` / `readFile` /
 * `write` deps, so nothing here depends on the developer's real repository. The
 * one integration test builds its own throwaway git repo fixture.
 */

function config(overrides: Partial<Config> = {}): Config {
  return { root: '/repo', workingTree: false, ...overrides }
}

interface StubDeps {
  git: GitRunner
  readFile: FileReader
  write: LineWriter
  gitOutput: string
  readonly lines: string[]
  readonly gitCalls: string[][]
  readonly reads: string[]
}

function stubDeps(): StubDeps {
  const lines: string[] = []
  const gitCalls: string[][] = []
  const reads: string[] = []
  let gitOutput = ''
  return {
    git: async (args) => {
      gitCalls.push([...args])
      return gitOutput
    },
    readFile: async (relPath) => {
      reads.push(relPath)
      return `content of ${relPath}`
    },
    write: (line) => {
      lines.push(line)
    },
    get gitOutput() {
      return gitOutput
    },
    set gitOutput(value: string) {
      gitOutput = value
    },
    lines,
    gitCalls,
    reads,
  }
}

function target(overrides: Partial<ReviewTarget> = {}): ReviewTarget {
  return {
    repo: 'local',
    changeRequestId: '1' as ReviewTarget['changeRequestId'],
    baseSha: commitSha('a'.repeat(40)),
    headSha: commitSha('b'.repeat(40)),
    isFork: false,
    ...overrides,
  }
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    findingId: findingId('f-1'),
    severity: 'blocker',
    title: 'Unchecked index',
    body: 'This dereferences past the end of the array.',
    anchor: anchorAt('src/app.ts', 12),
    ...overrides,
  }
}

describe('capability advertisement', () => {
  it('advertises the five local capabilities and keeps unsupported ones out', () => {
    expect([...CAPABILITIES].sort()).toEqual([
      'actor-resolver', 'comment-sink', 'diff-source',
      'inline-comments', 'mutation-sink',
    ])
    // CheckReader has no CI in a dry-run and sticky-comment has no persistent
    // store, so neither is advertised — a caller asking for them fails at
    // ForgeRegistry.require rather than mid-pipeline.
    expect(CAPABILITIES).not.toContain('check-reader')
    expect(CAPABILITIES).not.toContain('sticky-comment')
    expect(UNIMPLEMENTED_CAPABILITIES).toEqual(['mutation-sink'])
  })

  it('registers under the local forge id with the advertised capabilities', () => {
    const gateway = createLocalGateway(config(), stubDeps())
    expect(gateway.id).toBe('local')
    expect(gateway.capabilities).toEqual(CAPABILITIES)
  })

  it('needs no token: its config is the working-tree root and diff mode', () => {
    // The whole point of forge-local is that `review --local` runs with no
    // credential and no network. There is deliberately no token field here.
    expect(Object.keys(config())).toEqual(['root', 'workingTree'])
  })

  it('refuses M3 mutations explicitly instead of reporting a success it did not perform', async () => {
    const gateway = createLocalGateway(config(), stubDeps())
    await expect(gateway.commitPatches('local', 'main', [], 'msg'))
      .rejects.toThrow(ForgeUnimplementedError)
    await expect(gateway.openPullRequest({
      repo: 'local', headBranch: 'fix', baseBranch: 'main', title: 't', body: 'b',
    })).rejects.toThrow(/E_FORGE_M3_UNIMPLEMENTED|not implemented/)
  })
})

describe('parseHunks', () => {
  it('defaults an omitted line count to one line, not zero', () => {
    const [hunk] = parseHunks('@@ -3 +4 @@\n-a\n+b')
    expect(hunk).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 4, newLines: 1 })
  })

  it('splits multiple hunks and keeps each hunk text with its header', () => {
    const hunks = parseHunks('@@ -1,2 +1,2 @@\n a\n+b\n@@ -10,1 +11,2 @@\n c\n+d')
    expect(hunks).toHaveLength(2)
    expect(hunks[0]?.text.startsWith('@@ -1,2 +1,2 @@')).toBe(true)
    expect(hunks[1]?.text.startsWith('@@ -10,1 +11,2 @@')).toBe(true)
  })

  it('returns nothing for a patch with no hunk header', () => {
    expect(parseHunks('')).toEqual([])
    expect(parseHunks('no header here')).toEqual([])
  })
})

describe('parseGitDiff', () => {
  it('parses a normal file with hunks and flags it non-binary', () => {
    const diff = parseGitDiff([
      'diff --git a/src/app.ts b/src/app.ts',
      'index 111..222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,3 @@',
      ' ctx',
      '-old',
      '+new',
    ].join('\n'))

    expect(diff.files).toHaveLength(1)
    expect(diff.files[0]).toMatchObject({ path: 'src/app.ts', binary: false })
    expect(diff.files[0]?.hunks[0]).toMatchObject({
      oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
    })
    expect(diff.files[0]?.hunks[0]?.text.startsWith('@@ -1,2 +1,3 @@')).toBe(true)
  })

  it('parses multiple files in order', () => {
    const diff = parseGitDiff([
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n'))
    expect(diff.files.map((file) => file.path)).toEqual(['b.ts', 'a.ts'])
  })

  it('flags a binary blob and carries no hunks', () => {
    const diff = parseGitDiff([
      'diff --git a/logo.png b/logo.png',
      'index abc..def 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n'))
    expect(diff.files[0]).toMatchObject({ path: 'logo.png', binary: true })
    expect(diff.files[0]?.hunks).toEqual([])
  })

  it('keeps a binary file whose quoted path contains a space', () => {
    const diff = parseGitDiff([
      'diff --git "a/logo bar.png" "b/logo bar.png"',
      'index abc..def 100644',
      'Binary files "a/logo bar.png" and "b/logo bar.png" differ',
    ].join('\n'))
    expect(diff.files[0]).toMatchObject({ path: 'logo bar.png', binary: true })
    expect(diff.files[0]?.hunks).toEqual([])
  })

  it('decodes octal-quoted non-ASCII binary paths instead of dropping them', () => {
    const header = String.raw`diff --git "a/\344\270\255\346\226\207.bin" "b/\344\270\255\346\226\207.bin"`
    const diff = parseGitDiff([
      header,
      'index abc..def 100644',
      String.raw`Binary files "a/\344\270\255\346\226\207.bin" and "b/\344\270\255\346\226\207.bin" differ`,
    ].join('\n'))
    expect(diff.files[0]).toMatchObject({ path: '中文.bin', binary: true })
    expect(diff.files[0]?.hunks).toEqual([])
  })

  it('maps a pure rename onto path + previousPath', () => {
    const diff = parseGitDiff([
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/new.ts',
    ].join('\n'))
    expect(diff.files[0]).toMatchObject({
      path: 'src/new.ts', previousPath: 'src/old.ts', binary: false,
    })
  })

  it('parses a new file and a deleted file', () => {
    const diff = parseGitDiff([
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..abc',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/del.txt b/del.txt',
      'deleted file mode 100644',
      'index abc..0000000',
      '--- a/del.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-hello',
    ].join('\n'))

    expect(diff.files[0]).toMatchObject({ path: 'new.txt' })
    expect(diff.files[0]?.hunks[0]).toMatchObject({
      oldStart: 0, oldLines: 0, newStart: 1, newLines: 1,
    })
    expect(diff.files[1]).toMatchObject({ path: 'del.txt' })
    expect(diff.files[1]?.hunks[0]).toMatchObject({
      oldStart: 1, oldLines: 1, newStart: 0, newLines: 0,
    })
  })

  it('unquotes git paths that contain spaces', () => {
    const diff = parseGitDiff([
      'diff --git "a/foo bar.txt" "b/foo bar.txt"',
      'index 111..222 100644',
      '--- "a/foo bar.txt"',
      '+++ "b/foo bar.txt"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n'))
    expect(diff.files[0]?.path).toBe('foo bar.txt')
  })

  it('drops a path that escapes the repo instead of anchoring onto it', () => {
    const diff = parseGitDiff([
      'diff --git a/ok.ts b/ok.ts',
      '--- a/ok.ts',
      '+++ b/ok.ts',
      '@@ -1 +1 @@',
      '+x',
      'diff --git a/../evil.ts b/../evil.ts',
      '--- a/../evil.ts',
      '+++ b/../evil.ts',
      '@@ -1 +1 @@',
      '+x',
    ].join('\n'))
    expect(diff.files.map((file) => file.path)).toEqual(['ok.ts'])
  })

  it('returns no files for empty output', () => {
    expect(parseGitDiff('')).toEqual({ files: [] })
  })
})

describe('fetchDiff', () => {
  it('diffs the two SHAs and parses the output', async () => {
    const deps = stubDeps()
    deps.gitOutput = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n')
    const gateway = createLocalGateway(config(), deps)

    const t = target()
    const diff = await gateway.fetchDiff(t)

    expect(diff.files.map((file) => file.path)).toEqual(['a.ts'])
    const [args] = deps.gitCalls
    expect(args).toEqual([
      'diff', '--no-color', '--no-ext-diff', '--find-renames', '--unified=3',
      t.baseSha, t.headSha,
    ])
  })

  it('diffs the working tree against the base when workingTree is set', async () => {
    const deps = stubDeps()
    deps.gitOutput = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n')
    const gateway = createLocalGateway(config({ workingTree: true }), deps)

    const t = target()
    const diff = await gateway.fetchDiff(t)

    expect(diff.files.map((file) => file.path)).toEqual(['a.ts'])
    // A single-argument `git diff` diffs the working tree against base, so the
    // head SHA is dropped — uncommitted changes have no commit to name.
    expect(deps.gitCalls[0]).toEqual([
      'diff', '--no-color', '--no-ext-diff', '--find-renames', '--unified=3', t.baseSha,
    ])
  })

  it('rejects a malformed SHA before invoking git', async () => {
    const deps = stubDeps()
    const gateway = createLocalGateway(config(), deps)
    await expect(gateway.fetchDiff({
      ...target(),
      baseSha: 'not-a-sha' as ReviewTarget['baseSha'],
    })).rejects.toThrow(TypeError)
    expect(deps.gitCalls).toHaveLength(0)
  })
})

describe('fetchFile', () => {
  it('reads the working tree file at a repo-relative path', async () => {
    const deps = stubDeps()
    const gateway = createLocalGateway(config(), deps)

    const content = await gateway.fetchFile('local', 'src/app.ts', target().baseSha)

    expect(content).toBe('content of src/app.ts')
    expect(deps.reads).toEqual(['src/app.ts'])
  })

  it('rejects a traversal path before touching the filesystem', async () => {
    const deps = stubDeps()
    const gateway = createLocalGateway(config(), deps)
    await expect(gateway.fetchFile('local', '../../../etc/passwd', target().baseSha))
      .rejects.toThrow(TypeError)
    expect(deps.reads).toHaveLength(0)
  })
})

describe('comment sink', () => {
  it('prints a summary comment and returns a synthetic id', async () => {
    const deps = stubDeps()
    const gateway = createLocalGateway(config(), deps)

    const id = await gateway.createComment(target(), 'hello')

    expect(id).toBe('local-1')
    expect(deps.lines).toHaveLength(1)
    expect(deps.lines[0]).toContain('hello')
    expect(deps.lines[0]?.startsWith(`${COMMENT_PREFIX} comment (local)`)).toBe(true)
  })

  it('increments the synthetic comment id across calls', async () => {
    const deps = stubDeps()
    const gateway = createLocalGateway(config(), deps)
    expect(await gateway.createComment(target(), 'a')).toBe('local-1')
    expect(await gateway.createComment(target(), 'b')).toBe('local-2')
  })

  it('prints anchored findings inline and degrades the unanchored ones', async () => {
    const deps = stubDeps()
    const gateway = createLocalGateway(config(), deps)

    const unanchored = anchorFallback('src/app.ts', 99, 'outside every hunk')
    const stats = await gateway.createInlineComments(target(), [
      finding(),
      finding({ findingId: findingId('f-2'), anchor: unanchored }),
    ], 'local')

    expect(stats).toEqual({ published: 1, degradedToSummary: 1, failed: 0 })
    expect(deps.lines).toHaveLength(1)
    expect(deps.lines[0]).toBe(
      `${COMMENT_PREFIX} inline src/app.ts:12 blocker: Unchecked index`,
    )
  })

  it('never reuses a sticky comment, since a dry-run has no persistent store', async () => {
    const gateway = createLocalGateway(config(), stubDeps())
    expect(await gateway.findStickyComment(target(), 'summary', 'local')).toBeUndefined()
  })

  it('prints an update to the terminal', async () => {
    const deps = stubDeps()
    const gateway = createLocalGateway(config(), deps)
    await gateway.updateComment('local', 'local-1' as CommentId, 'revised')
    expect(deps.lines[0]).toContain('revised')
    expect(deps.lines[0]?.startsWith(`${COMMENT_PREFIX} update-comment local-1`)).toBe(true)
  })
})

describe('actor resolver', () => {
  it('treats the local actor as the owner of the tree', async () => {
    const gateway = createLocalGateway(config(), stubDeps())
    expect(await gateway.resolvePermission('local', 'whoever')).toBe('admin')
    expect(await gateway.isFork(target())).toBe(false)
    expect(await gateway.botIdentity()).toEqual({ id: 'local', login: 'local' })
  })
})

describe('real git fixture', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  }

  it('diffs two commits in a freshly built repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dshrb-forge-local-'))
    tempDirs.push(root)

    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'user.name', 'Test')
    writeFileSync(join(root, 'a.txt'), 'line1\nline2\n')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-q', '-m', 'first')
    const baseSha = commitSha(git(root, 'rev-parse', 'HEAD'))

    writeFileSync(join(root, 'a.txt'), 'line1\nline2 changed\n')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-q', '-m', 'second')
    const headSha = commitSha(git(root, 'rev-parse', 'HEAD'))

    const gateway = createLocalGateway({ root, workingTree: false }, createLocalDeps(root))
    const diff = await gateway.fetchDiff({
      repo: 'local',
      changeRequestId: '1' as ReviewTarget['changeRequestId'],
      baseSha,
      headSha,
      isFork: false,
    })

    expect(diff.files.map((file) => file.path)).toEqual(['a.txt'])
    expect(diff.files[0]?.hunks).toHaveLength(1)
    expect(diff.files[0]?.hunks[0]).toMatchObject({ newStart: 1, newLines: 2 })
  })

  it('keeps a binary file with a non-ASCII name when diffing real commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dshrb-forge-local-'))
    tempDirs.push(root)

    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'user.name', 'Test')
    const name = '标志.bin'
    writeFileSync(join(root, name), Buffer.from([0x00, 0x01, 0x02]))
    git(root, 'add', '--', name)
    git(root, 'commit', '-q', '-m', 'first')
    const baseSha = commitSha(git(root, 'rev-parse', 'HEAD'))

    writeFileSync(join(root, name), Buffer.from([0x00, 0x01, 0x03]))
    git(root, 'add', '--', name)
    git(root, 'commit', '-q', '-m', 'second')
    const headSha = commitSha(git(root, 'rev-parse', 'HEAD'))

    const gateway = createLocalGateway({ root, workingTree: false }, createLocalDeps(root))
    const diff = await gateway.fetchDiff({
      repo: 'local',
      changeRequestId: '1' as ReviewTarget['changeRequestId'],
      baseSha,
      headSha,
      isFork: false,
    })

    expect(diff.files.map((file) => file.path)).toEqual([name])
    expect(diff.files[0]?.binary).toBe(true)
  })
})
