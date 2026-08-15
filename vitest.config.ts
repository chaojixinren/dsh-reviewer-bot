import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Scope to real workspace sources. Without this, vitest walks the whole
    // tree and collects tests out of linked git worktrees and the pnpm store,
    // which report as passing suites that are not this checkout's code.
    include: ['packages/*/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/lib/**', '.worktrees/**', '.pnpm-store/**'],
    // No `passWithNoTests`: M1 has landed real tests, so an empty suite now
    // means collection broke and must fail instead of reporting green.
  },
})
