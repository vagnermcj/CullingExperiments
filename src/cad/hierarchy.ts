import type { Box3 } from 'three'
import type { GeometryTier } from './types'

/**
 * hierarchy.bin: one fixed-size record per octree cell, in BFS order.
 *
 *   [0]  type u8 (0 leaf, 1 inner, 3 proxy)      [1]  childMask u8
 *   [2]  numTriangles u32                        [6]  byteOffset u64   (geometry.bin)
 *   [14] byteSize u64                            [22] bbox 6 x f32
 *   [46] lodOffset u64   [54] lodSize u32        [58] lod2Offset u64   [66] lod2Size u32
 *
 * Refinement is ADD: a parent keeps drawing its own geometry while its children add detail.
 * Records stay as bytes; nothing is allocated per cell.
 */
const NODE_PROXY = 3
const SIZE_WITH_LOD = 58
const SIZE_WITH_LOD2 = 70

export interface TierRange {
  offset: number
  size: number
}

const u64 = (view: DataView, at: number) => view.getUint32(at, true) + view.getUint32(at + 4, true) * 4294967296

export class Hierarchy {
  readonly count: number
  /** Index of a cell's first child, -1 when it has none. Children are consecutive, one per set bit of childMask. */
  readonly firstChild: Int32Array
  readonly parent: Int32Array
  private readonly view: DataView
  private readonly recordSize: number

  constructor(buffer: ArrayBuffer, recordSize: number) {
    this.recordSize = recordSize
    this.view = new DataView(buffer)
    this.count = Math.floor(buffer.byteLength / recordSize)
    this.firstChild = new Int32Array(this.count).fill(-1)
    this.parent = new Int32Array(this.count).fill(-1)
    this.link()
  }

  /** BFS order leaves parent/child links implicit; one pass over the records in write order recovers them. */
  private link(): void {
    const { count, view, recordSize } = this
    if (count === 0) return
    const queue = new Int32Array(count)
    let queued = 1
    let head = 0
    let next = 1
    while (head < queued && next < count) {
      const parent = queue[head++]
      if (view.getUint8(parent * recordSize) === NODE_PROXY) continue
      const mask = view.getUint8(parent * recordSize + 1)
      for (let slot = 0; slot < 8 && next < count; slot++) {
        if (!(mask & (1 << slot))) continue
        const child = next++
        if (this.firstChild[parent] < 0) this.firstChild[parent] = child
        this.parent[child] = parent
        if (view.getUint8(child * recordSize) !== NODE_PROXY) queue[queued++] = child
      }
    }
  }

  childMask(index: number): number {
    return this.view.getUint8(index * this.recordSize + 1)
  }

  numTriangles(index: number): number {
    return this.view.getUint32(index * this.recordSize + 2, true)
  }

  /** The cell's content bounds: everything in its whole subtree, not just its own geometry. */
  readBox(index: number, out: Box3): Box3 {
    const at = index * this.recordSize + 22
    const v = this.view
    out.min.set(v.getFloat32(at, true), v.getFloat32(at + 4, true), v.getFloat32(at + 8, true))
    out.max.set(v.getFloat32(at + 12, true), v.getFloat32(at + 16, true), v.getFloat32(at + 20, true))
    return out
  }

  /** Byte range of the cell's chunk in the tier's file; size 0 means the cell ships no such tier. */
  tierRange(index: number, tier: GeometryTier, out: TierRange): TierRange {
    const at = index * this.recordSize
    const v = this.view
    if (tier === 'raw') {
      out.offset = u64(v, at + 6)
      out.size = u64(v, at + 14)
    } else if (tier === 'lod1' && this.recordSize >= SIZE_WITH_LOD) {
      out.offset = u64(v, at + 46)
      out.size = v.getUint32(at + 54, true)
    } else if (tier === 'lod2' && this.recordSize >= SIZE_WITH_LOD2) {
      out.offset = u64(v, at + 58)
      out.size = v.getUint32(at + 66, true)
    } else {
      out.offset = 0
      out.size = 0
    }
    return out
  }
}
