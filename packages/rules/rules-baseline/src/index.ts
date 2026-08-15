/**
 * Baseline rule pack.
 *
 * Declarative data only — no callbacks, no I/O. Deactivates automatically when
 * `reviewRules` is absent, via the Cordis reactive coeffect on `inject`.
 *
 * This pack is the first empirical proof that rules are data rather than
 * hardcoded prompts: it is useful out of the box, and doubles as the reference
 * shape for a third-party rule pack (docs/09-roadmap.md M2, docs/04-trust-model.md T13).
 */
import { ruleId } from '@dshrb/review-core'
import type { RulePack } from '@dshrb/rule-registry'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dshrb-rules-baseline'
export const inject = ['reviewRules']

/** Source files reviewed by the correctness / security / api-contract / maintainability groups. */
const CODE_GLOBS: readonly string[] = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.mts',
  '**/*.cts',
  '**/*.js',
  '**/*.jsx',
  '**/*.mjs',
  '**/*.cjs',
]

/** Files reviewed by the test-hygiene group. */
const TEST_GLOBS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
]

/** Generated or vendored code, where "duplicated" or "dead-looking" code is expected. */
const GENERATED_GLOBS: readonly string[] = [
  '**/*.generated.*',
  '**/generated/**',
  '**/vendor/**',
  '**/third_party/**',
]

/**
 * The baseline rules, split into the five groups from the M2 plan.
 *
 * Severity discipline: `blocker` is reserved for defects with a reproducible
 * failure path, so every advisory rule here starts at `major` or below — a bot
 * that cries blocker gets muted. Rules that only fire given a concrete scenario
 * set `requiresScenario: true` so the author owns noise control at rule
 * granularity (a finding citing such a rule without a `failureScenario` is
 * downgraded during validation).
 */
