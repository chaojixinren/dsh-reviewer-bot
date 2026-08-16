/**
 * dshrb shared runtime configuration.
 *
 * Owns the `dshrb` settings namespace so the Web UI can edit the GitHub /
 * GitLab tokens and the write toggle, and every other dshrb plugin reads the
 * resolved value through the `ctx.dshrb` service instead of its own config.
 *
 * Resolution layers, in order: schema defaults, then this plugin's composition
 * entry (the `FORGE_TOKEN` / `FORGE_GITLAB_TOKEN` env fallback wired in
 * `bundle/cordis.patch.yml`), then the user's settings document. The tokens are
 * `role('secret')`, so they are write-only on any wire surface but are fully
 * present on the resolved value the Host reads here.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

export interface Config {
  githubToken: string
  gitlabToken: string
  allowWrite: boolean
}

export const Config: Schema<Config> = Schema.object({
  githubToken: Schema.string().role('secret').default(''),
  gitlabToken: Schema.string().role('secret').default(''),
  allowWrite: Schema.boolean().default(false),
})

/** Read-only service every other dshrb plugin reads as `ctx.dshrb`. */
export interface DshrbConfigService {
  /** Current resolved config (settings > composition entry > defaults). */
  get(): Config
  /** Subscribe to resolved-config changes; returns the unsubscription disposer. */
  watch(callback: (next: Config, prev?: Config) => void | Promise<void>): () => void
  /** Merge a partial write into the user's settings document. */
  update(patch: Partial<Config>): Promise<void>
}

export const name = 'dshrb-config'

export function apply(ctx: Context, config: Config): void {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  ctx.provide('dshrb', settings === undefined
    ? staticService(config)
    : settingsService(settings, config))
}

function settingsService(settings: SettingsProvider, entry: Config): DshrbConfigService {
  const scope: SettingsScope<Config> = settings.register(settingsNamespace('dshrb'), Config, { base: entry })
  return {
    get: () => scope.get(),
    watch: callback => scope.watch(callback),
    update: patch => scope.update(patch),
  }
}

/** Fallback when no settings provider is mounted (standalone deployment). */
function staticService(entry: Config): DshrbConfigService {
  const watchers = new Set<(next: Config, prev?: Config) => void | Promise<void>>()
  return {
    get: () => entry,
    watch: (callback) => {
      watchers.add(callback)
      return () => { watchers.delete(callback) }
    },
    update: async () => {
      throw new Error('dshrb: settings service is unavailable in this deployment')
    },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshrb: DshrbConfigService
  }
}
