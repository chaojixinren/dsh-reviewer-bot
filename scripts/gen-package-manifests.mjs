#!/usr/bin/env node
/**
 * Generates package.json + tsconfig.json for every workspace package.
 *
 * Manifest invariants follow the upstream DSH package checklist:
 * type module, main lib/index.js, types lib/types/index.d.ts,
 * cordis in BOTH peerDependencies and devDependencies at the same range.
 *
 * Only the `PUBLISHABLE` set below drops `private` and gains `license` /
 * `repository` / `publishConfig`; everything else stays `private`.
 *
 * Upstream versions are pinned exactly, not ranged. DSH is a developer
 * preview that documents breaking changes between rc builds, so a range
 * would let a patch bump silently move an extension point. Bump these
 * constants deliberately, then re-run @dshrb/signature-probe's runtime
 * check to confirm the signatures still hold.
 *
 * A plugin peer-depends on the specific dsh-* package that owns each
 * service it injects, never on @deepseek-ai/dsh wholesale.
 *
 * Re-run after adding a package to the table below.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = '0.1.0'
const CORDIS = '4.0.1'
const SCHEMASTERY = '3.18.1'
/** All @deepseek-ai/dsh-* packages ship in lockstep with @deepseek-ai/dsh. */
const DSH = '0.1.0-rc.6'

/**
 * Upstream dsh-* packages a given package peer-depends on, keyed by short
 * name. Verified against @dshrb/signature-probe: dsh-tools' own plugin
 * injects systemPrompt, so anything using ctx.tools needs both present.
 */
const UPSTREAM = {
  'trust-policy': ['dsh-tools', 'dsh-system-prompt'],
  'tool-review': ['dsh-tools', 'dsh-system-prompt'],
  'review-runtime': ['dsh-subagent', 'dsh-tools', 'dsh-system-prompt', 'dsh-llm', 'dsh-fs', 'dsh-sandbox', 'dsh-sandbox-policy'],
  // progress subscribes to `session/event`, owned by dsh-session.
  'progress': ['dsh-session'],
}

/**
 * Workspace packages a given package dev-depends on for its own tests only
 * (test-time imports, never shipped). `trust-policy`'s parity test imports
 * `TOOL_NAMES` from tool-review to keep the two tool tables from drifting.
 */
const WORKSPACE_DEV_DEPS = {
  'trust-policy': ['tool-review'],
}

/** dir, package name, description, workspace deps (short names) */
const PACKAGES = [
  ['core/review-core', 'review-core', 'Domain types and invariants for review requests, findings, and verdicts.', []],
  ['core/forge', 'forge', 'ForgeGateway capability interfaces and the provider registry.', ['review-core']],
  ['core/trust-policy', 'trust-policy', 'Actor permission to TrustLevel resolution and tool execution gating.', ['review-core', 'forge']],
  ['core/rule-registry', 'rule-registry', 'Declarative review rule pack registry with glob matching.', ['review-core']],
  ['core/progress', 'progress', 'Sticky progress comment lifecycle reporter.', ['review-core', 'forge']],
  ['core/review-runtime', 'review-runtime', 'The eight-stage review pipeline orchestrator.', ['review-core', 'forge', 'trust-policy', 'rule-registry', 'tool-review']],
  ['forge/forge-github', 'forge-github', 'GitHub ForgeGateway provider.', ['review-core', 'forge']],
  ['forge/forge-gitlab', 'forge-gitlab', 'GitLab ForgeGateway provider.', ['review-core', 'forge']],
  ['forge/forge-local', 'forge-local', 'Local git ForgeGateway provider for offline dry-run.', ['review-core', 'forge']],
  ['tools/tool-review', 'tool-review', 'Model-facing review tools registered on ctx.tools.', ['review-core', 'rule-registry']],
  ['rules/rules-baseline', 'rules-baseline', 'Baseline review rule pack: correctness, security, maintainability.', ['review-core', 'rule-registry']],
  ['drivers/driver-action', 'driver-action', 'GitHub Action driver shell.', ['review-core', 'review-runtime', 'forge-github']],
  ['drivers/driver-webhook', 'driver-webhook', 'Long-running webhook daemon driver shell.', ['review-core', 'review-runtime']],
  ['drivers/driver-cli', 'driver-cli', 'Local dry-run, replay, and rule debugging CLI.', ['review-core', 'review-runtime', 'forge', 'forge-local', 'rule-registry', 'rules-baseline', 'trust-policy']],
]

const dirOf = new Map(PACKAGES.map(([dir, short]) => [short, dir]))

/**
 * Packages published to npm. The set is exactly the transitive closure of
 * `@dshrb/bundle`'s dependencies: `bundle/cordis.patch.yml` references these
 * plugins by NAME, so they (plus `review-core`, the shared domain types every
 * one of them imports at runtime) must exist on the registry for
 * `dsh plugin add @dshrb/bundle` to resolve.
 *
 * Drivers, the local forge, and the signature probe stay `private` — they ship
 * through the Action / Daemon / CLI deployment modes, not through the bundle.
 */
const PUBLISHABLE = new Set([
  'review-core',
  'forge',
  'trust-policy',
  'rule-registry',
  'progress',
  'review-runtime',
  'forge-github',
  'forge-gitlab',
  'tool-review',
  'rules-baseline',
])

for (const [dir, short, description, deps] of PACKAGES) {
  const pkgDir = join(root, 'packages', dir)
  mkdirSync(join(pkgDir, 'src'), { recursive: true })

  const dependencies = { '@deepseek-ai/schemastery': SCHEMASTERY }
  for (const d of deps) {
    dependencies[`@dshrb/${d}`] = 'workspace:*'
  }

  // cordis and every injected service's owner appear in peer + dev at the
  // same pinned version: peer so the host supplies one copy, dev so this
  // package can typecheck and test standalone.
  const peerDependencies = { '@deepseek-ai/cordis': CORDIS }
  for (const u of UPSTREAM[short] ?? []) {
    peerDependencies[`@deepseek-ai/${u}`] = DSH
  }
  const devDependencies = { ...peerDependencies }
  for (const d of WORKSPACE_DEV_DEPS[short] ?? []) {
    devDependencies[`@dshrb/${d}`] = 'workspace:*'
  }

  const pkg = {
    name: `@dshrb/${short}`,
    version: VERSION,
    ...(PUBLISHABLE.has(short)
      ? {}
      : { private: true }),
    type: 'module',
    description,
    ...(PUBLISHABLE.has(short)
      ? {
          license: 'MIT',
          repository: {
            type: 'git',
            url: 'git+https://github.com/chaojixinren/dsh-reviewer-bot.git',
            directory: `packages/${dir}`,
          },
          publishConfig: { access: 'public' },
        }
      : {}),
    main: 'lib/index.js',
    types: 'lib/types/index.d.ts',
    exports: {
      '.': {
        types: './lib/types/index.d.ts',
        default: './lib/index.js',
      },
    },
    files: ['lib/index.js', 'lib/types/**/*.d.ts'],
    dependencies,
    peerDependencies,
    devDependencies,
  }
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

  const references = deps.map(d => ({
    path: relative(pkgDir, join(root, 'packages', dirOf.get(d))).replaceAll('\\', '/'),
  }))
  const tsconfig = {
    extends: relative(pkgDir, join(root, 'tsconfig.base.json')).replaceAll('\\', '/'),
    compilerOptions: { rootDir: 'src', outDir: 'lib', declarationDir: 'lib/types' },
    include: ['src/**/*'],
    ...(references.length ? { references } : {}),
  }
  writeFileSync(join(pkgDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n')
  console.log(`generated packages/${dir}`)
}
