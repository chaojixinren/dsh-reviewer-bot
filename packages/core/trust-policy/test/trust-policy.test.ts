import { describe, expect, it } from 'vitest'
import type { Capabilities, ReviewIntent, TrustLevel } from '@dshrb/review-core'
import type { ForgePermission } from '@dshrb/forge'
import { TOOL_NAMES } from '@dshrb/tool-review'
import {
  GOVERNED_TOOLS,
  INTENT_MIN_TRUST,
  TOOL_REQUIREMENTS,
  capabilitiesFor,
  createTrustPolicy,
  decideToolCall,
  explainDenial,
  explainDenialReason,
  meetsTrust,
  resolveTrust,
  toolRestrictionFor,
  visibleTools,
  writeRedLineViolation,
} from '../src/index.ts'
import type { ActorContext, Config, TrustInput, WriteRedLine } from '../src/index.ts'

/**
 * Trust resolution is a security boundary, so these tests assert what is
 * WITHHELD as much as what is granted: a matrix that only covers the happy path
 * would pass against an implementation that returns `trusted-write` always.
 */

function input(over: Partial<TrustInput> = {}): TrustInput {
  return { isFork: false, permission: 'write', intent: 'review', allowWrite: false, ...over }
}

const ALL_PERMISSIONS: readonly ForgePermission[] = [
  'none', 'read', 'triage', 'write', 'maintain', 'admin',
]
const ALL_INTENTS: readonly ReviewIntent[] = [
  'review', 'explain', 'diagnose', 'fix', 'rules', 'none',
]

describe('resolveTrust', () => {
  const cases: readonly { name: string; input: Partial<TrustInput>; expected: TrustLevel }[] = [
    // A fork caps at untrusted regardless of how privileged the actor is (T1).
    { name: 'fork PR from a reader', input: { isFork: true, permission: 'read' }, expected: 'untrusted' },
    { name: 'fork PR from an admin', input: { isFork: true, permission: 'admin' }, expected: 'untrusted' },
    {
      name: 'fork PR asking to fix, with allowWrite on',
      input: { isFork: true, permission: 'admin', intent: 'fix', allowWrite: true },
      expected: 'untrusted',
    },
    // Non-fork, insufficient permission -> none.
    { name: 'no permission', input: { permission: 'none' }, expected: 'none' },
    { name: 'read permission', input: { permission: 'read' }, expected: 'none' },
    { name: 'triage permission', input: { permission: 'triage' }, expected: 'none' },
    // Non-fork collaborator on a read intent -> trusted-read.
    { name: 'write permission reviewing', input: { permission: 'write' }, expected: 'trusted-read' },
    { name: 'maintain permission diagnosing', input: { permission: 'maintain', intent: 'diagnose' }, expected: 'trusted-read' },
    { name: 'admin explaining', input: { permission: 'admin', intent: 'explain' }, expected: 'trusted-read' },
    { name: 'admin listing rules', input: { permission: 'admin', intent: 'rules' }, expected: 'trusted-read' },
    // Write intent needs permission AND configuration, both (T7).
    { name: 'fix without allowWrite', input: { permission: 'admin', intent: 'fix' }, expected: 'none' },
    { name: 'fix with allowWrite', input: { permission: 'write', intent: 'fix', allowWrite: true }, expected: 'trusted-write' },
    { name: 'fix with allowWrite but only read permission', input: { permission: 'read', intent: 'fix', allowWrite: true }, expected: 'none' },
    // An unrouted event authorizes nothing.
    { name: 'intent none, admin', input: { permission: 'admin', intent: 'none' }, expected: 'none' },
    { name: 'intent none, allowWrite on', input: { permission: 'admin', intent: 'none', allowWrite: true }, expected: 'none' },
  ]

  for (const { name, input: over, expected } of cases) {
    it(`resolves ${name} to '${expected}'`, () => {
      expect(resolveTrust(input(over))).toBe(expected)
    })
  }

  it('never exceeds untrusted for any fork input across the whole matrix', () => {
    for (const permission of ALL_PERMISSIONS) {
      for (const intent of ALL_INTENTS) {
        for (const allowWrite of [false, true]) {
          const trust = resolveTrust(input({ isFork: true, permission, intent, allowWrite }))
          expect(meetsTrust(trust, 'trusted-read'), `${permission}/${intent}/${allowWrite}`).toBe(false)
        }
      }
    }
  })

  it('never reaches trusted-write while allowWrite is off', () => {
    for (const permission of ALL_PERMISSIONS) {
      for (const intent of ALL_INTENTS) {
        for (const isFork of [false, true]) {
          const trust = resolveTrust(input({ isFork, permission, intent, allowWrite: false }))
          expect(trust, `${permission}/${intent}/${isFork}`).not.toBe('trusted-write')
        }
      }
    }
  })

  it('never reaches trusted-write without a write-capable permission', () => {
    for (const permission of ['none', 'read', 'triage'] as const) {
      for (const intent of ALL_INTENTS) {
        const trust = resolveTrust(input({ permission, intent, allowWrite: true }))
        expect(trust, `${permission}/${intent}`).not.toBe('trusted-write')
      }
    }
  })
})

