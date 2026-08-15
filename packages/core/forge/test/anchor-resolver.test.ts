import { describe, expect, it } from 'vitest'
import { createAnchorResolver } from '../src/index.ts'
import type { DiffFile, DiffHunk, UnifiedDiff } from '../src/index.ts'

/**
 * Anchoring accuracy is a registered high risk (docs/09-roadmap.md): a comment
 * landing on the wrong line damages trust directly, so anchoring is forced to
 * land inside a hunk with an explicit degradation path. These tests cover the
 * boundaries of that contract — hunk start/end, the line just outside, and the
 * paths that must degrade rather than guess (renamed, binary, absent).
 */

function hunk(over: Partial<DiffHunk> = {}): DiffHunk {
  return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, text: '@@', ...over }
}

function file(over: Partial<DiffFile> = {}): DiffFile {
  return { path: 'src/a.ts', hunks: [], binary: false, ...over }
}

function diff(files: readonly DiffFile[]): UnifiedDiff {
  return { files }
}

describe('createAnchorResolver', () => {
  const resolver = createAnchorResolver()

  it('anchors the first and last new-side line of a hunk', () => {
    // @@ -10,5 +20,5 @@ covers new lines 20-24 and old lines 10-14.
    const d = diff([file({ hunks: [hunk({ oldStart: 10, oldLines: 5, newStart: 20, newLines: 5 })] })])
    expect(resolver.resolve(d, 'src/a.ts', 20)).toEqual({
      path: 'src/a.ts', line: 20, side: 'right', anchored: true,
    })
    expect(resolver.resolve(d, 'src/a.ts', 24)).toEqual({
      path: 'src/a.ts', line: 24, side: 'right', anchored: true,
    })
  })

  it('degrades one line past the hunk boundary instead of guessing', () => {
    const d = diff([file({ hunks: [hunk({ oldStart: 10, oldLines: 5, newStart: 20, newLines: 5 })] })])
    const anchor = resolver.resolve(d, 'src/a.ts', 25)
    expect(anchor.anchored).toBe(false)
    expect(anchor.fallbackReason).toMatch(/outside every diff hunk/)
    // The finding is still returned with its coordinates, never dropped.
    expect(anchor.path).toBe('src/a.ts')
    expect(anchor.line).toBe(25)
  })

  it('anchors a removed line on the left (old) side', () => {
    const d = diff([file({ hunks: [hunk({ oldStart: 10, oldLines: 5, newStart: 20, newLines: 5 })] })])
    expect(resolver.resolve(d, 'src/a.ts', 10)).toEqual({
      path: 'src/a.ts', line: 10, side: 'left', anchored: true,
    })
  })

  it('prefers the new side when a hunk would place a line on both', () => {
    // A no-op hunk where old and new ranges coincide: @@ -5,1 +5,1 @@.
    const d = diff([file({ hunks: [hunk({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 })] })])
    expect(resolver.resolve(d, 'src/a.ts', 5).side).toBe('right')
  })

  it('anchors a pure insertion on the right and a pure deletion on the left', () => {
    const insertion = diff([file({ hunks: [hunk({ oldStart: 5, oldLines: 0, newStart: 5, newLines: 3 })] })])
    expect(resolver.resolve(insertion, 'src/a.ts', 7).side).toBe('right')

    const deletion = diff([file({ hunks: [hunk({ oldStart: 5, oldLines: 3, newStart: 5, newLines: 0 })] })])
    expect(resolver.resolve(deletion, 'src/a.ts', 6).side).toBe('left')
  })

  it('resolves a renamed file by its previousPath', () => {
    const d = diff([file({
      path: 'src/new.ts', previousPath: 'src/old.ts', hunks: [hunk({ oldStart: 1, newStart: 1 })],
    })])
    // A right-side hit must carry the forge-routable new path, never the stale
    // previousPath the proposal cited: publish posts `anchor.path` verbatim.
    expect(resolver.resolve(d, 'src/old.ts', 1)).toEqual({
      path: 'src/new.ts', line: 1, side: 'right', anchored: true,
    })
    // The new path still resolves too.
    expect(resolver.resolve(d, 'src/new.ts', 1).anchored).toBe(true)
  })

  it('maps a removed line of a renamed file onto previousPath', () => {
    const d = diff([file({
      path: 'src/new.ts', previousPath: 'src/old.ts',
      hunks: [hunk({ oldStart: 5, oldLines: 2, newStart: 3, newLines: 0 })],
    })])
    // Old-only line 6 lives under the old path on the left side.
    expect(resolver.resolve(d, 'src/old.ts', 6)).toEqual({
      path: 'src/old.ts', line: 6, side: 'left', anchored: true,
    })
    // Citing the new path still remaps the removed line to its old path.
    expect(resolver.resolve(d, 'src/new.ts', 6)).toEqual({
      path: 'src/old.ts', line: 6, side: 'left', anchored: true,
    })
  })

  it('right side wins across hunks when a line falls in both', () => {
    // Hunk 1 covers only old lines 10-11; hunk 2 covers only new lines 10-11.
    // Line 10 is an old-side hit in the first hunk but a new-side hit in the
    // second. The new side must win: an earlier left hit must not shadow a
    // later right hit.
    const d = diff([file({
      hunks: [
        hunk({ oldStart: 10, oldLines: 2, newStart: 10, newLines: 0 }),
        hunk({ oldStart: 12, oldLines: 0, newStart: 10, newLines: 2 }),
      ],
    })])
    expect(resolver.resolve(d, 'src/a.ts', 10)).toEqual({
      path: 'src/a.ts', line: 10, side: 'right', anchored: true,
    })
  })

  it('degrades a binary file, which has no line hunks', () => {
    const d = diff([file({ path: 'img.png', binary: true })])
    const anchor = resolver.resolve(d, 'img.png', 1)
    expect(anchor.anchored).toBe(false)
    expect(anchor.fallbackReason).toMatch(/binary/)
  })

  it('degrades a file absent from the diff', () => {
    const d = diff([file({ hunks: [hunk()] })])
    const anchor = resolver.resolve(d, 'src/missing.ts', 1)
    expect(anchor.anchored).toBe(false)
    expect(anchor.fallbackReason).toMatch(/not in the diff/)
  })

  it('degrades a line in the gap between two hunks', () => {
    const d = diff([file({
      hunks: [
        hunk({ oldStart: 10, oldLines: 2, newStart: 10, newLines: 2 }),
        hunk({ oldStart: 20, oldLines: 2, newStart: 20, newLines: 2 }),
      ],
    })])
    const anchor = resolver.resolve(d, 'src/a.ts', 15)
    expect(anchor.anchored).toBe(false)
    expect(anchor.fallbackReason).toMatch(/outside every diff hunk/)
  })
})
