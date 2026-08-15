import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer'
import { DebugTilesPlugin } from '3d-tiles-renderer/plugins'
import type { SceneSetup } from './types'

export const createTilesRenderer = (
  url: string,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
): TilesRenderer => {
  const tiles = new TilesRenderer(url)
  // Debug plugin: registered but disabled by default; Leva panel toggles it.
  tiles.registerPlugin(new DebugTilesPlugin({ enabled: false }))
  tiles.setCamera(camera)
  tiles.setResolutionFromRenderer(camera, renderer)
  return tiles
}

export const disposeTilesRenderer = (tiles: TilesRenderer, scene: THREE.Scene): void => {
  scene.remove(tiles.group)
  tiles.dispose()
}

export const initScene = (canvas: HTMLCanvasElement): SceneSetup => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#0a1524')

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 10000)
  camera.position.set(10, 10, 10)
  camera.lookAt(0, 0, 0)

  const hemi = new THREE.HemisphereLight('#d7f3ff', '#123459', 0.9)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight('#ffe6bf', 1.1)
  sun.position.set(3, 5, 4)
  scene.add(sun)

  const params = new URLSearchParams(window.location.search)
  const tilesetUrl =
    params.get('tileset') ?? `${import.meta.env.BASE_URL}data/add_spheres/tileset.json`

  const tiles = createTilesRenderer(tilesetUrl, camera, renderer)
  scene.add(tiles.group)

  return {
    renderer,
    scene,
    camera,
    tiles,
  }
}
