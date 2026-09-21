import type * as THREE from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type { TilesRenderer } from '3d-tiles-renderer'

// Ring buffer length for frame-time percentiles (~10 s at 60 FPS).
const FRAME_WINDOW = 600
// Window used for the "current" FPS average.
const FPS_WINDOW_MS = 1000
// Scene traversal is O(meshes), so it is sampled instead of run every frame.
const SCENE_SAMPLE_MS = 250
// Smoothing factor for CPU timings.
const EMA_ALPHA = 0.1

export interface PerfSnapshot {
  // Frame timing
  fps: number
  frameMs: number
  worstFrameMs: number
  fps1Low: number
  fps01Low: number
  // CPU timing per frame (ms, smoothed)
  updateMs: number
  renderMs: number
  minimapMs: number
  // Main camera pass
  drawCalls: number
  triangles: number
  lines: number
  points: number
  // Minimap pass (extra cost of the top view)
  minimapDrawCalls: number
  minimapTriangles: number
  // Scene contents (sampled)
  loadedMeshes: number
  loadedTriangles: number
  candidateMeshes: number
  candidateTriangles: number
  culledTrianglesPct: number
  // Tiles
  tilesVisible: number
  tilesActive: number
  tilesInFrustum: number
  tilesUsed: number
  tilesCached: number
  tilesDownloading: number
  tilesParsing: number
  tilesQueued: number
  tilesFailed: number
  loadProgress: number
  // Memory
  gpuTotalBytes: number
  gpuTexturesBytes: number
  gpuGeometryBytes: number
  geometries: number
  textures: number
  programs: number
  tileCacheBytes: number
  jsHeapBytes: number | null
}

export const createEmptySnapshot = (): PerfSnapshot => ({
  fps: 0,
  frameMs: 0,
  worstFrameMs: 0,
  fps1Low: 0,
  fps01Low: 0,
  updateMs: 0,
  renderMs: 0,
  minimapMs: 0,
  drawCalls: 0,
  triangles: 0,
  lines: 0,
  points: 0,
  minimapDrawCalls: 0,
  minimapTriangles: 0,
  loadedMeshes: 0,
  loadedTriangles: 0,
  candidateMeshes: 0,
  candidateTriangles: 0,
  culledTrianglesPct: 0,
  tilesVisible: 0,
  tilesActive: 0,
  tilesInFrustum: 0,
  tilesUsed: 0,
  tilesCached: 0,
  tilesDownloading: 0,
  tilesParsing: 0,
  tilesQueued: 0,
  tilesFailed: 0,
  loadProgress: 0,
  gpuTotalBytes: 0,
  gpuTexturesBytes: 0,
  gpuGeometryBytes: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  tileCacheBytes: 0,
  jsHeapBytes: null,
})

interface PassStats {
  drawCalls: number
  triangles: number
  lines: number
  points: number
}

const meshTriangles = (mesh: THREE.Mesh): number => {
  const geometry = mesh.geometry
  const count = geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0)
  return count / 3
}

/**
 * Collects frame timing, renderer counters, scene contents and memory usage.
 *
 * Usage per frame:
 *   perf.beginFrame(); ...update...; perf.markUpdateDone(); ...render main...;
 *   perf.markMainDone(); ...render minimap...; perf.endFrame(tiles).
 */
export class PerformanceMonitor {
  readonly snapshot: PerfSnapshot = createEmptySnapshot()

  private readonly frameTimes = new Float32Array(FRAME_WINDOW)
  private frameCount = 0
  private frameHead = 0
  private lastFrameStart = 0

  private frameStart = 0
  private updateDone = 0
  private mainDone = 0
  private mainPass: PassStats = { drawCalls: 0, triangles: 0, lines: 0, points: 0 }

  private lastPublish = 0
  private scenePass = { loadedMeshes: 0, loadedTriangles: 0, candidateMeshes: 0, candidateTriangles: 0 }

  private readonly renderer: WebGPURenderer
  private readonly root: () => THREE.Object3D

  constructor(renderer: WebGPURenderer, root: () => THREE.Object3D) {
    this.renderer = renderer
    this.root = root
    // The renderer is driven from our own rAF loop and renders twice per frame
    // (main + minimap), so counters must be reset manually to be meaningful.
    renderer.info.autoReset = false
  }

  beginFrame(): void {
    const now = performance.now()
    if (this.lastFrameStart > 0) {
      const dt = now - this.lastFrameStart
      this.frameTimes[this.frameHead] = dt
      this.frameHead = (this.frameHead + 1) % FRAME_WINDOW
      this.frameCount = Math.min(this.frameCount + 1, FRAME_WINDOW)
      this.snapshot.frameMs = dt
    }
    this.lastFrameStart = now
    this.frameStart = now
    this.renderer.info.reset()
  }

  markUpdateDone(): void {
    this.updateDone = performance.now()
  }

  /** Call right after the main camera render; captures its counters before the minimap pass adds to them. */
  markMainDone(): void {
    this.mainDone = performance.now()
    const r = this.renderer.info.render
    this.mainPass = { drawCalls: r.drawCalls, triangles: r.triangles, lines: r.lines, points: r.points }
  }

