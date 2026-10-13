import * as THREE from 'three'
import type { CadSettings, CadStats } from '../cad/types'
import { CULLING_MODES, cullingConfig } from '../cad/cullingHooks'
import type { PerformanceMonitor } from '../performance'
import { createBenchmarkPath, type BenchmarkPath } from './cameraPath'
import { benchmarkStorage } from './storage'
import type {
  BenchmarkBin,
  BenchmarkOptions,
  BenchmarkRun,
  BenchmarkState,
  BenchmarkSummary,
  FrameSample,
  LiveStats,
  SystemInfo,
} from './types'

const BIN_COUNT = 240
/** The warm-up lap is flown this much faster than the recorded one. */
const WARMUP_SPEEDUP = 3
const MIN_WARMUP_SEC = 8
const SETTLE_STABLE_SEC = 1
const SETTLE_MAX_SEC = 10
/** A hitch longer than this must not teleport the camera along the path. */
const MAX_STEP_SEC = 0.25
const SKIP_FRAMES_AFTER_START = 2
const NOTIFY_MS = 100
const MB = 2 ** 20

export interface BenchmarkDeps {
  camera: THREE.PerspectiveCamera
  perf: PerformanceMonitor
  cadSettings: CadSettings
  cadStats: CadStats
  /** Null until the model has loaded. */
  getModel: () => { name: string; bounds: THREE.Box3 } | null
  getSystem: () => SystemInfo
}

const emptyLive = (): LiveStats => ({
  fps: 0,
  frameMs: 0,
  gpuMs: null,
  triangles: 0,
  drawCalls: 0,
  selectedCells: 0,
  pendingLoads: 0,
})

const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length)

const percentile = (sortedAscending: number[], fraction: number) =>
  sortedAscending.length === 0 ? 0 : sortedAscending[Math.floor(fraction * (sortedAscending.length - 1))]

/** FPS of the average of the worst `fraction` of frames. */
const lowFps = (sortedDescending: number[], fraction: number) => {
  const count = Math.max(1, Math.ceil(sortedDescending.length * fraction))
  let total = 0
  for (let i = 0; i < count; i++) total += sortedDescending[i]
  return total > 0 ? (count * 1000) / total : 0
}

export class BenchmarkRunner {
  private current: BenchmarkState = {
    phase: 'idle',
    options: null,
    progress: 0,
    elapsed: 0,
    live: emptyLive(),
    result: null,
    notice: '',
  }
  private readonly listeners = new Set<() => void>()
  private readonly deps: BenchmarkDeps

  private path: BenchmarkPath | null = null
  private options: BenchmarkOptions | null = null
  private phaseTime = 0
  private stableTime = 0
  private skipFrames = 0
  private samples: { t: number; sample: FrameSample }[] = []
  private lastNotify = 0
  private savedPosition = new THREE.Vector3()
  private savedQuaternion = new THREE.Quaternion()
  private readonly scratchPosition = new THREE.Vector3()
  private readonly scratchTarget = new THREE.Vector3()

  constructor(deps: BenchmarkDeps) {
    this.deps = deps
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): BenchmarkState => this.current

  /** True while the runner owns the camera. */
  get active(): boolean {
    const { phase } = this.current
    return phase === 'warmup' || phase === 'settle' || phase === 'running'
  }

  start(options: BenchmarkOptions): boolean {
    const model = this.deps.getModel()
    if (!model) {
      this.set({ notice: 'The model is still loading.' })
      return false
    }
    if (this.active) return false

    const { camera, cadSettings } = this.deps
    this.savedPosition.copy(camera.position)
    this.savedQuaternion.copy(camera.quaternion)
    this.path = createBenchmarkPath(model.bounds)
    this.options = options
    cullingConfig.mode = options.scenario
    cadSettings.frozen = false
    this.samples = []
    this.phaseTime = 0
    this.stableTime = 0
    this.enter(options.warmup ? 'warmup' : 'settle', { options, result: null, notice: '', elapsed: 0 })
    return true
  }

  cancel(): void {
    if (!this.active) return
    this.restoreCamera()
    this.samples = []
    this.enter('idle', { notice: 'Benchmark cancelled.', result: null, elapsed: 0 })
  }

