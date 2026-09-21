import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { createForestScene, START_POSITION } from './forestScene'
import type { SceneSetup } from './types'

export const createTopCamera = (): THREE.OrthographicCamera => {
  const extent = 200
  const camera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, 0.1, 1000)
  camera.position.set(0, 150, 0.0001) // leve offset em z evita lookAt degenerado no polo
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
  scene.background = new THREE.Color('#9cc7e8')

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 10000)
  camera.position.copy(START_POSITION)
  camera.lookAt(START_POSITION.x, START_POSITION.y, 0)

  const hemi = new THREE.HemisphereLight('#d7f3ff', '#3a4a2a', 0.9)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight('#ffe6bf', 1.1)
  sun.position.set(3, 5, 4)
  scene.add(sun)

  const forest = createForestScene()
  scene.add(forest.group)

  const topCamera = createTopCamera()
  const cameraHelper = createMainCameraHelper(camera)
  scene.add(cameraHelper)

  return {
    renderer,
    scene,
    camera,
    forest,
    topCamera,
    cameraHelper,
  }
}
