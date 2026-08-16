/**
 * Release build: bundles the standalone GitHub Action entrypoint into a single
 * `dist/index.js` the `action.yml` `main:` points at.
 *
 * The DSH base launcher resolves bare specifiers through a native helper
 * (`node-addon-require-builtin`) that cannot be esbuild-bundled, so the
 * standalone Action does NOT route through `dsh-app-boot`. Instead
 * `@dshrb/runtime-bootstrap` mounts the DSH runtime services via direct
 * `ctx.plugin()` construction, and every plugin is a static import esbuild can
 * fold into one file. See docs/05-packaging.md.
 *
 * Output is CommonJS: the repo root is `"type": "module"`, so `dist/` gets its
 * own `package.json` marking it commonjs. CJS sidesteps the ESM interop shims a
 * CJS dependency such as `yaml` would otherwise trip (`Dynamic require ... not
 * supported`). The only native module in the path — `koffi`, lazily imported by
 * `dsh-fs-local` on Windows — stays external (see below).
 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'packages/drivers/driver-action/src/entry.ts')
const outdir = resolve(root, 'dist')
const outfile = resolve(outdir, 'index.js')

mkdirSync(outdir, { recursive: true })
// The root package.json is `"type": "module"`; the bundled file is CommonJS,
// so `dist/` carries its own scope marker.
writeFileSync(resolve(outdir, 'package.json'), '{"type":"commonjs"}\n')

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  // Some DSH packages read their own `package.json` version via
  // `createRequire(import.meta.url)`. CommonJS output has no `import.meta`, so
  // alias the member to a value we define in the banner: the bundle's own file
  // URL, from which `../package.json` resolves to the repo root (the version
  // string is cosmetic in the HTTP User-Agent header).
  banner: {
    js: 'const __dshrb_import_meta_url = require("node:url").pathToFileURL(__filename).href;\n',
  },
  define: { 'import.meta.url': '__dshrb_import_meta_url' },
  // `dsh-fs-sandbox` → `dsh-fs-local` dynamic-imports `koffi` (a native FFI
  // binding) lazily and only on Windows for atomic-file replacement. It must
  // stay external so the import survives as a runtime `import("koffi")` and is
  // never loaded on the Linux Action runner. No other native module is in the
  // direct-assembly path (docs/05-packaging.md).
  external: ['koffi'],
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
})

console.log(`bundled ${entry} -> ${outfile}`)