  /** Called once per frame before rendering; moves the camera while a benchmark runs. */
  update(deltaSec: number): void {
    if (!this.active || !this.path || !this.options) return
    const step = Math.min(deltaSec, MAX_STEP_SEC)
    const { durationSec } = this.options
    this.phaseTime += step

    switch (this.current.phase) {
      case 'warmup': {
        const lap = Math.max(MIN_WARMUP_SEC, durationSec / WARMUP_SPEEDUP)
        this.pose(this.phaseTime / lap)
        if (this.phaseTime >= lap) this.enter('settle', {})
        else this.progress(this.phaseTime / lap)
        break
      }
      case 'settle': {
        this.pose(0)
        this.stableTime = this.deps.cadStats.pendingLoads === 0 ? this.stableTime + step : 0
        if (this.stableTime >= SETTLE_STABLE_SEC || this.phaseTime >= SETTLE_MAX_SEC) this.enter('running', { elapsed: 0 })
        else this.progress(Math.max(this.stableTime / SETTLE_STABLE_SEC, this.phaseTime / SETTLE_MAX_SEC))
        break
      }
      case 'running': {
        this.pose(this.phaseTime / durationSec)
        if (this.phaseTime >= durationSec) this.finish()
        else this.progress(this.phaseTime / durationSec, this.phaseTime)
        break
      }
    }
  }

  /** Called once per frame after rendering. */
  recordFrame(frameMs: number): void {
    const { perf, cadStats } = this.deps
    const snapshot = perf.snapshot
    const sample: FrameSample = {
      frameMs,
      gpuMs: perf.latest.gpuMs,
      updateMs: perf.latest.updateMs,
      renderMs: perf.latest.renderMs,
      triangles: snapshot.triangles,
      drawCalls: snapshot.drawCalls,
      selectedCells: cadStats.selectedCells,
      residentMB: cadStats.residentBytes / 2 / MB,
      pendingLoads: cadStats.pendingLoads,
    }
    this.current.live = {
      fps: snapshot.fps,
      frameMs,
      gpuMs: snapshot.gpuMs > 0 ? snapshot.gpuMs : null,
      triangles: sample.triangles,
      drawCalls: sample.drawCalls,
      selectedCells: sample.selectedCells,
      pendingLoads: sample.pendingLoads,
    }
    if (this.current.phase === 'running') {
      if (this.skipFrames > 0) this.skipFrames--
      else this.samples.push({ t: this.phaseTime, sample })
    }
    this.notify(false)
  }

  /** Keeps the finished run in the history. Returns an error message, or null when saved. */
  saveResult(label: string): string | null {
    const run = this.current.result
    if (!run) return null
    const error = benchmarkStorage.save({ ...run, label: label.trim() || run.label })
    if (error) return error
    this.set({ phase: 'idle', result: null, notice: 'Benchmark saved.' })
    return null
  }

  discardResult(): void {
    this.set({ phase: 'idle', result: null, notice: 'Benchmark discarded.' })
  }

  clearNotice(): void {
    if (this.current.notice) this.set({ notice: '' })
  }

  private pose(t: number): void {
    const { camera } = this.deps
    this.path!.sample(t, this.scratchPosition, this.scratchTarget)
    camera.position.copy(this.scratchPosition)
    camera.lookAt(this.scratchTarget)
  }

  private restoreCamera(): void {
    const { camera } = this.deps
    camera.position.copy(this.savedPosition)
    camera.quaternion.copy(this.savedQuaternion)
  }

  private enter(phase: BenchmarkState['phase'], patch: Partial<BenchmarkState>): void {
    this.phaseTime = 0
    this.stableTime = 0
    if (phase === 'running') {
      this.skipFrames = SKIP_FRAMES_AFTER_START
      this.samples = []
    }
    this.set({ phase, progress: 0, ...patch })
  }

  private progress(progress: number, elapsed?: number): void {
    this.current = { ...this.current, progress, elapsed: elapsed ?? this.current.elapsed }
    this.notify(false)
  }

  private set(patch: Partial<BenchmarkState>): void {
    this.current = { ...this.current, ...patch }
    this.notify(true)
  }

  private notify(force: boolean): void {
    const now = performance.now()
    if (!force && now - this.lastNotify < NOTIFY_MS) return
    this.lastNotify = now
    this.current = { ...this.current }
    for (const listener of this.listeners) listener()
  }

  private finish(): void {
    this.restoreCamera()
    const run = this.buildRun()
    this.samples = []
    if (!run) {
      this.enter('idle', { notice: 'No frames were recorded.', elapsed: 0 })
      return
    }
    this.enter('finished', { result: run, progress: 1 })
  }

