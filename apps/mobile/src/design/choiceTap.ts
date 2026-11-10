// A tap on an ask's choice. The caller may refuse it, as a second tap on the same ask within a few seconds is; a refused
// tap mustn't feel taken, so the haptic follows the caller's answer.

/** False when the caller refused the tap; a caller that doesn't say takes every tap. */
export type ChooseChoice = (choice: string) => boolean | void

export function tapChoice(choice: string, onChoose: ChooseChoice, buzz: () => void): void {
  if (onChoose(choice) !== false) buzz()
}
