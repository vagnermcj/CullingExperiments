import * as THREE from 'three'
import { CellDecodePool } from './cellDecodePool'
import { beginFrame, isCellVisible } from './cullingHooks'
import { Hierarchy, type TierRange } from './hierarchy'
import type { CadLoadProgress, CadMetadata, CadSettings, CadStats, DecodedCell, GeometryTier } from './types'

const MAX_CONCURRENT_FETCHES = 6
const ABANDON_MS = 2000
const SWEEP_MS = 250
const RETRY_BASE_MS = 750
const RETRY_MAX_MS = 30_000
const MB = 2 ** 20

const TIER_RANK: Record<GeometryTier, number> = { raw: 0, lod1: 1, lod2: 2 }

export const createDefaultSettings = (): CadSettings => ({
  triangleBudget: 3_000_000,
  minScreenPixels: 5,
  lod2BelowPixels: 25,
  lod1BelowPixels: 80,
  maxResidentMB: 1500,
  frozen: false,
})

export const createEmptyStats = (): CadStats => ({
  datasetTriangles: 0,
  datasetCells: 0,
  selectedCells: 0,
  selectedTriangles: 0,
  residentCells: 0,
  residentTriangles: 0,
  residentBytes: 0,
  cellsRaw: 0,
  cellsLod1: 0,
  cellsLod2: 0,
  pendingLoads: 0,
  failedLoads: 0,
  visitedCells: 0,
})

interface CellState {
  index: number
  hasGeometry: boolean
  mesh: THREE.Mesh | null
  tier: GeometryTier | null
  triangles: number
  bytes: number
  loading: GeometryTier | null
  abort: AbortController | null
  failures: number
  retryAt: number
  selectedFrame: number
  selectedAt: number
  priority: number
  wanted: GeometryTier
}

interface FetchJob {
  state: CellState
  tier: GeometryTier
  offset: number
  size: number
  signal: AbortSignal
}

/** Binary max-heap of (cell index, key). */
class MaxHeap {
  private items: number[] = []
  private keys: number[] = []

  get size(): number {
    return this.items.length
  }

  clear(): void {
    this.items.length = 0
    this.keys.length = 0
  }

  push(item: number, key: number): void {
    let i = this.items.length
    this.items.push(item)
    this.keys.push(key)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.keys[parent] >= key) break
      this.items[i] = this.items[parent]
      this.keys[i] = this.keys[parent]
      i = parent
    }
    this.items[i] = item
    this.keys[i] = key
  }

  peekKey(): number {
    return this.keys[0]
  }

  pop(): number {
    const top = this.items[0]
    const item = this.items.pop()!
    const key = this.keys.pop()!
    const n = this.items.length
    if (n > 0) {
      let i = 0
      for (;;) {
        let child = 2 * i + 1
        if (child >= n) break
        if (child + 1 < n && this.keys[child + 1] > this.keys[child]) child++
        if (this.keys[child] <= key) break
        this.items[i] = this.items[child]
        this.keys[i] = this.keys[child]
        i = child
      }
      this.items[i] = item
      this.keys[i] = key
    }
    return top
  }
}

const median3 = (x: number, y: number, z: number) =>
  x <= y ? (y <= z ? y : x <= z ? z : x) : x <= z ? x : y <= z ? z : y

const fetchRange = async (url: string, offset: number, size: number, signal: AbortSignal): Promise<ArrayBuffer> => {
  const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + size - 1}` }, signal })
  // A server that ignores Range answers 200 with the whole multi-GB file; refuse it.
  if (res.status !== 206) {
    void res.body?.cancel()
    throw new Error(`${url}: expected 206 Partial Content, got ${res.status}`)
  }
  return res.arrayBuffer()
}

const fetchWithProgress = async (
  url: string,
  expectedBytes: number,
  onProgress: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> => {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`)
  let buffer = new Uint8Array(expectedBytes > 0 ? expectedBytes : Number(res.headers.get('content-length')) || 1 << 20)
  let loaded = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (loaded + value.length > buffer.length) {
      const grown = new Uint8Array(Math.max(buffer.length * 1.5, loaded + value.length))
      grown.set(buffer.subarray(0, loaded))
      buffer = grown
    }
    buffer.set(value, loaded)
    loaded += value.length
    onProgress(loaded, expectedBytes || buffer.length)
  }
  return loaded === buffer.length ? buffer.buffer : buffer.buffer.slice(0, loaded)
}

const guessRecordSize = (totalBytes: number): number => {
  for (const size of [70, 58, 46]) if (totalBytes % size === 0) return size
  return 70
}

