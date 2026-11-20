import type { CellSink, DecodedCell } from '../cad/types'

export const MAX_SLOTS = 16384
/** drawIndexedIndirect arguments: indexCount, instanceCount, firstIndex, baseVertex, firstInstance. */
export const ARGS_U32 = 5
export const ARGS_BYTES = ARGS_U32 * 4

export interface StoredCell {
  position: GPUBuffer
  normal: GPUBuffer
  color: GPUBuffer
  index: GPUBuffer
  indexCount: number
  bytes: number
}

/**
 * Resident cells on the GPU. Each cell owns its vertex/index buffers and a slot; the per-slot tables
 * (box, selected flag, draw arguments) are what the culling compute shader reads and writes.
 */
export class CellStore implements CellSink {
  readonly boxes: GPUBuffer
  readonly selectedBuffer: GPUBuffer
  readonly args: GPUBuffer
  /** CPU copy of `boxes`: 8 floats per slot (min.xyz, 0, max.xyz, 0). */
  readonly boxCpu = new Float32Array(MAX_SLOTS * 8)

  private readonly device: GPUDevice
  private readonly slots: (StoredCell | null)[] = []
  private readonly free: number[] = []
  private readonly selectedCpu = new Uint32Array(MAX_SLOTS)
  private dirty = false
  private used = 0
  private totalBytes = 0

  constructor(device: GPUDevice) {
    this.device = device
    this.boxes = device.createBuffer({
      label: 'cell boxes',
      size: MAX_SLOTS * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.selectedBuffer = device.createBuffer({
      label: 'cell selected',
      size: MAX_SLOTS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.args = device.createBuffer({
      label: 'cell draw args',
      size: MAX_SLOTS * ARGS_BYTES,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.INDIRECT |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    })
  }

  /** Slots in use, counting holes: the compute shader runs over this many. */
  get highWater(): number {
    return this.used
  }

  get bytes(): number {
    return this.totalBytes
  }

  get cells(): readonly (StoredCell | null)[] {
    return this.slots
  }

  addCell(cell: DecodedCell): number {
    const slot = this.free.pop() ?? (this.used < MAX_SLOTS ? this.used++ : -1)
    if (slot < 0) return -1

    const { device } = this
    const upload = (data: ArrayBufferView<ArrayBuffer>, usage: number, label: string) => {
      const buffer = device.createBuffer({
        label: `cell ${slot} ${label}`,
        size: data.byteLength,
        usage: usage | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(buffer, 0, data)
      return buffer
    }
    const stored: StoredCell = {
      position: upload(cell.positions, GPUBufferUsage.VERTEX, 'position'),
      normal: upload(cell.normals, GPUBufferUsage.VERTEX, 'normal'),
      color: upload(cell.colors, GPUBufferUsage.VERTEX, 'color'),
      index: upload(cell.indices, GPUBufferUsage.INDEX, 'index'),
      indexCount: cell.indices.length,
      bytes:
        cell.positions.byteLength +
        cell.normals.byteLength +
        cell.colors.byteLength +
        cell.indices.byteLength,
    }
    this.slots[slot] = stored
    this.totalBytes += stored.bytes

    const [x0, y0, z0, x1, y1, z1] = cell.box
    this.boxCpu.set([x0, y0, z0, 0, x1, y1, z1, 0], slot * 8)
    device.queue.writeBuffer(this.boxes, slot * 32, this.boxCpu, slot * 8, 8)
    device.queue.writeBuffer(
      this.args,
      slot * ARGS_BYTES,
      new Uint32Array([stored.indexCount, 0, 0, 0, 0]),
    )
    this.selectedCpu[slot] = 0
    this.dirty = true
    return slot
  }

  removeCell(slot: number): void {
    const stored = this.slots[slot]
    if (!stored) return
    stored.position.destroy()
    stored.normal.destroy()
    stored.color.destroy()
    stored.index.destroy()
    this.totalBytes -= stored.bytes
    this.slots[slot] = null
    this.free.push(slot)
    // indexCount 0 makes the compute shader skip the slot until it is reused.
    this.device.queue.writeBuffer(this.args, slot * ARGS_BYTES, new Uint32Array(ARGS_U32))
    this.selectedCpu[slot] = 0
    this.dirty = true
  }

  setSelected(slot: number, selected: boolean): void {
    const value = selected ? 1 : 0
    if (this.selectedCpu[slot] === value) return
    this.selectedCpu[slot] = value
    this.dirty = true
  }

  /** Sends the selection flags to the GPU; call once per frame before culling. */
  flush(): void {
    if (!this.dirty) return
    this.device.queue.writeBuffer(
      this.selectedBuffer,
      0,
      this.selectedCpu,
      0,
      Math.max(1, this.used),
    )
    this.dirty = false
  }
}
