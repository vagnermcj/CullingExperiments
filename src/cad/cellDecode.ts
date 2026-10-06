import { MeshoptDecoder } from 'meshoptimizer/decoder'
import type { DecodedCell } from './types'

const align4 = (offset: number) => offset + ((4 - (offset % 4)) % 4)

/** Five length-prefixed meshopt blocks starting at `offset`, each padded to 4 bytes. */
const readBlocks = (buf: ArrayBuffer, view: DataView, offset: number): Uint8Array[] => {
  const blocks: Uint8Array[] = []
  for (let k = 0; k < 5; k++) {
    const size = view.getUint32(offset, true)
    offset += 4
    blocks.push(new Uint8Array(buf, offset, size))
    offset = align4(offset + size)
  }
  return blocks
}

/**
 * cell-chunks-v2.2-quantized:
 *   [nVerts u32][nInds u32][bbox 6 x f32] then 5 meshopt blocks:
 *   positions u16 x4 (stride 8), normals i8 x4, colors u8 x4, featureIds u16 x2, indices u32.
 * Position: bmin + q / 65535 * (bmax - bmin). The feature-id block is skipped.
 *
 * `MeshoptDecoder.ready` must have settled before this is called.
 */
export const decodeCell = (buf: ArrayBuffer): DecodedCell => {
  const view = new DataView(buf)
  const nVerts = view.getUint32(0, true)
  const nInds = view.getUint32(4, true)
  const box: DecodedCell['box'] = [
    view.getFloat32(8, true),
    view.getFloat32(12, true),
    view.getFloat32(16, true),
    view.getFloat32(20, true),
    view.getFloat32(24, true),
    view.getFloat32(28, true),
  ]
  const [positionBlock, normalBlock, colorBlock, , indexBlock] = readBlocks(buf, view, 32)

  const quantized = new Uint8Array(nVerts * 8)
  MeshoptDecoder.decodeVertexBuffer(quantized, nVerts, 8, positionBlock)
  const q = new Uint16Array(quantized.buffer)
  const sx = (box[3] - box[0]) / 65535
  const sy = (box[4] - box[1]) / 65535
  const sz = (box[5] - box[2]) / 65535
  const positions = new Float32Array(nVerts * 3)
  for (let i = 0; i < nVerts; i++) {
    positions[i * 3] = box[0] + q[i * 4] * sx
    positions[i * 3 + 1] = box[1] + q[i * 4 + 1] * sy
    positions[i * 3 + 2] = box[2] + q[i * 4 + 2] * sz
  }

  const normalBytes = new Uint8Array(nVerts * 4)
  MeshoptDecoder.decodeVertexBuffer(normalBytes, nVerts, 4, normalBlock)
  const colors = new Uint8Array(nVerts * 4)
  MeshoptDecoder.decodeVertexBuffer(colors, nVerts, 4, colorBlock)
  const indexBytes = new Uint8Array(nInds * 4)
  MeshoptDecoder.decodeIndexBuffer(indexBytes, nInds, 4, indexBlock)

  return {
    positions,
    normals: new Int8Array(normalBytes.buffer),
    colors,
    indices: new Uint32Array(indexBytes.buffer),
    box,
  }
}

export const cellTransferList = (cell: DecodedCell): ArrayBuffer[] => [
  cell.positions.buffer as ArrayBuffer,
  cell.normals.buffer as ArrayBuffer,
  cell.colors.buffer as ArrayBuffer,
  cell.indices.buffer as ArrayBuffer,
]

export { MeshoptDecoder }
