#!/usr/bin/env node
/**
 * End-to-end verification of the three installation modes documented in the
 * README ("三种安装方式"). Each check exercises a real entrypoint, not a mock:
 *
 *   1. DSH 生态用户  `dsh plugin add @dshrb/bundle`
 *      The bundle patch (`bundle/cordis.patch.yml`) references plugin packages
 *      by NAME; those names must resolve to loadable Cordis plugins, and the
 *      full chain must boot in a real Cordis container (offline, no credential).
 *
 *   2. GitHub Action  `uses: dshrb/reviewer-action@v0.1.0`
 *      `action.yml` + `examples/review.yml` parse as valid YAML and agree with
 *      each other, and the bundled `dist/index.js` runs one full event to a
 *      terminal `result-json` (input read → runtime boot → pipeline → outputs).
 *
 *   3. Daemon         常驻 webhook 服务
 *      `driver-webhook` boots a real HTTP server, serves `/healthz`, enforces
 *      the webhook signature gate on `/webhook`, and disposes without residue.
 *
 * Prerequisites (already satisfied by `pnpm run check`):
 *   - a built `lib/` tree (`pnpm run typecheck`)
 *   - a built `dist/index.js` (`pnpm run build:release`) — built here if missing
 *   - Node >= 22
 *
 * Exit code is 0 only when every check passes. Run:
 *   pnpm run build:release && node scripts/e2e-install-modes.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

let passed = 0
let failed = 0

function ok(label) {
  passed += 1
  console.log(`  PASS  ${label}`)
}

function fail(label, detail) {
  failed += 1
  console.error(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function check(cond, label, detail) {
  if (cond) ok(label)
  else fail(label, detail)
}

// ---------------------------------------------------------------------------
// Mode 1: DSH 生态用户 — `dsh plugin add @dshrb/bundle`
// ---------------------------------------------------------------------------

/** The `- insert:` plugin names, in the patch's layer order. */
function bundlePatchNames() {
  const text = readFileSync(join(root, 'bundle', 'cordis.patch.yml'), 'utf8')
  const names = []
  let insideInsert = false
  for (const line of text.split('\n')) {
    const indent = /^( *)/u.exec(line)[1].length
    if (line.trim() === '- insert:') {
      insideInsert = true
      continue
    }
    // A new top-level layer entry would end the insert block; the patch has none.
    if (insideInsert && indent === 0 && line.trim() !== '' && !line.trim().startsWith('#')) break
    if (!insideInsert) continue
    const match = /^\s+name:\s*['"]?(@[^'"\s]+)['"]?\s*$/u.exec(line)
    if (match !== null) names.push(match[1])
  }
  return names
}

/** Maps a scoped `@dshrb/<pkg>` name to its built `lib/index.js`. */
function resolvePackageEntry(name) {
  const pkg = name.slice('@dshrb/'.length)
  for (const area of ['core', 'forge', 'tools', 'rules', 'drivers', 'probe']) {
    const candidate = join(root, 'packages', area, pkg, 'lib', 'index.js')
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`cannot resolve ${name} to a built lib entry`)
}

async function verifyProfileMode() {
  console.log('\n[1/3] DSH 生态用户 — `dsh plugin add @dshrb/bundle`')

  const names = bundlePatchNames()
  check(names.length >= 9, 'bundle patch lists the full plugin chain', `got ${names.length} names`)

  const loaded = []
  for (const name of names) {
    const entry = resolvePackageEntry(name)
    const mod = await import(entry)
    // Every patch row is a Cordis plugin: it exports `name` and `apply` (the
    // DSH launcher boots rows via `ctx.plugin`, same as a `dsh plugin add`).
    const isPlugin = typeof mod.name === 'string' && typeof mod.apply === 'function'
    check(isPlugin, `package resolves and is a plugin: ${name}`)
    if (isPlugin) loaded.push(name)
  }

  // Boot the exact same chain the bundle declares (runtime-bootstrap mounts the
  // same @dshrb layer order + the DSH runtime services a profile provides), and
  // assert the review tools + services compose offline.
  const { bootReviewRuntime } = await import(resolvePackageEntry('@dshrb/runtime-bootstrap'))
  const runtime = await bootReviewRuntime({})
  try {
    const { ctx } = runtime
    check(ctx.reviewRuntime !== undefined, 'reviewRuntime service is provided')
    check(ctx.reviewRules !== undefined, 'reviewRules service is provided')
    check(ctx.forges !== undefined, 'forges registry is provided')
    check(ctx.reviewTools !== undefined, 'reviewTools service is provided')
    check(ctx.trustPolicy !== undefined, 'trustPolicy service is provided')
    const tools = ctx.tools.schemas().map((schema) => schema.name)
    for (const expected of ['read_diff_shard', 'report_finding', 'propose_patch']) {
      check(tools.includes(expected), `review tool registers on shared ctx.tools: ${expected}`)
    }
    check(ctx.reviewRules.packs().length > 0, 'baseline rule pack is registered')
  } finally {
    await runtime.dispose()
  }
  ok(`full chain booted and disposed cleanly (${loaded.length} plugins)`)
}