describe('capabilitiesFor', () => {
  it('grants nothing at none', () => {
    const caps = capabilitiesFor('none')
    for (const [key, value] of Object.entries(caps)) {
      expect(value, key).toBe(false)
    }
  })

  it('withholds repo files and check logs from untrusted', () => {
    const caps = capabilitiesFor('untrusted')
    expect(caps.readDiff).toBe(true)
    expect(caps.publishComments).toBe(true)
    // Acceptance gate 2: a fork PR has no repository-reading tool at all.
    expect(caps.readRepoFiles).toBe(false)
    expect(caps.readCheckLogs).toBe(false)
    expect(caps.proposePatches).toBe(false)
    expect(caps.commitPatches).toBe(false)
  })

  it('grants reads but withholds every mutation at trusted-read', () => {
    const caps = capabilitiesFor('trusted-read')
    expect(caps.readRepoFiles).toBe(true)
    expect(caps.readCheckLogs).toBe(true)
    expect(caps.proposePatches).toBe(false)
    expect(caps.commitPatches).toBe(false)
  })

  it('grants every capability only at trusted-write', () => {
    const caps = capabilitiesFor('trusted-write')
    for (const [key, value] of Object.entries(caps)) {
      expect(value, key).toBe(true)
    }
  })

  it('is monotonic: no capability is lost as trust rises', () => {
    const ladder: readonly TrustLevel[] = ['none', 'untrusted', 'trusted-read', 'trusted-write']
    const keys = Object.keys(capabilitiesFor('trusted-write')) as (keyof Capabilities)[]
    for (let i = 1; i < ladder.length; i += 1) {
      const lower = capabilitiesFor(ladder[i - 1] as TrustLevel)
      const higher = capabilitiesFor(ladder[i] as TrustLevel)
      for (const key of keys) {
        if (lower[key]) expect(higher[key], `${key} lost at ${ladder[i]}`).toBe(true)
      }
    }
  })

  it('returns a frozen record at none so a caller cannot widen it', () => {
    expect(Object.isFrozen(capabilitiesFor('none'))).toBe(true)
  })
})

