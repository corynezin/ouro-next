// Where a pin sits among a person's pins. Positions are numbers in ascending order; a pin moved between two others takes
// the number halfway between theirs, so one move changes one pin. Halving runs out of precision eventually: then every
// pin is renumbered.

/** Closer than this, two neighbours' positions can't be halved reliably any more. */
const MIN_GAP = 1e-9

/**
 * The position for a pin placed at index `at` among the person's other pins (`others`, their positions in order): between
 * its neighbours, one before the first, or one after the last. Null when its neighbours are too close: renumber instead.
 */
export function pinPositionAt(others: readonly number[], at: number): number | null {
  const before = others[at - 1]
  const after = others[at]
  if (before === undefined && after === undefined) return 0
  if (before === undefined) return after! - 1
  if (after === undefined) return before + 1
  return after - before < MIN_GAP ? null : (before + after) / 2
}

/** The position for a new pin, after all of the person's pins: the next whole number. */
export const pinPositionAfter = (last: number | undefined): number => (last === undefined ? 0 : Math.floor(last) + 1)
