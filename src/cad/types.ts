export type Vec3Tuple = [number, number, number]

export interface CadMetadata {
  version: string
  type: 'envmesh'
  name: string
  boundingBox: { min: Vec3Tuple; max: Vec3Tuple }
  coreBoundingBox?: { min: Vec3Tuple; max: Vec3Tuple }
  hierarchy: { firstChunkSize: number; stepSize: number; recordSize?: number }
  geometry: { url: string; format: string }
  bufferZones?: { url: string; format: string; name: string; triangleRatio?: number }[]
  triangleCount: number
  nodeCount: number
}

/** raw = geometry.bin, lod1 = geometry_lod.bin, lod2 = geometry_lod2.bin */
export type GeometryTier = 'raw' | 'lod1' | 'lod2'

/** A cell chunk decoded to typed arrays (no three.js types, so it can cross a worker boundary). */
export interface DecodedCell {
  positions: Float32Array
  /** Signed normalized, 4 bytes per vertex (the 4th is padding). */
  normals: Int8Array
  /** Unsigned normalized RGBA, 4 bytes per vertex. */
  colors: Uint8Array
  indices: Uint32Array
  /** min x, y, z, max x, y, z of the vertices. */
  box: [number, number, number, number, number, number]
}

export interface CadLoadProgress {
  phase: 'metadata' | 'hierarchy' | 'ready'
  loaded: number
  total: number
}

export interface CadStats {
  datasetTriangles: number
  datasetCells: number
  selectedCells: number
  selectedTriangles: number
  residentCells: number
  residentTriangles: number
  residentBytes: number
  cellsRaw: number
  cellsLod1: number
  cellsLod2: number
  pendingLoads: number
  failedLoads: number
  visitedCells: number
}

export interface CadSettings {
  triangleBudget: number
  /** Cells projecting to fewer pixels than this are not descended into. */
  minScreenPixels: number
  /** Below this projected size a cell is drawn with the lod2 tier. */
  lod2BelowPixels: number
  /** Below this projected size (and above lod2's) a cell is drawn with the lod1 tier. */
  lod1BelowPixels: number
  maxResidentMB: number
  frozen: boolean
}
