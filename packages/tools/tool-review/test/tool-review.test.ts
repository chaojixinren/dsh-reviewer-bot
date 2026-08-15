import { describe, expect, it, vi } from 'vitest'
import { ruleId } from '@dshrb/review-core'
import type { Rule } from '@dshrb/rule-registry'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  M1_TOOL_NAMES,
  TOOL_NAMES,
  createProposePatchTool,
  createReviewToolRuntime,
  createReviewTools,
} from '../src/index.ts'
import type { DiffShard, ReviewToolContext, ReviewToolDeps } from '../src/index.ts'

/**
 * A tool body only ever reads `exec.signal` (and forwards it to the read
 * callbacks), so the other execution fields are irrelevant here and cast away.
 */
function fakeExec(signal: AbortSignal): ToolRunContext {
  return {
    name: 'test-tool',
    arguments: {},
    signal,
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

function makeShard(over: Partial<DiffShard> = {}): DiffShard {
  return {
    index: 0,
    files: ['src/a.ts'],
    text: 'diff text',
    truncated: false,
    ...over,
  }
}

function makeRule(over: Partial<Rule> = {}): Rule {
  return {
    id: ruleId('rule-x'),
    severity: 'major',
    applies: ['src/**'],
    guidance: 'do the thing',
    requiresScenario: false,
    ...over,
  }
}

function makeContext(over: Partial<ReviewToolContext> = {}): ReviewToolContext {
  return {
    shards: [makeShard(), makeShard({ index: 1, files: ['src/b.ts'], text: 'second shard', truncated: true })],
    readRepoFile: vi.fn(async () => 'file content'),
    readCheckLog: vi.fn(async () => 'check log'),
    ...over,
  }
}

function makeDeps(context: ReviewToolContext | undefined, rules = vi.fn((_path: string): readonly Rule[] => [])): ReviewToolDeps {
  return { rules: { match: rules }, context: () => context }
}

function findTool(deps: ReviewToolDeps, name: string) {
  const tool = createReviewTools(deps).find((candidate) => candidate.name === name)
  expect(tool, name).toBeDefined()
  return tool!
}

describe('createReviewTools', () => {
  it('registers exactly the five M1 tools and keeps propose_patch separate', () => {
    const tools = createReviewTools(makeDeps(makeContext()))
    const names = tools.map((tool) => tool.name).sort()
    expect(names).toEqual([...M1_TOOL_NAMES].sort())
    expect(names).not.toContain('propose_patch')
    // propose_patch is built separately and registered only when enabled.
    expect(TOOL_NAMES).toContain('propose_patch')
    expect(createProposePatchTool().name).toBe('propose_patch')
  })
})

describe('propose_patch', () => {
  it('returns a receipt and performs no write', async () => {
    const tool = createProposePatchTool()
    const value = await tool.execute(
      { path: 'src/a.ts', diff: '@@ -1 +1 @@\n-x\n+y\n' },
      fakeExec(new AbortController().signal),
    )
    expect(value).toEqual({ received: true, path: 'src/a.ts' })
  })

  it('rejects an unsafe path before anything is recorded', async () => {
    const tool = createProposePatchTool()
    await expect(tool.execute(
      { path: '../outside.ts', diff: '@@ -1 +1 @@\n-x\n+y\n' },
      fakeExec(new AbortController().signal),
    )).rejects.toThrow(/safe repo-relative/)
  })

  it('honors exec.signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = createProposePatchTool()
    await expect(tool.execute(
      { path: 'src/a.ts', diff: '@@ -1 +1 @@\n-x\n+y\n' },
      fakeExec(controller.signal),
    )).rejects.toThrow()
  })
})

describe('read_diff_shard', () => {
  it('returns the shard at the requested index', async () => {
    const context = makeContext()
    const tool = findTool(makeDeps(context), 'read_diff_shard')
    const value = await tool.execute({ index: 1 }, fakeExec(new AbortController().signal))
    expect(value).toEqual({
      index: 1,
      files: ['src/b.ts'],
      text: 'second shard',
      truncated: true,
    })
  })

  it('fails closed before the controller binds a context', async () => {
    const tool = findTool(makeDeps(undefined), 'read_diff_shard')
    await expect(tool.execute({ index: 0 }, fakeExec(new AbortController().signal))).rejects.toThrow(/no review context/)
  })

  it('rejects an out-of-range index', async () => {
    const tool = findTool(makeDeps(makeContext()), 'read_diff_shard')
    await expect(tool.execute({ index: 7 }, fakeExec(new AbortController().signal))).rejects.toThrow(/no diff shard at index 7/)
  })

  it('reports no shards instead of an inverted range when the diff is empty', async () => {
    const tool = findTool(makeDeps(makeContext({ shards: [] })), 'read_diff_shard')
    await expect(tool.execute({ index: 0 }, fakeExec(new AbortController().signal))).rejects.toThrow(/the diff has no shards/)
  })

  it('honors exec.signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = findTool(makeDeps(makeContext()), 'read_diff_shard')
    await expect(tool.execute({ index: 0 }, fakeExec(controller.signal))).rejects.toThrow()
  })
})

