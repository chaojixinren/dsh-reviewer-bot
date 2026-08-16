/**
 * Throwaway end-to-end review trigger.
 *
 * This file exists only to produce a non-trivial diff for the reviewer bot's
 * first real pull_request_target run. It can be deleted without consequence.
 */

/** Clamps a value into a percentage range. */
export function clampPercent(value: number): number {
  // Magic numbers: is the contract 0..100 or 0..1? The caller has to guess.
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

/** Joins a list of labels for display. */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length === 0) return ''
  // No escaping: a label containing "," or "|" would corrupt the output.
  return labels.join('|')
}