describe('explainDenial', () => {
  it('names isFork when a fork asks for a write intent', () => {
    const reason = explainDenial(input({ isFork: true, permission: 'admin', intent: 'fix', allowWrite: true }))
    expect(reason).toMatch(/isFork/)
    expect(reason).toMatch(/fork/)
  })

  it('names isFork when a fork asks to diagnose', () => {
    expect(explainDenial(input({ isFork: true, permission: 'admin', intent: 'diagnose' })))
      .toMatch(/isFork/)
  })

  it('names permission and the actual level when the actor lacks write', () => {
    const reason = explainDenial(input({ permission: 'triage', intent: 'review' }))
    expect(reason).toMatch(/permission/)
    expect(reason).toMatch(/triage/)
  })

  it('names allowWrite when permission holds but the repository has not opted in', () => {
    const reason = explainDenial(input({ permission: 'maintain', intent: 'fix', allowWrite: false }))
    expect(reason).toMatch(/allowWrite/)
    expect(reason).not.toMatch(/permission:/)
  })

  it('names intent when nothing was routed', () => {
    expect(explainDenial(input({ intent: 'none', permission: 'admin' }))).toMatch(/intent/)
  })

  it('is not a generic refusal: each blocker produces a distinct message', () => {
    const messages = new Set([
      explainDenial(input({ isFork: true, intent: 'fix', permission: 'admin', allowWrite: true })),
      explainDenial(input({ permission: 'read' })),
      explainDenial(input({ permission: 'admin', intent: 'fix' })),
      explainDenial(input({ permission: 'admin', intent: 'none' })),
    ])
    expect(messages.size).toBe(4)
  })

  it('reports every none outcome in the matrix with a reason', () => {
    for (const permission of ALL_PERMISSIONS) {
      for (const intent of ALL_INTENTS) {
        for (const isFork of [false, true]) {
          for (const allowWrite of [false, true]) {
            const candidate = input({ isFork, permission, intent, allowWrite })
            if (resolveTrust(candidate) !== 'none') continue
            const reason = explainDenialReason(candidate)
            expect(reason, `${isFork}/${permission}/${intent}/${allowWrite}`).toBeTypeOf('string')
            expect(reason).toMatch(/^(isFork|permission|allowWrite|intent):/)
          }
        }
      }
    }
  })

  it('abstains when the resolved trust satisfies the intent', () => {
    expect(explainDenialReason(input({ permission: 'write', intent: 'review' }))).toBeUndefined()
    expect(explainDenialReason(input({ isFork: true, permission: 'read', intent: 'review' }))).toBeUndefined()
    expect(explainDenialReason(input({ permission: 'write', intent: 'fix', allowWrite: true }))).toBeUndefined()
  })
})

describe('visibleTools and toolRestrictionFor', () => {
  it('shows no tool at none', () => {
    expect(visibleTools('none')).toEqual([])
  })

  it('hides read_repo_file and read_check_log from untrusted', () => {
    const tools = visibleTools('untrusted')
    expect(tools).toContain('read_diff_shard')
    expect(tools).toContain('report_finding')
    expect(tools).not.toContain('read_repo_file')
    expect(tools).not.toContain('read_check_log')
    expect(tools).not.toContain('propose_patch')
  })

  it('hides propose_patch from trusted-read', () => {
    expect(visibleTools('trusted-read')).toContain('read_repo_file')
    expect(visibleTools('trusted-read')).not.toContain('propose_patch')
  })

  it('shows every governed tool at trusted-write', () => {
    expect([...visibleTools('trusted-write')].sort()).toEqual([...GOVERNED_TOOLS].sort())
  })

  it('produces an allow filter, so an unclassified tool fails closed', () => {
    const filter = toolRestrictionFor('untrusted')
    expect(filter.allow).toBeDefined()
    expect(filter.deny).toBeUndefined()
    expect(filter.allow).not.toContain('read_repo_file')
  })

  it('classifies every tool in the requirement table', () => {
    for (const tool of GOVERNED_TOOLS) {
      expect(TOOL_REQUIREMENTS[tool], tool).toBeDefined()
    }
  })
})

