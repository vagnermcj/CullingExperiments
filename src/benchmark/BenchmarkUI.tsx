import './benchmark.css'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { CULLING_MODES, cullingConfig, type CullingMode } from '../cad/cullingHooks'
import type { BenchmarkRunner } from './benchmarkRunner'
import { benchmarkStorage } from './storage'
import type { BenchmarkMetric, BenchmarkRun, BenchmarkSummary } from './types'

const DURATIONS = [30, 60, 120]
const SERIES_COLORS = ['#5ec8ff', '#ffb347', '#7be495', '#d58bff', '#ff7b8a', '#f2e05b']

const METRICS: { id: BenchmarkMetric; label: string }[] = [
  { id: 'frameMs', label: 'Frame time (ms)' },
  { id: 'gpuMs', label: 'GPU time (ms)' },
  { id: 'updateMs', label: 'CPU update (ms)' },
  { id: 'renderMs', label: 'CPU render (ms)' },
  { id: 'triangles', label: 'Triangles' },
  { id: 'drawCalls', label: 'Draw calls' },
  { id: 'selectedCells', label: 'Selected cells' },
  { id: 'residentMB', label: 'Resident (MB)' },
  { id: 'pendingLoads', label: 'Pending loads' },
]

const scenarioLabel = (mode: CullingMode) => CULLING_MODES.find((m) => m.id === mode)?.label ?? mode
const fixed = (n: number | null, digits = 1) => (n === null ? 'n/a' : n.toFixed(digits))
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : n.toFixed(0))

const SUMMARY_ROWS: { label: string; value: (s: BenchmarkSummary) => string }[] = [
  { label: 'Average FPS', value: (s) => fixed(s.avgFps) },
  { label: '1% low FPS', value: (s) => fixed(s.fps1Low) },
  { label: '0.1% low FPS', value: (s) => fixed(s.fps01Low) },
  { label: 'Frame time avg', value: (s) => `${fixed(s.avgFrameMs, 2)} ms` },
  { label: 'Frame time p95 / p99', value: (s) => `${fixed(s.p95FrameMs, 2)} / ${fixed(s.p99FrameMs, 2)} ms` },
  { label: 'Frame time max', value: (s) => `${fixed(s.maxFrameMs, 2)} ms` },
  { label: 'GPU time avg', value: (s) => (s.avgGpuMs === null ? 'n/a' : `${fixed(s.avgGpuMs, 2)} ms`) },
  { label: 'CPU update / render', value: (s) => `${fixed(s.avgUpdateMs, 2)} / ${fixed(s.avgRenderMs, 2)} ms` },
  { label: 'Triangles / draw calls', value: (s) => `${compact(s.avgTriangles)} / ${compact(s.avgDrawCalls)}` },
  { label: 'Selected cells', value: (s) => compact(s.avgSelectedCells) },
  { label: 'Peak resident', value: (s) => `${compact(s.peakResidentMB)} MB` },
  { label: 'Frames', value: (s) => `${s.frames} in ${fixed(s.seconds)} s` },
]

interface ChartSeries {
  label: string
  color: string
  values: (number | null)[]
  faint?: boolean
}