  endFrame(tiles: TilesRenderer, minimapRendered: boolean): void {
    const now = performance.now()
    const s = this.snapshot
    const r = this.renderer.info.render

    const smooth = (prev: number, next: number) => (prev === 0 ? next : prev + (next - prev) * EMA_ALPHA)
    s.updateMs = smooth(s.updateMs, this.updateDone - this.frameStart)
    s.renderMs = smooth(s.renderMs, this.mainDone - this.updateDone)
    s.minimapMs = minimapRendered ? smooth(s.minimapMs, now - this.mainDone) : 0

    s.drawCalls = this.mainPass.drawCalls
    s.triangles = this.mainPass.triangles
    s.lines = this.mainPass.lines
    s.points = this.mainPass.points
    s.minimapDrawCalls = minimapRendered ? r.drawCalls - this.mainPass.drawCalls : 0
    s.minimapTriangles = minimapRendered ? r.triangles - this.mainPass.triangles : 0

    if (now - this.lastPublish >= SCENE_SAMPLE_MS) {
      this.lastPublish = now
      this.computeFrameStats()
      this.sampleScene()
      this.sampleTiles(tiles)
      this.sampleMemory(tiles)
    }
  }

  private computeFrameStats(): void {
    const n = this.frameCount
    if (n === 0) return
    const s = this.snapshot

    // Average over the most recent FPS_WINDOW_MS.
    let sum = 0
    let used = 0
    for (let i = 0; i < n && sum < FPS_WINDOW_MS; i++) {
      sum += this.frameTimes[(this.frameHead - 1 - i + FRAME_WINDOW) % FRAME_WINDOW]
      used++
    }
    s.fps = sum > 0 ? (used * 1000) / sum : 0

    // Percentile lows over the full window: FPS of the average of the worst N% frames.
    const sorted = Array.from(this.frameTimes.subarray(0, n)).sort((a, b) => b - a)
    const lowFps = (fraction: number) => {
      const count = Math.max(1, Math.ceil(n * fraction))
      let total = 0
      for (let i = 0; i < count; i++) total += sorted[i]
      return total > 0 ? (count * 1000) / total : 0
    }
    s.worstFrameMs = sorted[0]
    s.fps1Low = lowFps(0.01)
    s.fps01Low = lowFps(0.001)
  }

  /**
   * Walks the tiles group once, counting everything that is loaded versus what is
   * still visible in the scene graph (i.e. what three.js will try to draw before its
   * own per-object frustum culling). Comparing this to the rendered triangles gives
   * the effect of frustum culling.
   */
  private sampleScene(): void {
    const p = this.scenePass
    p.loadedMeshes = p.loadedTriangles = p.candidateMeshes = p.candidateTriangles = 0

    const stack: { object: THREE.Object3D; visible: boolean }[] = [{ object: this.root(), visible: true }]
    while (stack.length > 0) {
      const { object, visible: parentVisible } = stack.pop()!
      const visible = parentVisible && object.visible
      if ((object as THREE.Mesh).isMesh) {
        const mesh = object as THREE.Mesh
        const triangles = meshTriangles(mesh)
        p.loadedMeshes++
        p.loadedTriangles += triangles
        if (visible) {
          p.candidateMeshes++
          p.candidateTriangles += triangles
        }
      }
      for (const child of object.children) stack.push({ object: child, visible })
    }

    const s = this.snapshot
    s.loadedMeshes = p.loadedMeshes
    s.loadedTriangles = p.loadedTriangles
    s.candidateMeshes = p.candidateMeshes
    s.candidateTriangles = p.candidateTriangles
    s.culledTrianglesPct =
      p.candidateTriangles > 0
        ? Math.max(0, 1 - this.mainPass.triangles / p.candidateTriangles) * 100
        : 0
  }

  private sampleTiles(tiles: TilesRenderer): void {
    const s = this.snapshot
    // `stats` exists at runtime but is missing from the TilesRenderer typings.
    const t = (tiles as unknown as { stats: Record<string, number | undefined> }).stats
    s.tilesVisible = tiles.visibleTiles.size
    s.tilesActive = tiles.activeTiles.size
    s.tilesInFrustum = t.inFrustum ?? 0
    s.tilesUsed = t.used ?? 0
    s.tilesDownloading = t.downloading ?? 0
    s.tilesParsing = t.parsing ?? 0
    s.tilesQueued = t.queued ?? 0
    s.tilesFailed = t.failed ?? 0
    s.loadProgress = Math.round(tiles.loadProgress * 100)
  }

  private sampleMemory(tiles: TilesRenderer): void {
    const s = this.snapshot
    const m = this.renderer.info.memory
    s.gpuTotalBytes = m.total
    s.gpuTexturesBytes = m.texturesSize
    s.gpuGeometryBytes = m.attributesSize + m.indexAttributesSize
    s.geometries = m.geometries
    s.textures = m.textures
    s.programs = m.programs
    // cachedBytes / itemSet exist at runtime but are missing from the LRUCache typings.
    const cache = tiles.lruCache as unknown as { cachedBytes: number; itemSet: Map<unknown, unknown> }
    s.tileCacheBytes = cache.cachedBytes
    s.tilesCached = cache.itemSet.size

    // Chromium-only, non-standard.
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    s.jsHeapBytes = mem ? mem.usedJSHeapSize : null
  }
}
