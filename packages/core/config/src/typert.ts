/**
 * Typert host-face manifest for the `dshrb` browser Remote.
 *
 * The Typert loader auto-registers this artifact (via the package.json
 * `./typert` export) and the api-gateway uses it to wire `ctx.remote.dshrb`
 * to the `DshrbRemoteGateway` Service provided under `dshrbRemote`. Schemas
 * are zod-v4 instances: the loader's `requireStrictCodec` checks `_zod` +
 * `parse`, which schemastery schemas do not expose.
 */
import { z } from 'zod'

const clientConfigSchema = z.object({
  allowWrite: z.boolean(),
  githubTokenConfigured: z.boolean(),
  gitlabTokenConfigured: z.boolean(),
})

const configPatchSchema = z.object({
  githubToken: z.string().optional(),
  gitlabToken: z.string().optional(),
  allowWrite: z.boolean().optional(),
})

const setResultSchema = z.object({
  ok: z.boolean(),
})

export const TYPERT = {
  package: '@dshrb/config',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: '@dshrb/config#dshrb/getConfig',
      service: 'dshrbRemote',
      namespace: 'dshrb',
      method: 'getConfig',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@dshrb/config/types#ClientConfig',
        schema: clientConfigSchema,
      },
    },
    {
      id: '@dshrb/config#dshrb/setConfig',
      service: 'dshrbRemote',
      namespace: 'dshrb',
      method: 'setConfig',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'patch',
          wire: 'patch',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@dshrb/config/types#ConfigPatch',
            schema: configPatchSchema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@dshrb/config/types#SetResult',
        schema: setResultSchema,
      },
    },
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
}