const Chart = ({ series, durationSec, unit }: { series: ChartSeries[]; durationSec: number; unit: string }) => {
  const W = 640
  const H = 190
  const pad = { l: 46, r: 10, t: 8, b: 22 }
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null)
  const max = Math.max(1e-6, ...all) * 1.08
  const x = (i: number, n: number) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b)

  const path = (values: (number | null)[]) => {
    let d = ''
    let pen = false
    values.forEach((v, i) => {
      if (v === null) {
        pen = false
        return
      }
      d += `${pen ? 'L' : 'M'}${x(i, values.length).toFixed(1)},${y(v).toFixed(1)}`
      pen = true
    })
    return d
  }

  return (
    <div className="bench-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Chart in ${unit}`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} className="bench-grid" />
            <text x={pad.l - 6} y={y(max * f) + 3} textAnchor="end" className="bench-axis">
              {compact(max * f)}
            </text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text key={f} x={pad.l + f * (W - pad.l - pad.r)} y={H - 6} textAnchor="middle" className="bench-axis">
            {`${(durationSec * f).toFixed(0)}s`}
          </text>
        ))}
        {series.map((s) => (
          <path
            key={s.label}
            d={path(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.faint ? 1 : 1.6}
            opacity={s.faint ? 0.4 : 1}
            strokeLinejoin="round"
          />
        ))}
      </svg>
      <div className="bench-legend">
        {series.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

const MetricSelect = ({ value, onChange }: { value: BenchmarkMetric; onChange: (m: BenchmarkMetric) => void }) => (
  <select value={value} onChange={(e) => onChange(e.target.value as BenchmarkMetric)}>
    {METRICS.map((m) => (
      <option key={m.id} value={m.id}>
        {m.label}
      </option>
    ))}
  </select>
)

const RunDetails = ({ run }: { run: BenchmarkRun }) => {
  const [metric, setMetric] = useState<BenchmarkMetric>('frameMs')
  const series: ChartSeries[] = [{ label: METRICS.find((m) => m.id === metric)!.label, color: SERIES_COLORS[0], values: run.bins.map((b) => b[metric]) }]
  if (metric === 'frameMs') series.push({ label: 'worst frame in slice', color: SERIES_COLORS[1], values: run.bins.map((b) => b.frameMsMax), faint: true })
  const s = run.summary

  return (
    <>
      <div className="bench-meta">
        <span className={`bench-badge scenario-${run.scenario.replace('+', '-')}`}>{scenarioLabel(run.scenario)}</span>
        <span>{new Date(run.createdAt).toLocaleString()}</span>
        <span>{run.system.gpu}</span>
        <span>
          {run.system.resolution[0]}x{run.system.resolution[1]} @{run.system.pixelRatio}x
        </span>
        <span>
          {run.durationSec}s{run.warmup ? ' · warm-up lap' : ''}
        </span>
        <span>
          budget {(run.settings.triangleBudget / 1e6).toFixed(1)} M tris · {run.model.name}
        </span>
      </div>
      <div className="bench-headline">
        <div>
          <b>{fixed(s.avgFps)}</b>
          <small>avg FPS</small>
        </div>
        <div>
          <b>{fixed(s.fps1Low)}</b>
          <small>1% low</small>
        </div>
        <div>
          <b>{s.avgGpuMs === null ? 'n/a' : fixed(s.avgGpuMs, 2)}</b>
          <small>GPU ms</small>
        </div>
        <div>
          <b>{fixed(s.p99FrameMs, 1)}</b>
          <small>p99 frame ms</small>
        </div>
      </div>
      <div className="bench-toolbar">
        <MetricSelect value={metric} onChange={setMetric} />
      </div>
      <Chart series={series} durationSec={run.durationSec} unit={metric} />
      <dl className="bench-summary">
        {SUMMARY_ROWS.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value(s)}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

const Results = ({ runner, run }: { runner: BenchmarkRunner; run: BenchmarkRun }) => {
  const [label, setLabel] = useState(run.label)
  const [error, setError] = useState('')
  return (
    <div className="bench-overlay">
      <div className="bench-modal">
        <h2>Benchmark results</h2>
        <RunDetails run={run} />
        <label className="bench-field">
          Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        {error && <p className="bench-error">{error}</p>}
        <div className="bench-actions">
          <button className="primary" onClick={() => setError(runner.saveResult(label) ?? '')}>
            Save
          </button>
          <button onClick={() => runner.discardResult()}>Discard</button>
        </div>
      </div>
    </div>
  )
}

const History = ({ runs, onClose }: { runs: BenchmarkRun[]; onClose: () => void }) => {
  const [gpuFilter, setGpuFilter] = useState('')
  const [scenarioFilter, setScenarioFilter] = useState<'' | CullingMode>('')
  const [selected, setSelected] = useState<string[]>([])
  const [detail, setDetail] = useState<BenchmarkRun | null>(null)
  const [metric, setMetric] = useState<BenchmarkMetric>('frameMs')

  const gpus = useMemo(() => [...new Set(runs.map((r) => r.system.gpu))], [runs])
  const visible = runs.filter((r) => (!gpuFilter || r.system.gpu === gpuFilter) && (!scenarioFilter || r.scenario === scenarioFilter))
  const compared = selected.map((id) => runs.find((r) => r.id === id)).filter((r): r is BenchmarkRun => r !== undefined)
  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-SERIES_COLORS.length)))

  const current = detail ? runs.find((r) => r.id === detail.id) : undefined
  if (current) {
    return (
      <div className="bench-overlay">
        <div className="bench-modal">
          <h2>{current.label}</h2>
          <RunDetails run={current} />
          <div className="bench-actions">
            <button onClick={() => setDetail(null)}>Back</button>
            <button
              className="danger"
              onClick={() => {
                benchmarkStorage.remove(current.id)
                setSelected((prev) => prev.filter((id) => id !== current.id))
                setDetail(null)
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    )
  }

  const durationSec = compared[0]?.durationSec ?? 60
  const series: ChartSeries[] = compared.map((run, i) => ({
    label: run.label,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    values: run.bins.map((b) => b[metric]),
  }))

  return (
    <div className="bench-overlay">
      <div className="bench-modal wide">
        <h2>Saved benchmarks ({runs.length})</h2>
        {runs.length === 0 ? (
          <p className="bench-empty">Nothing saved yet. Run a benchmark and press Save.</p>
        ) : (
          <>
            <div className="bench-toolbar">
              <select value={scenarioFilter} onChange={(e) => setScenarioFilter(e.target.value as '' | CullingMode)}>
                <option value="">All techniques</option>
                {CULLING_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select value={gpuFilter} onChange={(e) => setGpuFilter(e.target.value)}>
                <option value="">All GPUs</option>
                {gpus.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <span className="bench-hint">Tick runs to compare them (up to {SERIES_COLORS.length}).</span>
            </div>
            <div className="bench-table-wrap">
              <table className="bench-table">
                <thead>
                  <tr>
                    <th />
                    <th>Name</th>
                    <th>Technique</th>
                    <th>GPU</th>
                    <th>Avg FPS</th>
                    <th>1% low</th>
                    <th>GPU ms</th>
                    <th>p99 ms</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <input type="checkbox" checked={selected.includes(run.id)} onChange={() => toggle(run.id)} />
                      </td>
                      <td>
                        <button className="link" onClick={() => setDetail(run)} title={new Date(run.createdAt).toLocaleString()}>
                          {run.label}
                        </button>
                      </td>
                      <td>
                        <span className={`bench-badge scenario-${run.scenario.replace('+', '-')}`}>{scenarioLabel(run.scenario)}</span>
                      </td>
                      <td className="gpu">{run.system.gpu}</td>
                      <td>{fixed(run.summary.avgFps)}</td>
                      <td>{fixed(run.summary.fps1Low)}</td>
                      <td>{run.summary.avgGpuMs === null ? 'n/a' : fixed(run.summary.avgGpuMs, 2)}</td>
                      <td>{fixed(run.summary.p99FrameMs, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {compared.length > 0 && (
              <>
                <div className="bench-toolbar">
                  <MetricSelect value={metric} onChange={setMetric} />
                </div>
                <Chart series={series} durationSec={durationSec} unit={metric} />
              </>
            )}
          </>
        )}
        <div className="bench-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

const phaseTitle = {
  warmup: 'Warm-up lap',
  settle: 'Letting the streaming settle',
  running: 'Benchmark running',
} as const

export const BenchmarkUI = ({ runner }: { runner: BenchmarkRunner }) => {
  const state = useSyncExternalStore(runner.subscribe, runner.getSnapshot)
  const runs = useSyncExternalStore(benchmarkStorage.subscribe, benchmarkStorage.getSnapshot)
  const [scenario, setScenario] = useState<CullingMode>(cullingConfig.mode)
  const [durationSec, setDurationSec] = useState(60)
  const [warmup, setWarmup] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)

  const active = state.phase === 'warmup' || state.phase === 'settle' || state.phase === 'running'

  useEffect(() => {
    document.body.classList.toggle('bench-active', active || state.phase === 'finished')
  }, [active, state.phase])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && runner.cancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, runner])

  if (state.phase === 'finished' && state.result) return <Results runner={runner} run={state.result} />

  if (active) {
    const live = state.live
    const running = state.phase === 'running'
    return (
      <div className="bench-hud">
        <div className="bench-hud-title">
          {phaseTitle[state.phase as keyof typeof phaseTitle]} · {scenarioLabel(state.options?.scenario ?? 'none')}
          {running && state.options && (
            <span>
              {' '}
              {state.elapsed.toFixed(1)} / {state.options.durationSec} s
            </span>
          )}
        </div>
        <div className="bench-progress">
          <div style={{ width: `${(state.progress * 100).toFixed(1)}%` }} />
        </div>
        <div className="bench-live">
          <span>
            <b>{live.fps.toFixed(0)}</b> FPS
          </span>
          <span>
            <b>{live.frameMs.toFixed(1)}</b> ms
          </span>
          <span>
            <b>{live.gpuMs === null ? 'n/a' : live.gpuMs.toFixed(1)}</b> GPU ms
          </span>
          <span>
            <b>{compact(live.triangles)}</b> tris
          </span>
          <span>
            <b>{live.drawCalls}</b> draws
          </span>
          <span>
            <b>{live.selectedCells}</b> cells
          </span>
          <span>
            <b>{live.pendingLoads}</b> loading
          </span>
        </div>
        <button onClick={() => runner.cancel()}>Cancel (Esc)</button>
      </div>
    )
  }

  return (
    <>
      <div className="bench-launcher">
        <div className="bench-launcher-title">Benchmark</div>
        <label>
          Technique
          <select
            value={scenario}
            onChange={(e) => {
              const mode = e.target.value as CullingMode
              setScenario(mode)
              cullingConfig.mode = mode
            }}
          >
            {CULLING_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Duration
          <select value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} s
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={warmup} onChange={(e) => setWarmup(e.target.checked)} />
          Warm-up lap
        </label>
        <div className="bench-actions">
          <button
            className="primary"
            onClick={() => {
              runner.clearNotice()
              runner.start({ scenario, durationSec, warmup })
            }}
          >
            Play
          </button>
          <button onClick={() => setHistoryOpen(true)}>History ({runs.length})</button>
        </div>
        {state.notice && <p className="bench-notice">{state.notice}</p>}
      </div>
      {historyOpen && <History runs={runs} onClose={() => setHistoryOpen(false)} />}
    </>
  )
}
