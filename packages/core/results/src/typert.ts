/**
 * Typert host-face manifest for the `dshrbResults` browser Remote.
 *
 * Mirrors `@dshrb/config`'s manifest: the Typert loader auto-registers this
 * artifact (via the package.json `./typert` export) and the api-gateway wires
 * `ctx.remote.dshrbResults` to the `DshrbResultsGateway` Service provided under
 * `dshrbResultsRemote`. Schemas are zod-v4 instances: the loader's
 * `requireStrictCodec` checks `_zod` + `parse`, which schemastery schemas do
 * not expose.
 *
 * The `submitResult` parameter is intentionally permissive (`z.unknown()`): the
 * envelope is validated and normalized on the Host by `normalizeEnvelope`, which
 * returns actionable errors for malformed input. The strict codec here only
 * needs to accept arbitrary JSON.
 */
import { z } from 'zod'

const severitySchema = z.enum(['blocker', 'major', 'minor', 'nit', 'info'])

const findingViewSchema = z.object({
  findingId: z.string().optional(),
  severity: severitySchema,
  title: z.string(),
  body: z.string().optional(),
  ruleId: z.string().optional(),
  path: z.string().optional(),
  line: z.number().optional(),
  side: z.enum(['left', 'right']).optional(),
  anchored: z.boolean().optional(),
  failureScenario: z.string().optional(),
})

const summarySchema = z.object({
  total: z.number(),
  bySeverity: z.record(z.string(), z.number()),
  byRule: z.record(z.string(), z.number()),
  suppressed: z.number(),
  discarded: z.number(),
})

const runSummarySchema = z.object({
  id: z.string(),
  schemaVersion: z.number(),
  status: z.string(),
  createdAt: z.string(),
  trustLevel: z.string().optional(),
  operation: z.string().optional(),
  forge: z.string().optional(),
  total: z.number(),
  blockers: z.number(),
  suppressed: z.number(),
  discarded: z.number(),
  writeRequested: z.boolean(),
  failureCode: z.string().optional(),
})

const writeSchema = z
  .object({
    appliedPatches: z.number(),
    commitSha: z.string().optional(),
    pullRequestUrl: z.string().optional(),
  })
  .optional()

const failureSchema = z
  .object({
    code: z.string(),
    phase: z.string(),
    title: z.string(),
    message: z.string(),
    guidance: z.string(),
    retryable: z.boolean(),
  })
  .nullable()
  .optional()

const runSchema = z.object({
  id: z.string(),
  schemaVersion: z.number(),
  status: z.string(),
  createdAt: z.string(),
  trustLevel: z.string().optional(),
  operation: z.string().optional(),
  forge: z.string().optional(),
  write: writeSchema,
  failure: failureSchema,
  replay: z.union([z.string(), z.null()]).optional(),
  rules: z.array(z.unknown()).optional(),
  timing: z.object({ durationMs: z.number().optional() }).optional(),
  summary: summarySchema,
  findings: z.array(findingViewSchema),
  suppressed: z.array(findingViewSchema),
  discarded: z.array(findingViewSchema),
})

const submitParamSchema = z.unknown()

const clearResultSchema = z.object({ ok: z.boolean() })
const submitResultSchema = z.object({ id: z.string() })

export const TYPERT = {
  package: '@dshrb/results',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: '@dshrb/results#dshrbResults/listResults',
      service: 'dshrbResultsRemote',
      namespace: 'dshrbResults',
      method: 'listResults',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@dshrb/results/types#ReviewRunSummary[]',
        schema: z.array(runSummarySchema),
      },
    },
    {
      id: '@dshrb/results#dshrbResults/getResult',
      service: 'dshrbResultsRemote',
      namespace: 'dshrbResults',
      method: 'getResult',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'id',
          wire: 'id',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@dshrb/results/types#ReviewRun',
        schema: runSchema,
      },
    },
    {
      id: '@dshrb/results#dshrbResults/submitResult',
      service: 'dshrbResultsRemote',
      namespace: 'dshrbResults',
      method: 'submitResult',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'envelope',
          wire: 'envelope',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@dshrb/results/types#ResultEnvelope',
            schema: submitParamSchema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@dshrb/results/types#SubmitResult',
        schema: submitResultSchema,
      },
    },
    {
      id: '@dshrb/results#dshrbResults/clearResults',
      service: 'dshrbResultsRemote',
      namespace: 'dshrbResults',
      method: 'clearResults',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'id',
          wire: 'id',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'string', schema: z.string().optional() },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@dshrb/results/types#ClearResult',
        schema: clearResultSchema,
      },
    },
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
}
