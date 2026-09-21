import './style.css'
import * as THREE from 'three'
import Stats from 'three/examples/jsm/libs/stats.module.js'
import { createRoot } from 'react-dom/client'
import { initHud } from './hud'
import { initScene, createTilesRenderer, disposeTilesRenderer } from './scene'
import { setupResizeHandler } from './viewport'
import { createControls } from './controls'
import { initUrlWidget } from './urlWidget'
import { ControlsPanel } from './ControlsPanel'
import { PerformanceMonitor } from './performance'
import type { TilesRenderer } from '3d-tiles-renderer'

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App container not found')
}

const hud = initHud()
const { renderer, scene, camera, tiles: initialTiles, topCamera, cameraHelper } = await initScene(hud.canvas)

setupResizeHandler({
  container: app,
  camera,
  renderer,
})

const controls = createControls({ camera, domElement: renderer.domElement })

const clock = new THREE.Clock()
let tiles: TilesRenderer = initialTiles

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

const perf = new PerformanceMonitor(renderer, () => tiles.group)

const topViewConfigRef: { current: { enabled: boolean } } = { current: { enabled: true } }
const topCameraRef = { current: topCamera }
const minimapFrame = document.querySelector<HTMLDivElement>('#minimap-frame')

const levaHost = document.querySelector<HTMLDivElement>('#leva-host') ?? document.body
const levaRoot = createRoot(levaHost)
levaRoot.render(
  <ControlsPanel
    perfRef={{ current: perf.snapshot }}
    topCameraRef={topCameraRef}
    topViewConfigRef={topViewConfigRef}
  />,
)

initUrlWidget((url: string) => {
  disposeTilesRenderer(tiles, scene)
  tiles = createTilesRenderer(url, camera, renderer)
  scene.add(tiles.group)
})

const render = () => {
  perf.beginFrame()
  const delta = clock.getDelta()

  controls.update(delta)
  camera.updateMatrixWorld()
  cameraHelper.update()
  tiles.setResolutionFromRenderer(camera, renderer)
  tiles.update()
  perf.markUpdateDone()

  renderer.render(scene, camera)
  perf.markMainDone()

  const minimapEnabled = topViewConfigRef.current.enabled
  if (minimapFrame) minimapFrame.style.display = minimapEnabled ? 'block' : 'none'

  if (minimapEnabled) {
    const minimapSize = 220
    const margin = 20
    const canvasSize = renderer.getSize(new THREE.Vector2())
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


  perf.endFrame(tiles, minimapEnabled)

  stats.update()
  requestAnimationFrame(render)
}

render()