describe('decideToolCall', () => {
  it('allows a diff read at untrusted', () => {
    expect(decideToolCall(input({ isFork: true, permission: 'read' }), 'read_diff_shard'))
      .toEqual({ kind: 'allow' })
  })

  it('denies a repo-file read at untrusted', () => {
    const decision = decideToolCall(input({ isFork: true, permission: 'admin' }), 'read_repo_file')
    expect(decision?.kind).toBe('deny')
    if (decision?.kind !== 'deny') throw new Error('expected deny')
    expect(decision.reason).toMatch(/read_repo_file/)
  })

  it('denies propose_patch at trusted-read', () => {
    const decision = decideToolCall(input({ permission: 'admin', intent: 'review' }), 'propose_patch')
    expect(decision?.kind).toBe('deny')
  })

  it('allows propose_patch only at trusted-write', () => {
    expect(decideToolCall(input({ permission: 'write', intent: 'fix', allowWrite: true }), 'propose_patch'))
      .toEqual({ kind: 'allow' })
  })

  it('denies a write tool when only the repository opt-in is missing', () => {
    const decision = decideToolCall(input({ permission: 'maintain', intent: 'fix', allowWrite: false }), 'propose_patch')
    expect(decision?.kind).toBe('deny')
    if (decision?.kind !== 'deny') throw new Error('expected deny')
    expect(decision.reason).toMatch(/allowWrite/)
  })

  it('denies a fork write even when only the opt-in is missing', () => {
    const decision = decideToolCall(
      input({ isFork: true, permission: 'admin', intent: 'fix', allowWrite: false }),
      'propose_patch',
    )
    expect(decision?.kind).toBe('deny')
  })

  it('denies a write tool when the actor lacks write permission', () => {
    // `@dsr fix` needs actor permission AND allowWrite; a reader with the opt-in
    // on is still refused on the permission condition, not the config one.
    const decision = decideToolCall(
      input({ permission: 'read', intent: 'fix', allowWrite: true }),
      'propose_patch',
    )
    expect(decision?.kind).toBe('deny')
    if (decision?.kind !== 'deny') throw new Error('expected deny')
    expect(decision.reason).toMatch(/permission/)
  })

  it('abstains on a tool it does not govern, so other plugins keep their say', () => {
    expect(decideToolCall(input({ permission: 'admin' }), 'some_other_plugin_tool')).toBeUndefined()
  })

  it('denies every governed tool at none', () => {
    for (const tool of GOVERNED_TOOLS) {
      const decision = decideToolCall(input({ permission: 'none' }), tool)
      expect(decision?.kind, tool).toBe('deny')
    }
  })

  it('agrees with visibleTools on every level, so presentation matches execution', () => {
    const levels: readonly TrustLevel[] = ['none', 'untrusted', 'trusted-read', 'trusted-write']
    const inputFor: Readonly<Record<TrustLevel, TrustInput>> = {
      'none': input({ permission: 'none' }),
      'untrusted': input({ isFork: true, permission: 'admin' }),
      'trusted-read': input({ permission: 'admin', intent: 'review' }),
      'trusted-write': input({ permission: 'admin', intent: 'fix', allowWrite: true }),
    }
    for (const level of levels) {
      const candidate = inputFor[level]
      expect(resolveTrust(candidate), `fixture for ${level}`).toBe(level)
      const allowed = GOVERNED_TOOLS.filter((tool) => decideToolCall(candidate, tool)?.kind === 'allow')
      expect(allowed, level).toEqual([...visibleTools(level)])
    }
  })
})

describe('INTENT_MIN_TRUST', () => {
  it('matches the routing table in docs/03-review-pipeline.md', () => {
    expect(INTENT_MIN_TRUST.review).toBe('untrusted')
    expect(INTENT_MIN_TRUST.explain).toBe('untrusted')
    expect(INTENT_MIN_TRUST.rules).toBe('untrusted')
    expect(INTENT_MIN_TRUST.diagnose).toBe('trusted-read')
    expect(INTENT_MIN_TRUST.fix).toBe('trusted-write')
    expect(INTENT_MIN_TRUST.none).toBe('none')
  })
})

