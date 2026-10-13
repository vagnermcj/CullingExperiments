import type { CadSettings } from '../cad/types'
import type { CullingMode } from '../cad/cullingHooks'

export interface BenchmarkOptions {
  scenario: CullingMode
  durationSec: number
  /** Fly one fast lap first so the recorded lap measures rendering, not streaming. */
  warmup: boolean
}

/** One time slice of the run, averaged over the frames that fall in it. */
export interface BenchmarkBin {
  frameMs: number
  frameMsMax: number
  gpuMs: number | null
  updateMs: number
  renderMs: number
  triangles: number
  drawCalls: number
  selectedCells: number
  residentMB: number
  pendingLoads: number
}

export type BenchmarkMetric = keyof BenchmarkBin

export interface BenchmarkSummary {
  frames: number
  seconds: number
  avgFps: number
  fps1Low: number
  fps01Low: number
  avgFrameMs: number
  p50FrameMs: number
  p95FrameMs: number
  p99FrameMs: number
  maxFrameMs: number
  avgUpdateMs: number
  avgRenderMs: number
  avgGpuMs: number | null
  avgTriangles: number
  avgDrawCalls: number
  avgSelectedCells: number
  peakResidentMB: number
  maxPendingLoads: number
}

export interface SystemInfo {
  gpu: string
  userAgent: string
  resolution: [number, number]
  pixelRatio: number
  gpuTiming: boolean
}

export interface BenchmarkRun {
  id: string
  createdAt: number
  label: string
  scenario: CullingMode
  durationSec: number
  warmup: boolean
  system: SystemInfo
  model: { name: string; triangles: number; cells: number }
  settings: CadSettings
  summary: BenchmarkSummary
  bins: BenchmarkBin[]
}

/** Raw numbers for one rendered frame. */
export interface FrameSample {
  frameMs: number
  gpuMs: number | null
  updateMs: number
  renderMs: number
  triangles: number
  drawCalls: number
  selectedCells: number
  residentMB: number
  pendingLoads: number
}

export type BenchmarkPhase = 'idle' | 'warmup' | 'settle' | 'running' | 'finished'

export interface LiveStats {
  fps: number
  frameMs: number
  gpuMs: number | null
  triangles: number
  drawCalls: number
  selectedCells: number
  pendingLoads: number
}

export interface BenchmarkState {
  phase: BenchmarkPhase
  options: BenchmarkOptions | null
  /** Progress through the current phase, 0..1. */
  progress: number
  elapsed: number
  live: LiveStats
  result: BenchmarkRun | null
  notice: string
}
