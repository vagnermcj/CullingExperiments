import type { GpuFrameStats } from './gpu/renderer'

// Ring buffer length for frame-time percentiles (~10 s at 60 FPS).
const FRAME_WINDOW = 600
// Window used for the "current" FPS average.
const FPS_WINDOW_MS = 1000
// Percentiles and memory counters are sampled instead of run every frame.
const SAMPLE_MS = 250
// Smoothing factor for CPU and GPU timings.
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
  // GPU time (ms, smoothed); 0 when timestamp queries are unsupported
  gpuMs: number
  cullGpuMs: number
  // Draws that survived culling, and what the culling decided (GPU counters, a frame or two late)
  drawCalls: number
  triangles: number
  selectedDraws: number
  issuedDraws: number
  // Memory
  gpuTotalBytes: number
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
  gpuMs: 0,
  cullGpuMs: 0,
  drawCalls: 0,
  triangles: 0,
  selectedDraws: 0,
  issuedDraws: 0,
  gpuTotalBytes: 0,
  jsHeapBytes: null,
})

export interface GpuStatsSource {
  readonly stats: GpuFrameStats
  readonly timestamps: boolean
}

/**
 * Collects frame timing, GPU counters and memory usage.
 *
 * Usage per frame:
 *   perf.beginFrame(); ...update...; perf.markUpdateDone(); ...render...; perf.markMainDone(); perf.endFrame().
 */
export class PerformanceMonitor {
  readonly snapshot: PerfSnapshot = createEmptySnapshot()
  /** Unsmoothed values of the last finished frame; GPU values lag by a frame or two (async readback) and are null without timestamp queries. */
  readonly latest: { updateMs: number; renderMs: number; gpuMs: number | null; cullMs: number | null } = {
    updateMs: 0,
    renderMs: 0,
    gpuMs: null,
    cullMs: null,
  }
  readonly gpuTiming: boolean

  private readonly frameTimes = new Float32Array(FRAME_WINDOW)
  private frameCount = 0
  private frameHead = 0
  private lastFrameStart = 0

  private frameStart = 0
  private updateDone = 0
  private mainDone = 0

  private lastPublish = 0

  private readonly source: GpuStatsSource

  constructor(source: GpuStatsSource) {
    this.source = source
    this.gpuTiming = source.timestamps
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
  }

  markUpdateDone(): void {
    this.updateDone = performance.now()
  }

  /** Call right after the render call has submitted its work. */
  markMainDone(): void {
    this.mainDone = performance.now()
  }

  endFrame(): void {
    const now = performance.now()
    const s = this.snapshot
    const g = this.source.stats

    const smooth = (prev: number, next: number) => (prev === 0 ? next : prev + (next - prev) * EMA_ALPHA)
    this.latest.updateMs = this.updateDone - this.frameStart
    this.latest.renderMs = this.mainDone - this.updateDone
    s.updateMs = smooth(s.updateMs, this.latest.updateMs)
    s.renderMs = smooth(s.renderMs, this.latest.renderMs)

    this.latest.gpuMs = g.gpuMs
    this.latest.cullMs = g.cullMs
    if (g.gpuMs !== null) s.gpuMs = smooth(s.gpuMs, g.gpuMs)
    if (g.cullMs !== null) s.cullGpuMs = smooth(s.cullGpuMs, g.cullMs)

    s.drawCalls = g.visibleDraws
    s.triangles = g.visibleTriangles
    s.selectedDraws = g.selectedDraws
    s.issuedDraws = g.issuedDraws
    s.gpuTotalBytes = g.gpuBytes

    if (now - this.lastPublish >= SAMPLE_MS) {
      this.lastPublish = now
      this.computeFrameStats()
      // Chromium-only, non-standard.
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      s.jsHeapBytes = mem ? mem.usedJSHeapSize : null
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
}