describe('createTrustPolicy', () => {
  function config(over: Partial<Config> = {}): Config {
    return { allowWrite: false, protectedPaths: [], ...over }
  }
  const collaboratorFix: ActorContext = { isFork: false, permission: 'admin', intent: 'fix' }

  it('fails closed before a run is authorized', () => {
    const policy = createTrustPolicy(config())
    expect(policy.level).toBe('none')
    expect(policy.input).toBeUndefined()
    const decision = policy.decide('read_diff_shard')
    expect(decision?.kind).toBe('deny')
    if (decision?.kind !== 'deny') throw new Error('expected deny')
    expect(decision.reason).toMatch(/no trust decision is active/)
  })

  it('still abstains on foreign tools before authorization', () => {
    expect(createTrustPolicy(config()).decide('some_other_plugin_tool')).toBeUndefined()
  })

  it('composes allowWrite from config, not from the activating caller', () => {
    const policy = createTrustPolicy(config({ allowWrite: true }))
    policy.activate(collaboratorFix)
    expect(policy.level).toBe('trusted-write')
    expect(policy.input?.allowWrite).toBe(true)
  })

  it('cannot be raised to write mode by an actor context alone', () => {
    const policy = createTrustPolicy(config({ allowWrite: false }))
    policy.activate(collaboratorFix)
    // A repository-supplied `.dshrb.yml` reaches this layer as an ActorContext at
    // most; there is no parameter through which it can set allowWrite.
    expect(policy.level).toBe('none')
    expect(policy.input?.allowWrite).toBe(false)
    expect(policy.decide('propose_patch')?.kind).toBe('deny')
  })

  it('gives a fork no write path even under allowWrite', () => {
    const policy = createTrustPolicy(config({ allowWrite: true }))
    policy.activate({ isFork: true, permission: 'admin', intent: 'fix' })
    expect(policy.level).toBe('untrusted')
    expect(policy.capabilities.readRepoFiles).toBe(false)
    expect(policy.decide('propose_patch')?.kind).toBe('deny')
  })

  it('restores the previous decision when the activation is disposed', () => {
    const policy = createTrustPolicy(config({ allowWrite: true }))
    const dispose = policy.activate(collaboratorFix)
    expect(policy.level).toBe('trusted-write')
    dispose()
    expect(policy.level).toBe('none')
    expect(policy.decide('propose_patch')?.kind).toBe('deny')
  })

  it('restricts a scoped context to the active level and returns the disposer', () => {
    const policy = createTrustPolicy(config())
    policy.activate({ isFork: true, permission: 'read', intent: 'review' })

    const calls: { allow?: readonly string[]; deny?: readonly string[] }[] = []
    const lift = (): void => {}
    // Stands in for `agent.ctx`: upstream `restrict()` rejects an unscoped
    // context, so the policy must pass the caller's context straight through.
    const scoped = { tools: { restrict: (filter: { allow?: readonly string[] }) => {
      calls.push(filter)
      return lift
    } } }

    const returned = policy.restrictScope(scoped as never)
    expect(returned).toBe(lift)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.allow).toEqual([...visibleTools('untrusted')])
    expect(calls[0]?.allow).not.toContain('read_repo_file')
  })
})

describe('tool whitelist parity (M2)', () => {
  it('governs every tool-review tool, so none can fall through fail-open', () => {
    // A tool-review tool missing from GOVERNED_TOOLS would be hidden by
    // restrictScope's allow-list but the pre-execute waterfall would abstain
    // (fail open). This pins TOOL_NAMES ⊆ GOVERNED_TOOLS.
    for (const tool of TOOL_NAMES) {
      expect(GOVERNED_TOOLS, `tool ${tool} must be governed`).toContain(tool)
    }
  })

  it('governs nothing that is not a tool-review tool', () => {
    // The reverse direction: a renamed or removed tool-review tool must not
    // leave a stale classification behind in the table.
    for (const tool of GOVERNED_TOOLS) {
      expect(TOOL_NAMES, `governed tool ${tool} must still exist`).toContain(tool)
    }
  })
})