describe('list_applicable_rules', () => {
  it('returns the rules the matcher reports for the path', async () => {
    const rules = vi.fn((): readonly Rule[] => [makeRule({ id: ruleId('r1'), severity: 'minor', guidance: 'g', requiresScenario: true })])
    const tool = findTool(makeDeps(makeContext(), rules), 'list_applicable_rules')
    const value = await tool.execute({ path: 'src/a.ts' }, fakeExec(new AbortController().signal))
    expect(rules).toHaveBeenCalledWith('src/a.ts')
    expect(value).toEqual({
      path: 'src/a.ts',
      rules: [{ id: 'r1', severity: 'minor', guidance: 'g', requiresScenario: true }],
    })
  })

  it('rejects an unsafe path', async () => {
    const tool = findTool(makeDeps(makeContext()), 'list_applicable_rules')
    await expect(tool.execute({ path: '../outside.ts' }, fakeExec(new AbortController().signal))).rejects.toThrow(/safe repo-relative/)
  })
})

describe('report_finding', () => {
  it('returns a canonical receipt and echoes the proposal identity', async () => {
    const tool = findTool(makeDeps(makeContext()), 'report_finding')
    const value = await tool.execute(
      { severity: 'major', title: 'T', body: 'B', path: 'src/a.ts', line: 12 },
      fakeExec(new AbortController().signal),
    )
    expect(value).toEqual({ received: true, severity: 'major', title: 'T', path: 'src/a.ts', line: 12 })
  })

  it('performs no forge I/O: neither read callback is invoked', async () => {
    const context = makeContext()
    const tool = findTool(makeDeps(context), 'report_finding')
    await tool.execute(
      { severity: 'major', title: 'T', body: 'B', path: 'src/a.ts', line: 12 },
      fakeExec(new AbortController().signal),
    )
    expect(context.readRepoFile).not.toHaveBeenCalled()
    expect(context.readCheckLog).not.toHaveBeenCalled()
  })

  it('honors exec.signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = findTool(makeDeps(makeContext()), 'report_finding')
    await expect(tool.execute(
      { severity: 'major', title: 'T', body: 'B', path: 'src/a.ts', line: 12 },
      fakeExec(controller.signal),
    )).rejects.toThrow()
  })
})

describe('read_repo_file', () => {
  it('reads through the bound callback and forwards the signal', async () => {
    const context = makeContext()
    const signal = new AbortController().signal
    const tool = findTool(makeDeps(context), 'read_repo_file')
    const value = await tool.execute({ path: 'src/a.ts' }, fakeExec(signal))
    expect(context.readRepoFile).toHaveBeenCalledWith('src/a.ts', signal)
    expect(value).toEqual({ path: 'src/a.ts', content: 'file content' })
  })

  it('rejects an unsafe path', async () => {
    const tool = findTool(makeDeps(makeContext()), 'read_repo_file')
    await expect(tool.execute({ path: '/etc/passwd' }, fakeExec(new AbortController().signal))).rejects.toThrow(/safe repo-relative/)
  })

  it('fails closed without a bound context', async () => {
    const tool = findTool(makeDeps(undefined), 'read_repo_file')
    await expect(tool.execute({ path: 'src/a.ts' }, fakeExec(new AbortController().signal))).rejects.toThrow(/no review context/)
  })
})

describe('read_check_log', () => {
  it('reads through the bound callback and forwards the signal', async () => {
    const context = makeContext()
    const signal = new AbortController().signal
    const tool = findTool(makeDeps(context), 'read_check_log')
    const value = await tool.execute({ checkId: '42' }, fakeExec(signal))
    expect(context.readCheckLog).toHaveBeenCalledWith('42', signal)
    expect(value).toEqual({ checkId: '42', log: 'check log' })
  })

  it('rejects an empty check id', async () => {
    const tool = findTool(makeDeps(makeContext()), 'read_check_log')
    await expect(tool.execute({ checkId: '  ' }, fakeExec(new AbortController().signal))).rejects.toThrow(/non-empty/)
  })
})

describe('createReviewToolRuntime', () => {
  it('fails closed before activation and restores the previous context on dispose', () => {
    const runtime = createReviewToolRuntime()
    expect(runtime.context).toBeUndefined()

    const first = makeContext()
    const disposeFirst = runtime.activate(first)
    expect(runtime.context).toBe(first)

    const second = makeContext({ shards: [] })
    const disposeSecond = runtime.activate(second)
    expect(runtime.context).toBe(second)

    disposeSecond()
    expect(runtime.context).toBe(first)

    disposeFirst()
    expect(runtime.context).toBeUndefined()
  })
})