export class CadModel {
  readonly group = new THREE.Group()
  /** Mutated by the control panel; read every frame. */
  readonly settings: CadSettings
  readonly stats: CadStats
  readonly coreBounds: THREE.Box3
  readonly metadata: CadMetadata

  private readonly hierarchy: Hierarchy
  private readonly urls: Record<GeometryTier, string | null>
  private readonly tierRatio: Record<GeometryTier, number>
  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    metalness: 0.2,
    roughness: 0.7,
  })
  private readonly decoder = new CellDecodePool()
  private readonly states = new Map<number, CellState>()
  private readonly heap = new MaxHeap()
  private readonly scratchBox = new THREE.Box3()
  private readonly scratchCenter = new THREE.Vector3()
  private readonly scratchRange: TierRange = { offset: 0, size: 0 }

  private selected: CellState[] = []
  private drawn: CellState[] = []
  private pending: FetchJob[] = []
  private activeFetches = 0
  private failed = new Set<CellState>()
  private frame = 0
  private lastSweep = 0
  private residentBytes = 0
  private residentTriangles = 0
  private residentCells = 0

  constructor(metadata: CadMetadata, hierarchy: Hierarchy, baseUrl: string, settings: CadSettings, stats: CadStats) {
    this.metadata = metadata
    this.hierarchy = hierarchy
    this.settings = settings
    this.stats = stats
    const zone = (name: string) => metadata.bufferZones?.find((z) => z.name === name)
    this.urls = {
      raw: `${baseUrl}/${metadata.geometry.url}`,
      lod1: zone('lod') ? `${baseUrl}/${zone('lod')!.url}` : null,
      lod2: zone('lod2') ? `${baseUrl}/${zone('lod2')!.url}` : null,
    }
    this.tierRatio = { raw: 1, lod1: zone('lod')?.triangleRatio ?? 0.35, lod2: zone('lod2')?.triangleRatio ?? 0.12 }
    const core = metadata.coreBoundingBox ?? metadata.boundingBox
    this.coreBounds = new THREE.Box3(new THREE.Vector3(...core.min), new THREE.Vector3(...core.max))
    stats.datasetTriangles = metadata.triangleCount
    stats.datasetCells = hierarchy.count
  }

  /** Runs the HLOD selection and starts the loads it needs. Call once per frame, before rendering. */
  update(camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    if (!this.settings.frozen) this.select(camera, viewportHeight)
    this.sweepAbandoned()
    this.refreshStats()
  }

  dispose(): void {
    for (const state of this.states.values()) this.release(state)
    this.states.clear()
    this.pending.length = 0
    this.decoder.dispose()
    this.material.dispose()
  }

  private tierAvailable(index: number, tier: GeometryTier): boolean {
    return this.urls[tier] !== null && this.hierarchy.tierRange(index, tier, this.scratchRange).size > 0
  }

  /** The coarsest tier this cell ships that is no coarser than `preferred`; cells missing a tier use the next finer one. */
  private resolveTier(index: number, preferred: GeometryTier): GeometryTier {
    if (preferred === 'lod2' && this.tierAvailable(index, 'lod2')) return 'lod2'
    if (preferred !== 'raw' && this.tierAvailable(index, 'lod1')) return 'lod1'
    return 'raw'
  }

  /** Projected size in pixels: median half-extent of the box plus a proximity term, over distance. */
  private screenSize(index: number, camera: THREE.PerspectiveCamera, angular: number, proximity: number): number {
    const box = this.hierarchy.readBox(index, this.scratchBox)
    const sx = box.max.x - box.min.x
    const sy = box.max.y - box.min.y
    const sz = box.max.z - box.min.z
    const radius = median3(sx, sy, sz) * 0.5
    const distance = camera.position.distanceTo(box.getCenter(this.scratchCenter))
    if (distance < radius) return Infinity
    return (radius * angular + proximity) / distance
  }

  private tierForSize(size: number): GeometryTier {
    if (size < this.settings.lod2BelowPixels) return 'lod2'
    if (size < this.settings.lod1BelowPixels) return 'lod1'
    return 'raw'
  }

  private satisfies(state: CellState, wanted: GeometryTier): boolean {
    return state.mesh !== null && state.tier !== null && TIER_RANK[state.tier] <= TIER_RANK[wanted]
  }

  private getState(index: number): CellState {
    let state = this.states.get(index)
    if (!state) {
      state = {
        index,
        hasGeometry: this.hierarchy.tierRange(index, 'raw', this.scratchRange).size > 0,
        mesh: null,
        tier: null,
        triangles: 0,
        bytes: 0,
        loading: null,
        abort: null,
        failures: 0,
        retryAt: 0,
        selectedFrame: 0,
        selectedAt: 0,
        priority: 0,
        wanted: 'raw',
      }
      this.states.set(index, state)
    }
    return state
  }

  private select(camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    const frame = ++this.frame
    const now = performance.now()
    const { settings, hierarchy, heap } = this
    const angular = (viewportHeight * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)
    const proximity = viewportHeight * 0.25
    beginFrame(camera)

    const selected: CellState[] = []
    let used = 0
    let visited = 0
    heap.clear()
    heap.push(0, this.screenSize(0, camera, angular, proximity))

    // Best-first by projected size, so the budget goes to what is biggest on screen.
    while (heap.size > 0) {
      const size = heap.peekKey()
      const index = heap.pop()
      visited++
      if (size < settings.minScreenPixels) continue
      if (used >= settings.triangleBudget) break
      if (!isCellVisible(hierarchy.readBox(index, this.scratchBox))) continue

      const state = this.getState(index)
      const wanted = this.resolveTier(index, this.tierForSize(size))
      let cost = 0
      if (state.hasGeometry) {
        cost = this.satisfies(state, wanted)
          ? state.triangles
          : hierarchy.numTriangles(index) * this.tierRatio[wanted]
      }
      if (used + cost > settings.triangleBudget) continue

      used += cost
      state.selectedFrame = frame
      state.selectedAt = now
      state.priority = size
      state.wanted = wanted
      selected.push(state)

      const first = hierarchy.firstChild[index]
      if (first >= 0) {
        const mask = hierarchy.childMask(index)
        let k = 0
        for (let slot = 0; slot < 8; slot++) {
          if (!(mask & (1 << slot))) continue
          const child = first + k++
          heap.push(child, this.screenSize(child, camera, angular, proximity))
        }
      }
    }

    for (const state of this.drawn) {
      if (state.selectedFrame !== frame && state.mesh) state.mesh.visible = false
    }
    for (const state of selected) {
      if (state.mesh) state.mesh.visible = true
      if (state.hasGeometry && !this.satisfies(state, state.wanted)) this.requestLoad(state)
    }
    this.drawn = selected
    this.selected = selected
    this.stats.visitedCells = visited
    this.stats.selectedTriangles = used

    this.evictOverCap(frame)
  }

  private requestLoad(state: CellState): void {
    if (state.loading === state.wanted) return
    if (state.failures > 0 && performance.now() < state.retryAt) return
    if (this.residentBytes >= this.settings.maxResidentMB * MB) return
    if (state.loading) this.cancelLoad(state)

    const range = this.hierarchy.tierRange(state.index, state.wanted, { offset: 0, size: 0 })
    if (range.size === 0) return
    const abort = new AbortController()
    state.abort = abort
    state.loading = state.wanted
    this.pending.push({ state, tier: state.wanted, offset: range.offset, size: range.size, signal: abort.signal })
    this.pump()
  }

  private cancelLoad(state: CellState): void {
    state.abort?.abort()
    state.abort = null
    state.loading = null
    const queued = this.pending.findIndex((job) => job.state === state)
    if (queued >= 0) this.pending.splice(queued, 1)
  }

  private pump(): void {
    while (this.activeFetches < MAX_CONCURRENT_FETCHES && this.pending.length > 0) {
      let best = 0
      for (let i = 1; i < this.pending.length; i++) {
        if (this.pending[i].state.priority > this.pending[best].state.priority) best = i
      }
      const [job] = this.pending.splice(best, 1)
      void this.run(job)
    }
  }

  private async run(job: FetchJob): Promise<void> {
    const { state, tier, signal } = job
    this.activeFetches++
    try {
      const buf = await fetchRange(this.urls[tier]!, job.offset, job.size, signal)
      if (signal.aborted) return
      const cell = await this.decoder.decode(buf)
      if (signal.aborted) return
      this.install(state, tier, cell)
    } catch (error) {
      if (!signal.aborted) {
        state.failures++
        state.retryAt = performance.now() + Math.min(RETRY_BASE_MS * 2 ** (state.failures - 1), RETRY_MAX_MS)
        this.failed.add(state)
        if (state.failures <= 2) console.warn(`[CadModel] cell ${state.index} (${tier}) failed:`, error)
      }
    } finally {
      this.activeFetches--
      if (state.loading === tier && state.abort?.signal === signal) {
        state.loading = null
        state.abort = null
      }
      this.pump()
    }
  }

  private install(state: CellState, tier: GeometryTier, cell: DecodedCell): void {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(cell.positions, 3))
    // 4-byte normals/colors: WebGPU has no 3-component 8-bit vertex formats.
    geometry.setAttribute('normal', new THREE.BufferAttribute(cell.normals, 4, true))
    geometry.setAttribute('color', new THREE.BufferAttribute(cell.colors, 4, true))
    geometry.setIndex(new THREE.BufferAttribute(cell.indices, 1))
    const [x0, y0, z0, x1, y1, z1] = cell.box
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1))
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere())

    const mesh = new THREE.Mesh(geometry, this.material)
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    mesh.visible = state.selectedFrame === this.frame

    this.release(state)
    state.mesh = mesh
    state.tier = tier
    state.triangles = cell.indices.length / 3
    state.bytes = (cell.positions.byteLength + cell.normals.byteLength + cell.colors.byteLength + cell.indices.byteLength) * 2
    state.failures = 0
    state.retryAt = 0
    this.failed.delete(state)
    this.group.add(mesh)
    this.residentBytes += state.bytes
    this.residentTriangles += state.triangles
    this.residentCells++
  }

  /** Removes the cell's resident mesh, if any. */
  private release(state: CellState): void {
    this.cancelLoad(state)
    if (!state.mesh) return
    this.group.remove(state.mesh)
    state.mesh.geometry.dispose()
    this.residentBytes -= state.bytes
    this.residentTriangles -= state.triangles
    this.residentCells--
    state.mesh = null
    state.tier = null
    state.triangles = 0
    state.bytes = 0
  }

  /** Over the resident cap, drop the cells not selected for the longest time. */
  private evictOverCap(frame: number): void {
    const cap = this.settings.maxResidentMB * MB
    if (this.residentBytes <= cap) return
    const candidates: CellState[] = []
    for (const state of this.states.values()) if (state.mesh && state.selectedFrame !== frame) candidates.push(state)
    candidates.sort((a, b) => a.selectedFrame - b.selectedFrame)
    for (const state of candidates) {
      if (this.residentBytes <= cap) break
      this.release(state)
      this.failed.delete(state)
      this.states.delete(state.index)
    }
  }

  /** In-flight and queued loads for cells the traversal stopped asking for are cancelled. */
  private sweepAbandoned(): void {
    const now = performance.now()
    if (now - this.lastSweep < SWEEP_MS) return
    this.lastSweep = now
    for (const state of this.states.values()) {
      if (state.loading && now - state.selectedAt > ABANDON_MS) this.cancelLoad(state)
    }
  }

  private refreshStats(): void {
    const s = this.stats
    let raw = 0
    let lod1 = 0
    let lod2 = 0
    for (const state of this.selected) {
      if (!state.mesh) continue
      if (state.tier === 'raw') raw++
      else if (state.tier === 'lod1') lod1++
      else lod2++
    }
    s.selectedCells = this.selected.length
    s.residentCells = this.residentCells
    s.residentTriangles = this.residentTriangles
    s.residentBytes = this.residentBytes
    s.cellsRaw = raw
    s.cellsLod1 = lod1
    s.cellsLod2 = lod2
    s.pendingLoads = this.pending.length + this.activeFetches
    s.failedLoads = this.failed.size
  }
}

export const loadCadModel = async (
  baseUrl: string,
  settings: CadSettings,
  stats: CadStats,
  onProgress: (progress: CadLoadProgress) => void,
): Promise<CadModel> => {
  onProgress({ phase: 'metadata', loaded: 0, total: 0 })
  const res = await fetch(`${baseUrl}/metadata.json`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`CAD dataset not found: ${baseUrl}/metadata.json (HTTP ${res.status})`)
  const metadata = (await res.json()) as CadMetadata
  if (metadata.geometry?.format !== 'cell-chunks-v2.2-quantized') {
    throw new Error(`Unsupported geometry format: ${metadata.geometry?.format}`)
  }

  const expected = metadata.hierarchy.recordSize ? metadata.nodeCount * metadata.hierarchy.recordSize : 0
  const buffer = await fetchWithProgress(`${baseUrl}/hierarchy.bin`, expected, (loaded, total) =>
    onProgress({ phase: 'hierarchy', loaded, total }),
  )
  const hierarchy = new Hierarchy(buffer, metadata.hierarchy.recordSize ?? guessRecordSize(buffer.byteLength))

  onProgress({ phase: 'ready', loaded: 1, total: 1 })
  return new CadModel(metadata, hierarchy, baseUrl, settings, stats)
}