describe('writeRedLineViolation', () => {
  const PROTECTED = ['.github/**', '.gitlab-ci.yml', '.circleci/**', 'Jenkinsfile']

  function redLine(over: Partial<WriteRedLine> = {}): WriteRedLine {
    return {
      path: 'src/index.ts',
      diff: '@@ -1,1 +1,1 @@\n- old\n+ new\n',
      changedPaths: ['src/index.ts'],
      binaryPaths: [],
      ...over,
    }
  }

  // Every red line must have at least one negative (deny) case. The deny reason
  // is a non-empty string; `undefined` would be an abstention, which is a miss.
  const denials: readonly { name: string; write: WriteRedLine }[] = [
    {
      name: 'path traversal with ..',
      write: redLine({ path: '../../etc/passwd' }),
    },
    {
      name: 'absolute path',
      write: redLine({ path: '/etc/passwd' }),
    },
    {
      name: 'windows drive path',
      write: redLine({ path: 'C:\\Windows\\system32\\x' }),
    },
    {
      name: 'NUL byte in path',
      write: redLine({ path: 'src/a\0.ts' }),
    },
    {
      name: 'protected .github/**',
      write: redLine({ path: '.github/workflows/ci.yml' }),
    },
    {
      name: 'protected Jenkinsfile',
      write: redLine({ path: 'Jenkinsfile' }),
    },
    {
      name: 'protected .gitlab-ci.yml',
      write: redLine({ path: '.gitlab-ci.yml' }),
    },
    {
      name: 'binary file',
      write: redLine({ path: 'assets/logo.png', binaryPaths: ['assets/logo.png'] }),
    },
    {
      name: 'package.json scripts field',
      write: redLine({ path: 'package.json', diff: '@@ -1,1 +1,1 @@\n- "scripts": {\n+ "scripts": {\n' }),
    },
    {
      name: 'lockfile without a matching manifest change',
      write: redLine({ path: 'pnpm-lock.yaml', changedPaths: ['src/index.ts'] }),
    },
  ]

  for (const { name, write } of denials) {
    it(`denies ${name}`, () => {
      const denial = writeRedLineViolation(write, PROTECTED)
      expect(denial, name).toBeTypeOf('string')
      if (typeof denial !== 'string') throw new Error(`expected a denial for ${name}`)
      expect(denial.length, name).toBeGreaterThan(0)
    })
  }

  it('allows a normal source-file write', () => {
    expect(writeRedLineViolation(redLine(), PROTECTED)).toBeUndefined()
  })

  it('allows a package.json change that does not touch scripts (field-level)', () => {
    const write = redLine({
      path: 'package.json',
      diff: '@@ -1,1 +1,1 @@\n- "dependencies": {\n+ "dependencies": {\n',
    })
    expect(writeRedLineViolation(write, PROTECTED)).toBeUndefined()
  })

  it('allows a lockfile when the same request also changes its manifest', () => {
    const write = redLine({
      path: 'packages/core/pnpm-lock.yaml',
      changedPaths: ['packages/core/package.json', 'packages/core/pnpm-lock.yaml'],
    })
    expect(writeRedLineViolation(write, PROTECTED)).toBeUndefined()
  })

  it('allows a path not in the binary list', () => {
    expect(writeRedLineViolation(redLine({ path: 'assets/logo.svg' }), PROTECTED)).toBeUndefined()
  })

  it('uses config.protectedPaths, not a hardcoded list', () => {
    // A maintainer-supplied protected path must take effect; a path that only
    // matches a pattern NOT configured is allowed.
    expect(writeRedLineViolation(redLine({ path: 'SECRETS.md' }), ['SECRETS.md'])).toBeTypeOf('string')
    expect(writeRedLineViolation(redLine({ path: 'SECRETS.md' }), PROTECTED)).toBeUndefined()
  })

  it('denial is terminal: a later listener cannot re-grant a matched red line', () => {
    // The guard contract is `string | undefined` — a non-empty string denies,
    // `undefined` abstains. There is no `allow` arm, so once a red line matches
    // the only outcomes are a reason (denied) or an abstention for a different
    // write; nothing can flip a denial back to permission. Re-evaluating the
    // same facts under a SUPERSET protected list still refuses, which is the
    // closest pure-function encoding of "a later listener can only add denials".
    for (const { name, write } of denials) {
      const first = writeRedLineViolation(write, PROTECTED)
      const second = writeRedLineViolation(write, [...PROTECTED, 'extra/**'])
      expect(first, name).toBeTypeOf('string')
      expect(second, name).toBeTypeOf('string')
    }
  })
})

describe('createTrustPolicy write context', () => {
  function config(over: Partial<Config> = {}): Config {
    return { allowWrite: false, protectedPaths: [], ...over }
  }

  it('binds and restores the change-set facts the write guard reads', () => {
    const policy = createTrustPolicy(config())
    expect(policy.writeContext).toBeUndefined()

    const context = { changedPaths: ['package.json'], binaryPaths: ['img.png'] }
    const dispose = policy.bindWriteContext(context)
    expect(policy.writeContext).toBe(context)

    dispose()
    expect(policy.writeContext).toBeUndefined()
  })
})

