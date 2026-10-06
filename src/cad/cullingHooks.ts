import type { Box3, PerspectiveCamera } from 'three'

// Plug points for the culling techniques. Both are pass-through, so the selected HLOD is drawn as is.

/** Called once at the start of every HLOD selection pass. */
export const beginFrame = (camera: PerspectiveCamera): void => {
  void camera
}

/**
 * Asked for every candidate cell during traversal, with the cell's subtree bounds (it already
 * encloses all descendants). Returning false drops the cell and everything below it.
 */
export const isCellVisible = (box: Box3): boolean => {
  void box
  return true
}
