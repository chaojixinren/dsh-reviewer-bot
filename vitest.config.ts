import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Scope to real workspace sources. Without this, vitest walks the whole
    // tree and collects tests out of linked git worktrees and the pnpm store,
    // which report as passing suites that are not this checkout's code.
    include: ['packages/*/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/lib/**', '.worktrees/**', '.pnpm-store/**'],
    // Scaffolding phase only: there are no tests yet, and a bare "no test
    // files" failure would keep `pnpm check` permanently red for the wrong
    // reason. Remove this the moment M1 lands its first real test, so an
    // empty suite goes back to being a failure.
    passWithNoTests: true,
  },
})
