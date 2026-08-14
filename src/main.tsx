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
import type { TilesRenderer } from '3d-tiles-renderer'

interface StatsSnapshot {
  visibleTiles: number
  activeTiles: number
  loadProgress: number
  tileStatsLabel: string
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App container not found')
}

const hud = initHud()
const { renderer, scene, camera, tiles: initialTiles } = initScene(hud.canvas)

setupResizeHandler({
  container: app,
  camera,
  renderer,
})

const controls = createControls({ camera, domElement: renderer.domElement })

const clock = new THREE.Clock()
const tilesBounds = new THREE.Box3()
const tilesSphere = new THREE.Sphere()
const cameraOffsetDirection = new THREE.Vector3()
const tileCenter = new THREE.Vector3()

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

// Live readouts shared with the Leva panel.
const statsRef: { current: StatsSnapshot } = {
  current: {
    visibleTiles: 0,
    activeTiles: 0,
    loadProgress: 0,
    tileStatsLabel: 'Tiles: loading…',
  },
}

let tilesRef = { current: tiles }
const levaHost = document.querySelector<HTMLDivElement>('#leva-host') ?? document.body
const levaRoot = createRoot(levaHost)
levaRoot.render(<ControlsPanel tilesRef={tilesRef} statsRef={statsRef} />)

const onRootLoaded = () => {
  let fitRadius = 1
  let hasCenter = false

  if (tiles.getBoundingSphere(tilesSphere)) {
    tileCenter.copy(tilesSphere.center)
    fitRadius = Math.max(tilesSphere.radius, 1)
    hasCenter = true
  } else if (tiles.getBoundingBox(tilesBounds)) {
    tilesBounds.getCenter(tileCenter)
    fitRadius = Math.max(tilesBounds.getSize(cameraOffsetDirection).length() * 0.5, 1)
    hasCenter = true
  }

  if (!hasCenter) {
    return
  }

  cameraOffsetDirection.copy(camera.position).sub(tileCenter)

  if (cameraOffsetDirection.lengthSq() < 1e-6) {
    cameraOffsetDirection.set(1, 0.8, 1)
  }

  cameraOffsetDirection.normalize()

  const fitDistance = fitRadius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5))
  camera.position.copy(tileCenter).addScaledVector(cameraOffsetDirection, fitDistance * 1.15)
  camera.lookAt(tileCenter)
  camera.near = Math.max(fitRadius * 0.0005, 0.01)
  camera.far = Math.max(fitRadius * 400, camera.near + 1000)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)

  controls.movementSpeed = Math.max(fitRadius * 0.75, 5)
}

tiles.addEventListener('load-root-tileset', onRootLoaded)
if (tiles.root) {
  onRootLoaded()
}

initUrlWidget((url: string) => {
  disposeTilesRenderer(tiles, scene)
  tiles = createTilesRenderer(url, camera, renderer)
  tiles.addEventListener('load-root-tileset', onRootLoaded)
  scene.add(tiles.group)

  // Pass a new ref object so the React island re-syncs its defaults.
  tilesRef = { current: tiles }
  levaRoot.render(<ControlsPanel tilesRef={tilesRef} statsRef={statsRef} />)
})

const render = () => {
  const delta = clock.getDelta()

  controls.update(delta)
  camera.updateMatrixWorld()
  tiles.setResolutionFromRenderer(camera, renderer)
  tiles.update()

  renderer.render(scene, camera)

  statsRef.current = {
    visibleTiles: tiles.visibleTiles.size,
    activeTiles: tiles.activeTiles.size,
    loadProgress: Math.round(tiles.loadProgress * 100),
    tileStatsLabel: `Tiles: ${tiles.visibleTiles.size} visible · ${tiles.activeTiles.size} active · ${Math.round(tiles.loadProgress * 100)}% loaded`,
  }

  stats.update()
  requestAnimationFrame(render)
}

render()
