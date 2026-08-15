import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Deterministic bundle-assembly checks.
 *
 * The bundle's published artifact is `bundle/cordis.patch.yml` (see
 * `dsh.bundle.patch` in `bundle/package.json`). We do not boot a DSH process
 * here — we parse the YAML text and assert the structural facts the coexistence
 * contract depends on (docs/05-plugin-composition.md): package names, unique
 * ids, layer order, and the fail-closed `allowWrite` default.
 */

const here = dirname(fileURLToPath(import.meta.url))
const PATCH_PATH = join(here, '..', '..', '..', '..', 'bundle', 'cordis.patch.yml')

/** One plugin row inside the `- insert:` list. */
interface BundleEntry {
  readonly id: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
}

/** Scalar values our patch uses: booleans, numbers, quoted/unquoted strings. */
function scalar(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/u.test(raw)) return Number(raw)
  if (raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) {
    return raw.slice(1, -1)
  }
  return raw
}

/**
 * A focused parser for OUR bundle patch shape:
 *
 * ```yaml
 * - insert:
 *     - id: dshrb-rule-registry
 *       name: '@dshrb/rule-registry'
 *       config:
 *         minSeverity: minor
 * ```
 *
 * It is not general YAML — it fails loudly on any unexpected structure so a
 * format drift breaks this test instead of silently weakening the assertions.
 */
function parseBundlePatch(text: string): readonly BundleEntry[] {
  const lines = text.split('\n')
  const entries: BundleEntry[] = []

  const indentOf = (line: string): number => /^( *)/u.exec(line)?.[1]?.length ?? 0

  let cursor = 0
  let insertIndent = -1
  while (cursor < lines.length) {
    if (lines[cursor]!.trim() === '- insert:') {
      insertIndent = indentOf(lines[cursor]!)
      cursor++
      break
    }
    cursor++
  }
  if (insertIndent < 0) {
    throw new Error('bundle patch is missing the top-level `- insert:` list')
  }

  while (cursor < lines.length) {
    const line = lines[cursor]!
    const indent = indentOf(line)
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      cursor++
      continue
    }
    if (indent <= insertIndent) break
    if (!trimmed.startsWith('- id:')) {
      throw new Error(`bundle patch: expected an entry '- id:' at line ${cursor + 1}, got '${trimmed}'`)
    }
    const id = String(scalar(trimmed.slice('- id:'.length).trim()))
    cursor++

    let name = ''
    const config: Record<string, unknown> = {}
    while (cursor < lines.length) {
      const next = lines[cursor]!
      const nextIndent = indentOf(next)
      const nextTrimmed = next.trim()
      if (nextTrimmed === '' || nextTrimmed.startsWith('#')) {
        cursor++
        continue
      }
      if (nextIndent <= indent) break
      if (nextTrimmed.startsWith('name:')) {
        name = String(scalar(nextTrimmed.slice('name:'.length).trim()))
        cursor++
        continue
      }
      if (nextTrimmed === 'config:') {
        cursor++
        while (cursor < lines.length) {
          const configLine = lines[cursor]!
          const configIndent = indentOf(configLine)
          const configTrimmed = configLine.trim()
          if (configTrimmed === '' || configTrimmed.startsWith('#')) {
            cursor++
            continue
          }
          if (configIndent <= nextIndent) break
          const colon = configTrimmed.indexOf(':')
          if (colon < 0) {
            throw new Error(`bundle patch: config entry without ':' at line ${cursor + 1}: '${configTrimmed}'`)
          }
          config[configTrimmed.slice(0, colon).trim()] = scalar(configTrimmed.slice(colon + 1).trim())
          cursor++
        }
        continue
      }
      throw new Error(`bundle patch: unexpected line in entry '${id}' at line ${cursor + 1}: '${nextTrimmed}'`)
    }
    if (name === '') {
      throw new Error(`bundle patch: entry '${id}' has no name`)
    }
    entries.push({ id, name, config })
  }
  return entries
}

function patch(): readonly BundleEntry[] {
  return parseBundlePatch(readFileSync(PATCH_PATH, 'utf8'))
}

/** The layer order the reactive coeffects expect (docs/05:84-116). */
const EXPECTED_NAMES = [
  '@dshrb/rule-registry',
  '@dshrb/rules-baseline',
  '@dshrb/trust-policy',
  '@dshrb/forge',
  '@dshrb/forge-github',
  '@dshrb/tool-review',
  '@dshrb/progress',
  '@dshrb/review-runtime',
] as const

describe('bundle cordis.patch.yml assembly', () => {
  it('inserts the plugin packages by NAME, in the documented layer order', () => {
    const entries = patch()
    expect(entries.map((entry) => entry.name)).toEqual([...EXPECTED_NAMES])
  })

  it('keeps every insert id unique', () => {
    const ids = patch().map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('sets the fail-closed allowWrite default on both write-mode layers', () => {
    const entries = patch()
    const byName = new Map(entries.map((entry) => [entry.name, entry]))
    expect(byName.get('@dshrb/trust-policy')?.config.allowWrite).toBe(false)
    // review-runtime mirrors trust-policy's switch so the two never drift.
    expect(byName.get('@dshrb/review-runtime')?.config.allowWrite).toBe(false)
  })

  it('exposes the diagnose intent switch, defaulting to enabled', () => {
    const entries = patch()
    const runtime = entries.find((entry) => entry.name === '@dshrb/review-runtime')
    expect(runtime?.config.enableDiagnose).toBe(true)
  })

  it('references packages by NAME, never a relative path', () => {
    for (const entry of patch()) {
      // A scoped npm package name (`@dshrb/rule-registry`), never `./x` or `../x`.
      expect(entry.name).toMatch(/^@[^/]+\/[^/]+$/u)
      expect(entry.name.startsWith('.')).toBe(false)
    }
  })
})
