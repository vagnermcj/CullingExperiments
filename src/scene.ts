import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { TilesRenderer } from '3d-tiles-renderer'
import { DebugTilesPlugin } from '3d-tiles-renderer/plugins'
import type { SceneSetup } from './types'

export const createTilesRenderer = (
  url: string,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGPURenderer,
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

export const createTopCamera = (): THREE.OrthographicCamera => {
  const extent = 8
  const camera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, 0.1, 500)
  camera.position.set(0, 100, 0.0001) // leve offset em z evita lookAt degenerado no polo
  camera.up.set(0, 0, -1)
  camera.lookAt(0, 0, 0)
  camera.layers.enableAll() // enxerga tudo, inclusive o CameraHelper (layer 1)
  return camera
}

export const createMainCameraHelper = (camera: THREE.PerspectiveCamera): THREE.CameraHelper => {
  const helper = new THREE.CameraHelper(camera)
  helper.layers.set(1) // fica invisível pra câmera principal (layer 0), visível só no topo
  return helper
}

export const initScene = async (canvas: HTMLCanvasElement): Promise<SceneSetup> => {
  const renderer = new WebGPURenderer({ canvas, antialias: true })
  await renderer.init()
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
  const topCamera = createTopCamera()
  const cameraHelper = createMainCameraHelper(camera)
  scene.add(cameraHelper)

  return {
    renderer,
    scene,
    camera,
    tiles,
    topCamera,
    cameraHelper,
  }
}