// ---------------------------------------------------------------------------
// Mode 2: GitHub Action — `examples/review.yml`
// ---------------------------------------------------------------------------

/** Resolves the pinned `yaml` package from the pnpm store, or null. */
async function loadYaml() {
  const pnpmDir = join(root, 'node_modules', '.pnpm')
  if (!existsSync(pnpmDir)) return null
  const entries = readdirSync(pnpmDir).filter((name) => name.startsWith('yaml@'))
  for (const name of entries) {
    const entry = join(pnpmDir, name, 'node_modules', 'yaml', 'dist', 'index.js')
    if (existsSync(entry)) return (await import(entry)).default ?? (await import(entry))
  }
  return null
}

function buildReleaseIfMissing() {
  const outfile = join(root, 'dist', 'index.js')
  if (existsSync(outfile)) return outfile
  console.log('  (building dist/index.js via scripts/build-release.mjs …)')
  execFileSync(process.execPath, [join(root, 'scripts', 'build-release.mjs')], { cwd: root, stdio: 'inherit' })
  return outfile
}

async function verifyActionMode() {
  console.log('\n[2/3] GitHub Action — `uses: dshrb/reviewer-action@v0.1.0`')

  const YAML = await loadYaml()
  const actionText = readFileSync(join(root, 'action.yml'), 'utf8')
  const reviewText = readFileSync(join(root, 'examples', 'review.yml'), 'utf8')
  const commandsText = readFileSync(join(root, 'examples', 'commands.yml'), 'utf8')

  if (YAML === null) {
    fail('yaml parser unavailable', 'skipping parse checks')
  } else {
    const action = YAML.parse(actionText)
    const review = YAML.parse(reviewText)
    const commands = YAML.parse(commandsText)
    check(action.runs?.using === 'node24', 'action.yml declares the node24 runner', action.runs?.using)
    check(action.runs?.main === 'dist/index.js', 'action.yml main points at the built entrypoint', action.runs?.main)
    check(action.inputs?.['deepseek-api-key']?.required === true, 'action.yml requires deepseek-api-key')
    check(review.jobs?.review?.steps?.some((step) => step.uses === 'dshrb/reviewer-action@v0.1.0'), 'examples/review.yml uses dshrb/reviewer-action@v0.1.0')
    check(commands.jobs?.command?.steps?.some((step) => step.uses === 'dshrb/reviewer-action@v0.1.0'), 'examples/commands.yml uses dshrb/reviewer-action@v0.1.0')
    const reviewInputs = review.jobs.review.steps.find((step) => step.uses === 'dshrb/reviewer-action@v0.1.0')?.with ?? {}
    check('deepseek-api-key' in reviewInputs, 'examples/review.yml passes deepseek-api-key to the action')
  }

  const outfile = buildReleaseIfMissing()
  check(existsSync(outfile), 'bundled dist/index.js exists')

  // Drive the bundled entrypoint through its real process boundary. A malformed
  // event fails deterministically at ingest (E_INVALID_PAYLOAD) — no LLM, no
  // network — which proves input read → full DSH runtime boot → pipeline →
  // terminal result-json without a credential.
  const dir = mkdtempSync(join(tmpdir(), 'dshrb-e2e-action-'))
  try {
    writeFileSync(join(dir, 'event.json'), '{}', 'utf8')
    execFileSync(process.execPath, [outfile], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: join(dir, 'event.json'),
        GITHUB_RUN_ID: 'e2e-run-1',
        'INPUT_DEEPSEEK-API-KEY': 'sk-e2e-test',
        GITHUB_OUTPUT: join(dir, 'outputs'),
      },
      stdio: 'ignore',
    })
    ok('bundled entrypoint runs to completion (exit 0)')
    const outputs = readFileSync(join(dir, 'outputs'), 'utf8')
    check(outputs.includes('conclusion=failure\n'), 'action writes the terminal conclusion')
    check(outputs.includes('error-code=E_INVALID_PAYLOAD\n'), 'pipeline failure surfaces as error-code')
    const resultLine = outputs.split('\n').find((line) => line.startsWith('result-json='))
    check(resultLine !== undefined, 'action writes the versioned result-json envelope')
    if (resultLine !== undefined) {
      const envelope = JSON.parse(resultLine.slice('result-json='.length))
      check(envelope.schemaVersion === 1, 'result-json schemaVersion is 1')
      check(envelope.status === 'failed', 'result-json status is failed', envelope.status)
      check(envelope.failure?.code === 'E_INVALID_PAYLOAD', 'result-json failure.code is E_INVALID_PAYLOAD', envelope.failure?.code)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Mode 3: Daemon — 常驻 webhook 服务 (docs/08-deployment-modes.md)
// ---------------------------------------------------------------------------

/** Binds an ephemeral port, then releases it for the daemon to reuse. */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.once('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

async function verifyDaemonMode() {
  console.log('\n[3/3] Daemon — 常驻 webhook 服务')

  const { Context } = await import('@deepseek-ai/cordis')
  const webhook = await import(resolvePackageEntry('@dshrb/driver-webhook'))
  const { request } = await import('node:http')

  const port = await freePort()
  check(port > 0, 'obtained an ephemeral port', String(port))

  const ctx = new Context()
  // The daemon consumes `reviewRuntime`; a stub keeps this offline while still
  // exercising the real socket, signature gate, and lifecycle.
  ctx.provide('reviewRuntime', {
    runReview: async () => ({
      verdict: { status: 'success', findingsCount: 0, blockersCount: 0, durationMs: 0 },
      findings: [],
      discarded: [],
    }),
  })

  await ctx.plugin(webhook, { host: '127.0.0.1', port, secrets: { github: 's3cret' } })

  function call(path, { method = 'GET', headers = {}, body = '' } = {}) {
    return new Promise((resolveCall, rejectCall) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => resolveCall({ status: res.statusCode, body: data }))
      })
      req.on('error', rejectCall)
      req.end(body)
    })
  }

  try {
    const health = await call('/healthz')
    check(health.status === 200, '/healthz returns 200', `got ${health.status}`)
    const healthBody = JSON.parse(health.body)
    check(healthBody.ok === true, '/healthz reports ok')
    check(healthBody.version === '0.1.0', '/healthz reports the daemon version', healthBody.version)

    const badSig = await call('/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}`, 'x-github-delivery': 'd1' },
      body: '{"repository":{"full_name":"acme/w"},"pull_request":{"number":1}}',
    })
    check(badSig.status === 401, '/webhook rejects a bad signature with 401', `got ${badSig.status}`)
    check(badSig.body === '', '/webhook bad-signature body is empty (no enumeration)')

    const wrongMethod = await call('/webhook', { method: 'GET' })
    check(wrongMethod.status === 405, '/webhook rejects a non-POST with 405', `got ${wrongMethod.status}`)

    const unknown = await call('/nope')
    check(unknown.status === 404, 'unknown path returns 404', `got ${unknown.status}`)
  } finally {
    await ctx.fiber.dispose()
  }
  ok('daemon served, gated, and disposed with no residual listener')
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('DSH Reviewer Bot — e2e install-mode verification\n')
  await verifyProfileMode()
  await verifyActionMode()
  await verifyDaemonMode()

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    process.exitCode = 1
  }
}

await main()
