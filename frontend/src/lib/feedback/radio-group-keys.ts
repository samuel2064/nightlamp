// WAI-ARIA radio-group keyboard rules for the custom NPS and star scales:
// ArrowRight/ArrowDown move to the next choice and select it, ArrowLeft/
// ArrowUp move to the previous one, Home jumps to the first and End to the
// last. The movement wraps at the ends. Kept pure so the keyboard contract is
// unit-tested without a DOM.

export type RadioGroupKeyAction = 'next' | 'previous' | 'first' | 'last' | null

export function radioGroupKeyAction(key: string): RadioGroupKeyAction {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return 'next'
    case 'ArrowLeft':
    case 'ArrowUp':
      return 'previous'
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
    default:
      return null
  }
}

/** Resolves the target index for a keyboard action inside a radio group of the
 * given length, wrapping at both ends. */
export function radioGroupTargetIndex(
  action: RadioGroupKeyAction,
  currentIndex: number,
  length: number,
): number | null {
  if (length <= 0) return null
  switch (action) {
    case 'next':
      return currentIndex + 1 < length ? currentIndex + 1 : 0
    case 'previous':
      return currentIndex - 1 >= 0 ? currentIndex - 1 : length - 1
    case 'first':
      return 0
    case 'last':
      return length - 1
    default:
      return null
  }
}