  private buildRun(): BenchmarkRun | null {
    const { options } = this
    const { samples } = this
    const model = this.deps.getModel()
    if (!options || !model || samples.length < 2) return null

    const frameTimes = samples.map((s) => s.sample.frameMs)
    const ascending = [...frameTimes].sort((a, b) => a - b)
    const descending = [...ascending].reverse()
    const gpu = samples.map((s) => s.sample.gpuMs).filter((v): v is number => v !== null)
    const total = frameTimes.reduce((a, b) => a + b, 0)
    const col = (pick: (s: FrameSample) => number) => samples.map((s) => pick(s.sample))

    const summary: BenchmarkSummary = {
      frames: samples.length,
      seconds: total / 1000,
      avgFps: (samples.length * 1000) / total,
      fps1Low: lowFps(descending, 0.01),
      fps01Low: lowFps(descending, 0.001),
      avgFrameMs: total / samples.length,
      p50FrameMs: percentile(ascending, 0.5),
      p95FrameMs: percentile(ascending, 0.95),
      p99FrameMs: percentile(ascending, 0.99),
      maxFrameMs: ascending[ascending.length - 1],
      avgUpdateMs: mean(col((s) => s.updateMs)),
      avgRenderMs: mean(col((s) => s.renderMs)),
      avgGpuMs: gpu.length > 0 ? mean(gpu) : null,
      avgTriangles: mean(col((s) => s.triangles)),
      avgDrawCalls: mean(col((s) => s.drawCalls)),
      avgSelectedCells: mean(col((s) => s.selectedCells)),
      peakResidentMB: Math.max(...col((s) => s.residentMB)),
      maxPendingLoads: Math.max(...col((s) => s.pendingLoads)),
    }

    const scenarioLabel = CULLING_MODES.find((m) => m.id === options.scenario)?.label ?? options.scenario
    const createdAt = Date.now()
    return {
      id: `${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt,
      label: `${scenarioLabel} ${new Date(createdAt).toLocaleString()}`,
      scenario: options.scenario,
      durationSec: options.durationSec,
      warmup: options.warmup,
      system: this.deps.getSystem(),
      model: {
        name: model.name,
        triangles: this.deps.cadStats.datasetTriangles,
        cells: this.deps.cadStats.datasetCells,
      },
      settings: { ...this.deps.cadSettings },
      summary,
      bins: this.bin(options.durationSec),
    }
  }

  /** Averages the frames into fixed time slices, so a run is a few KB however long it was or fast it ran. */
  private bin(durationSec: number): BenchmarkBin[] {
    type Acc = { n: number; gpuN: number; bin: BenchmarkBin }
    const accs: Acc[] = Array.from({ length: BIN_COUNT }, () => ({
      n: 0,
      gpuN: 0,
      bin: {
        frameMs: 0,
        frameMsMax: 0,
        gpuMs: 0,
        updateMs: 0,
        renderMs: 0,
        triangles: 0,
        drawCalls: 0,
        selectedCells: 0,
        residentMB: 0,
        pendingLoads: 0,
      },
    }))

    for (const { t, sample } of this.samples) {
      const acc = accs[Math.min(BIN_COUNT - 1, Math.floor((t / durationSec) * BIN_COUNT))]
      const b = acc.bin
      acc.n++
      b.frameMs += sample.frameMs
      b.frameMsMax = Math.max(b.frameMsMax, sample.frameMs)
      if (sample.gpuMs !== null) {
        b.gpuMs = (b.gpuMs ?? 0) + sample.gpuMs
        acc.gpuN++
      }
      b.updateMs += sample.updateMs
      b.renderMs += sample.renderMs
      b.triangles += sample.triangles
      b.drawCalls += sample.drawCalls
      b.selectedCells += sample.selectedCells
      b.residentMB = Math.max(b.residentMB, sample.residentMB)
      b.pendingLoads = Math.max(b.pendingLoads, sample.pendingLoads)
    }

    // A bin that caught no frame (a long hitch) repeats the previous one, so charts stay continuous.
    const bins: BenchmarkBin[] = []
    for (const { n, gpuN, bin } of accs) {
      if (n === 0) {
        bins.push(bins.length > 0 ? { ...bins[bins.length - 1] } : { ...bin })
        continue
      }
      const round = (v: number) => Math.round(v * 100) / 100
      bins.push({
        frameMs: round(bin.frameMs / n),
        frameMsMax: round(bin.frameMsMax),
        gpuMs: gpuN > 0 ? round((bin.gpuMs ?? 0) / gpuN) : null,
        updateMs: round(bin.updateMs / n),
        renderMs: round(bin.renderMs / n),
        triangles: Math.round(bin.triangles / n),
        drawCalls: Math.round(bin.drawCalls / n),
        selectedCells: Math.round(bin.selectedCells / n),
        residentMB: Math.round(bin.residentMB),
        pendingLoads: bin.pendingLoads,
      })
    }
    return bins
  }
}