export const baselinePack: RulePack = {
  id: name,
  version: '0.1.0',
  title: 'DSH Reviewer baseline rules',
  rules: [
    // -------------------------------------------------------------------
    // correctness — null/undefined handling, off-by-one, unhandled
    //               rejection, resource leak, race on shared state
    // -------------------------------------------------------------------
    {
      id: ruleId('correctness/null-undefined'),
      severity: 'major',
      requiresScenario: true,
      applies: CODE_GLOBS,
      guidance:
        'Flag dereferencing a value that may be null or undefined without a preceding guard or narrowing. ' +
        'Report only when a concrete input or state reaches the dereference.',
    },
    {
      id: ruleId('correctness/off-by-one'),
      severity: 'major',
      requiresScenario: true,
      applies: CODE_GLOBS,
      guidance:
        'Flag loop bounds, slice ranges, or index arithmetic that read one element too many or too few. ' +
        'Name the concrete length and index that misfire.',
      goodExample: 'for (let i = 0; i < items.length; i++)',
      badExample: 'for (let i = 0; i <= items.length; i++)',
    },
    {
      id: ruleId('correctness/unhandled-rejection'),
      severity: 'major',
      requiresScenario: true,
      applies: CODE_GLOBS,
      guidance:
        'Flag a promise or async operation whose rejection is neither awaited nor caught, so an error path ' +
        'can terminate silently or crash. Identify the rejecting operation.',
    },
    {
      id: ruleId('correctness/resource-leak'),
      severity: 'major',
      requiresScenario: true,
      applies: CODE_GLOBS,
      guidance:
        'Flag a resource (handle, stream, socket, timer, subscription) opened without a guaranteed close or ' +
        'unsubscribe on every path, including error and early-return paths.',
    },
    {
      id: ruleId('correctness/shared-state-race'),
      severity: 'major',
      requiresScenario: true,
      applies: CODE_GLOBS,
      guidance:
        'Flag reads and writes of shared mutable state without synchronization where concurrent execution can ' +
        'interleave. Describe the interleaving that produces the wrong result.',
    },

    // -------------------------------------------------------------------
    // security — injection sink, missing authz on a new endpoint, secret
    //            in source, unsafe deserialization, path traversal
    // -------------------------------------------------------------------
    {
      id: ruleId('security/injection-sink'),
      severity: 'major',
      requiresScenario: true,
      applies: CODE_GLOBS,
      guidance:
        'Flag user- or network-controlled data reaching an injection sink (SQL, shell, template, HTML, eval) ' +
        'without sanitization or parameterization. Name both the tainted source and the sink.',
    },
    {
      id: ruleId('security/missing-authz'),
      severity: 'major',
      requiresScenario: true,
      applies: CODE_GLOBS,
      guidance:
        'Flag a new endpoint, route, or handler that performs a privileged action without an authorization ' +
        'check. Identify which check is missing.',
    },
    {
      id: ruleId('security/secret-in-source'),
      severity: 'major',
      requiresScenario: false,
      applies: CODE_GLOBS,
      guidance:
        'Flag hardcoded credentials, tokens, or private keys in source. Move them to a secret store or an ' +
        'environment variable.',
      goodExample: 'const token = process.env.FORGE_TOKEN',
      badExample: "const token = 'ghp_exposed_secret'",
    },
    {
      id: ruleId('security/unsafe-deserialization'),
      severity: 'major',
      requiresScenario: true,
      applies: CODE_GLOBS,
      guidance:
        'Flag deserialization of untrusted input into executable objects (eval, arbitrary object instantiation, ' +
        'prototype pollution). Name the untrusted input.',
    },
    {
      id: ruleId('security/path-traversal'),
      severity: 'major',
      requiresScenario: true,
      applies: CODE_GLOBS,
      guidance:
        'Flag a filesystem path built from user input without normalization or an allowlist, so `..` or an ' +
        'absolute path escapes the intended root.',
    },

    // -------------------------------------------------------------------
    // api-contract — breaking signature change without a version bump,
    //                silent behavior change
    // -------------------------------------------------------------------
    {
      id: ruleId('api-contract/breaking-signature'),
      severity: 'major',
      requiresScenario: false,
      applies: CODE_GLOBS,
      guidance:
        'Flag a change to an exported function or type signature (renamed, removed, or changed parameter or ' +
        'return types) that is not accompanied by a version bump or a migration note.',
    },
    {
      id: ruleId('api-contract/silent-behavior-change'),
      severity: 'major',
      requiresScenario: true,
      applies: CODE_GLOBS,
      guidance:
        'Flag a change that alters observable behavior without changing the signature (defaults, error semantics, ' +
        'ordering, side effects) and is not documented as breaking.',
    },

    // -------------------------------------------------------------------
    // maintainability — duplicated logic, dead code, misleading name
    // -------------------------------------------------------------------
    {
      id: ruleId('maintainability/duplicated-logic'),
      severity: 'minor',
      requiresScenario: false,
      applies: CODE_GLOBS,
      excludes: GENERATED_GLOBS,
      guidance: 'Flag logic duplicated across two or more sites that should be extracted into a shared helper.',
    },
    {
      id: ruleId('maintainability/dead-code'),
      severity: 'minor',
      requiresScenario: false,
      applies: CODE_GLOBS,
      excludes: GENERATED_GLOBS,
      guidance:
        'Flag code that is unreachable or no longer referenced (dead exports, unused branches, vestigial ' +
        'helpers) and can be removed.',
    },
    {
      id: ruleId('maintainability/misleading-name'),
      severity: 'nit',
      requiresScenario: false,
      applies: CODE_GLOBS,
      guidance: 'Flag an identifier whose name contradicts what the code does, inviting a future reader to misuse it.',
    },

    // -------------------------------------------------------------------
    // tests — new branch without coverage, leftover `test.skip` / `.only`
    // -------------------------------------------------------------------
    {
      id: ruleId('tests/missing-branch-coverage'),
      severity: 'minor',
      requiresScenario: false,
      applies: TEST_GLOBS,
      guidance: 'Flag a new branch or error path in the change that has no corresponding test. Name the uncovered branch.',
    },
    {
      id: ruleId('tests/skip-only-leftover'),
      severity: 'minor',
      requiresScenario: false,
      applies: TEST_GLOBS,
      guidance:
        'Flag leftover `test.skip`, `it.skip`, `describe.skip`, `test.only`, `it.only`, or `describe.only` that ' +
        'will silently skip or narrow the suite.',
    },
  ],
}

export function apply(ctx: Context): void {
  // Effect-based registration: unloading this plugin's fiber runs the disposer
  // returned by `register`, so the pack leaves the registry when the plugin is
  // removed (the tool-review / forge-github pattern).
  ctx.effect(() => ctx.reviewRules.register(baselinePack))
}
