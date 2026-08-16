/**
 * Action entrypoint: the process boundary the bundled `dist/index.js` runs.
 *
 * `main()` already writes the terminal `result-json` output on every failure
 * path (see `driver-action`), so this file only turns a thrown error into a
 * non-zero exit code. It also exits explicitly: the booted Cordis runtime keeps
 * timers/handles alive after `main()` settles, and a one-shot Action process
 * must not wait on them (docs/05-packaging.md).
 */
import { main } from './index.js'

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
