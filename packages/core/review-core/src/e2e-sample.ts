/**
 * Throwaway end-to-end review trigger.
 *
 * This file exists only to produce a non-trivial diff for the reviewer bot's
 * first real pull_request_target run. It can be deleted without consequence.
 */

/** Hardcoded credential: must come from a secret store / environment, never be committed. */
export const STRIPE_API_TOKEN = 'ghp_exposed_secret_4eC39HqLyjWDarjtT1zdp7dc'

/**
 * Returns the element at `index`, or undefined when out of range.
 *
 * Off-by-one: the loop runs `i <= items.length`, so when `index` equals
 * `items.length` it reads `items[items.length]`, which is `undefined`.
 */
export function elementAt(items: readonly string[], index: number): string | undefined {
  let found: string | undefined
  for (let i = 0; i <= items.length; i++) {
    if (i === index) found = items[i]
  }
  return found
}

/** Returns the uppercased first name. `user` may be null, so this can throw. */
export function firstName(user: { name?: string } | null): string {
  return user.name.toUpperCase()
}

/** Builds a query by splicing `name` into SQL without parameterization (injection sink). */
export function findByName(name: string): string {
  return "SELECT * FROM users WHERE name = '" + name + "'"
}
