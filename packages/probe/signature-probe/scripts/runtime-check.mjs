/**
 * Runtime signature check.
 *
 * Typechecking proves the shapes compile; this proves they actually load and
 * fire inside a real Cordis container. Run it after bumping any upstream
 * version — if an extension point changed, this fails here instead of failing
 * silently in production.
 *
 * Usage: node scripts/runtime-check.mjs   (requires `lib/` to be built)
 */
import { Context } from '@deepseek-ai/cordis'
import toolsPlugin from '@deepseek-ai/dsh-tools'
import systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as probe from '../lib/index.js'

/** Cordis activates plugins asynchronously; give the epoch time to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

const checks = []
const record = (label, pass, detail = '') => {
  checks.push({ label, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// --- 1. Reactive coeffect: apply() must be withheld without its services ----
{
  const ctx = new Context()
  let applied = false
  ctx.plugin({ name: 'coeffect-probe', inject: ['tools'], apply: () => { applied = true } })
  await settle()
  record('apply() withheld while injected service is absent', applied === false)
}

// --- 2. Service chain composes ----------------------------------------------
const ctx = new Context()
ctx.plugin(systemPromptPlugin)
ctx.plugin(toolsPlugin, {})
await settle()
record('systemPrompt service available', !!ctx.systemPrompt)
record('tools service available', !!ctx.tools)

if (!ctx.tools) {
  console.error('\nCannot continue: tools service did not compose.')
  process.exit(1)
}

// --- 3. Tool registration + JSON Schema emission ----------------------------
ctx.plugin(probe, { denyTools: ['probe_read_diff'] })
await settle()

const schema = ctx.tools.schemas().find((s) => s.name === 'probe_read_diff')
record('tool registered on ctx.tools', !!schema)
record(
  'flat parameter spec compiles to JSON Schema with top-level required[]',
  schema?.parameters?.required?.includes('path') === true,
  JSON.stringify(schema?.parameters),
)

// --- 4. Monotonic guard -----------------------------------------------------
const execution = {
  callId: 'probe-call',
  rootCallId: 'probe-call',
  name: 'probe_read_diff',
  arguments: { path: 'a.ts' },
  signal: new AbortController().signal,
  token: Symbol('probe-token'),
}
record(
  'guard denies a deny-listed tool (config reaches the guard)',
  typeof ctx.tools.guardReason(execution) === 'string',
  JSON.stringify(ctx.tools.guardReason(execution)),
)
record(
  'guard abstains for an unlisted tool',
  ctx.tools.guardReason({ ...execution, name: 'other_tool' }) === undefined,
)

const failed = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
