import './style.css'
import * as THREE from 'three'
import Stats from 'three/examples/jsm/libs/stats.module.js'
import { createRoot } from 'react-dom/client'
import { initHud } from './hud'
import { frameModel, initScene } from './scene'
import { setupResizeHandler } from './viewport'
import { createControls } from './controls'
import { ControlsPanel } from './ControlsPanel'
import { PerformanceMonitor } from './performance'
import { createDefaultSettings, createEmptyStats, loadCadModel, type CadModel } from './cad/cadModel'

const CAD_URL = `${import.meta.env.BASE_URL}data/cad`

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App container not found')
}

const hud = initHud()
const setup = await initScene(hud.canvas)
const { renderer, scene, camera, modelRoot, topCamera, cameraHelper } = setup

setupResizeHandler({
  container: app,
  camera,
  renderer,
})

const controls = createControls({ camera, domElement: renderer.domElement, movementSpeed: 30 })

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

const perf = new PerformanceMonitor(renderer)

const cadSettings = createDefaultSettings()
const cadStats = createEmptyStats()
let cad: CadModel | null = null

const loadStatus = document.querySelector<HTMLDivElement>('#load-status')
const showStatus = (text: string, isError = false) => {
  if (!loadStatus) return
  loadStatus.textContent = text
  loadStatus.classList.toggle('error', isError)
  loadStatus.style.display = text ? 'block' : 'none'
}

const MB = 2 ** 20
loadCadModel(CAD_URL, cadSettings, cadStats, ({ phase, loaded, total }) => {
  if (phase === 'metadata') showStatus('Loading CAD metadata…')
  else if (phase === 'hierarchy') showStatus(`Loading hierarchy… ${(loaded / MB).toFixed(0)} / ${(total / MB).toFixed(0)} MB`)
})
  .then((model) => {
    cad = model
    modelRoot.add(model.group)
    const longest = frameModel(setup, model.coreBounds)
    controls.movementSpeed = longest / 10
    showStatus('')
  })
  .catch((error: unknown) => {
    console.error(error)
    showStatus(error instanceof Error ? error.message : String(error), true)
  })

const topViewConfigRef: { current: { enabled: boolean } } = { current: { enabled: false } }
const topCameraRef = { current: topCamera }
const minimapFrame = document.querySelector<HTMLDivElement>('#minimap-frame')

const levaHost = document.querySelector<HTMLDivElement>('#leva-host') ?? document.body
const levaRoot = createRoot(levaHost)
levaRoot.render(
  <ControlsPanel
    perfRef={{ current: perf.snapshot }}
    topCameraRef={topCameraRef}
    topViewConfigRef={topViewConfigRef}
    cadSettings={cadSettings}
    cadStats={cadStats}
  />,
)

const canvasSize = new THREE.Vector2()

const render = () => {
  perf.beginFrame()
  const delta = clock.getDelta()

  controls.update(delta)
  camera.updateMatrixWorld()
  cameraHelper.update()
  renderer.getSize(canvasSize)
  cad?.update(camera, canvasSize.y)
  perf.markUpdateDone()

  renderer.render(scene, camera)
  perf.markMainDone()

  const minimapEnabled = topViewConfigRef.current.enabled
  if (minimapFrame) minimapFrame.style.display = minimapEnabled ? 'block' : 'none'

  if (minimapEnabled) {
    const minimapSize = 220
    const margin = 20
    const x = canvasSize.x - minimapSize - margin
    // WebGPU viewport origin is top-left (WebGL's was bottom-left), so anchor from the bottom explicitly
    const y = canvasSize.y - minimapSize - margin

    renderer.setScissorTest(true)
    renderer.setViewport(x, y, minimapSize, minimapSize)
    renderer.setScissor(x, y, minimapSize, minimapSize)
    renderer.render(scene, topCamera)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, canvasSize.x, canvasSize.y)
  }

  perf.endFrame(minimapEnabled)

  stats.update()
  requestAnimationFrame(render)
}

render()
