/**
 * Zoom bounds.
 *
 * The floor is dynamic — "the whole file fits the viewport" depends on duration
 * and viewport width, so only WaveformArea can compute it, and it broadcasts the
 * current value on wavely:view-update. The ceiling is a fixed constant, and it
 * lives here because three components need to agree on it: the viewport that
 * enforces it, the transport slider that maps its track onto it, and the
 * overview strip whose resize handles must stop where it stops.
 */
export const MAX_PIXELS_PER_SECOND = 2000
