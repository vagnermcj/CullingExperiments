import './style.css'
import * as THREE from 'three'
import Stats from 'three/examples/jsm/libs/stats.module.js'
import { createRoot } from 'react-dom/client'
import { initHud } from './hud'
import { createCameras, frameModel } from './scene'
import { setupResizeHandler } from './viewport'
import { createControls } from './controls'
import { ControlsPanel } from './ControlsPanel'
import { PerformanceMonitor } from './performance'
import { GpuRenderer, type BoxView } from './gpu/renderer'
import {
  createDefaultSettings,
  createEmptyStats,
  loadCadModel,
  type CadModel,
} from './cad/cadModel'
import { cullingConfig, usesFrustum, usesOcclusion } from './cad/cullingHooks'
import { BenchmarkRunner } from './benchmark/benchmarkRunner'
import { BenchmarkUI } from './benchmark/BenchmarkUI'
import { detectGpuName } from './benchmark/system'

const CAD_URL = `${import.meta.env.BASE_URL}data/cad`

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App container not found')
}

const loadStatus = document.querySelector<HTMLDivElement>('#load-status')
const showStatus = (text: string, isError = false) => {
  if (!loadStatus) return
  loadStatus.textContent = text
  loadStatus.classList.toggle('error', isError)
  loadStatus.style.display = text ? 'block' : 'none'
}

const hud = initHud()
let gpu: GpuRenderer
try {
  gpu = await GpuRenderer.create(hud.canvas, (message) =>
    showStatus(`GPU device lost: ${message}`, true),
  )
} catch (error) {
  console.error(error)
  showStatus(error instanceof Error ? error.message : String(error), true)
  throw error
}

const cameras = createCameras()
const { camera, topCamera } = cameras

setupResizeHandler({
  container: app,
  camera,
  gpu,
})

const controls = createControls({ camera, domElement: hud.canvas, movementSpeed: 30 })

const clock = new THREE.Clock()

// three.js Stats panel
const stats = new Stats()
stats.dom.style.position = 'relative'
stats.dom.style.top = 'auto'
stats.dom.style.left = 'auto'
stats.dom.style.zIndex = '10000'
const statsHost = document.querySelector<HTMLDivElement>('#stats-host')
if (!statsHost) {
  throw new Error('Stats host not found')
}
statsHost.appendChild(stats.dom)

const perf = new PerformanceMonitor(gpu)

const cadSettings = createDefaultSettings()
const cadStats = createEmptyStats()
let cad: CadModel | null = null

const MB = 2 ** 20
loadCadModel(CAD_URL, cadSettings, cadStats, gpu.store, ({ phase, loaded, total }) => {
  if (phase === 'metadata') showStatus('Loading CAD metadata…')
  else if (phase === 'hierarchy')
    showStatus(`Loading hierarchy… ${(loaded / MB).toFixed(0)} / ${(total / MB).toFixed(0)} MB`)
})
  .then((model) => {
    cad = model
    const longest = frameModel(cameras, model.coreBounds)
    controls.movementSpeed = longest / 10
    showStatus('')
  })
  .catch((error: unknown) => {
    console.error(error)
    showStatus(error instanceof Error ? error.message : String(error), true)
  })

let gpuName = 'Unknown GPU'
void detectGpuName().then((name) => (gpuName = name))

const benchmark = new BenchmarkRunner({
  camera,
  perf,
  cadSettings,
  cadStats,
  getModel: () => (cad ? { name: cad.metadata.name, bounds: cad.coreBounds } : null),
  getSystem: () => ({
    gpu: gpuName,
    userAgent: navigator.userAgent,
    resolution: [hud.canvas.clientWidth, hud.canvas.clientHeight],
    pixelRatio: gpu.pixelRatio,
    gpuTiming: perf.gpuTiming,
  }),
})

const topViewConfigRef: { current: { enabled: boolean } } = { current: { enabled: false } }
const topCameraRef = { current: topCamera }
const boxViewRef: { current: { view: BoxView; onTop: boolean } } = {
  current: { view: 'off', onTop: true },
}
/** Depth pyramid level shown over the main view; -1 for off. */
const pyramidViewRef: { current: { mip: number } } = { current: { mip: -1 } }
const minimapFrame = document.querySelector<HTMLDivElement>('#minimap-frame')

const levaHost = document.querySelector<HTMLDivElement>('#leva-host') ?? document.body
const levaRoot = createRoot(levaHost)
levaRoot.render(
  <ControlsPanel
    perfRef={{ current: perf.snapshot }}
    topCameraRef={topCameraRef}
    topViewConfigRef={topViewConfigRef}
    boxViewRef={boxViewRef}
    pyramidViewRef={pyramidViewRef}
    cadSettings={cadSettings}
    cadStats={cadStats}
  />,
)

const benchmarkHost = document.querySelector<HTMLDivElement>('#benchmark-host') ?? document.body
createRoot(benchmarkHost).render(<BenchmarkUI runner={benchmark} />)

const render = () => {
  perf.beginFrame()
  const delta = clock.getDelta()

  if (benchmark.active) benchmark.update(delta)
  else controls.update(delta)
  camera.updateMatrixWorld()
  cad?.update(camera, gpu.size.height)
  perf.markUpdateDone()

  const minimapEnabled = topViewConfigRef.current.enabled && !benchmark.active
  if (minimapFrame) minimapFrame.style.display = minimapEnabled ? 'block' : 'none'

  gpu.render({
    camera,
    minimapCamera: minimapEnabled ? topCamera : null,
    frustumCulling: usesFrustum(cullingConfig.mode),
    occlusionCulling: usesOcclusion(cullingConfig.mode),
    freezeCulling: cullingConfig.freeze,
    // Off during benchmark runs, like the minimap, so the overlay never skews the numbers.
    boxView: benchmark.active ? 'off' : boxViewRef.current.view,
    boxesOnTop: boxViewRef.current.onTop,
    pyramidMip:
      benchmark.active || pyramidViewRef.current.mip < 0 ? null : pyramidViewRef.current.mip,
  })
  perf.markMainDone()

  perf.endFrame()
  benchmark.recordFrame(delta * 1000)

  stats.update()
  requestAnimationFrame(render)
}

render()
