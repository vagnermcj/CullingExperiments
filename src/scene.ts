import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import type { SceneSetup } from './types'

export const createTopCamera = (): THREE.OrthographicCamera => {
  const extent = 175
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

/**
 * Places the cameras around a model: the main camera outside the box on the +Z side looking at its
 * centre, the minimap camera above it. Returns the model's longest dimension (metres).
 */
export const frameModel = (
  { camera, topCamera }: Pick<SceneSetup, 'camera' | 'topCamera'>,
  bounds: THREE.Box3,
): number => {
  const size = bounds.getSize(new THREE.Vector3())
  const center = bounds.getCenter(new THREE.Vector3())
  const longest = Math.max(size.x, size.y, size.z)

  camera.position.set(center.x, center.y + size.y * 0.5 + longest * 0.15, bounds.max.z + longest * 0.6)
  camera.lookAt(center)
  camera.far = Math.max(longest * 6, 500)
  camera.updateProjectionMatrix()

  topCamera.position.x = center.x
  topCamera.position.z = center.z + 0.0001
  return longest
}

export const initScene = async (canvas: HTMLCanvasElement): Promise<SceneSetup> => {
  const renderer = new WebGPURenderer({ canvas, antialias: true })
  await renderer.init()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#9cc7e8')

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000)
  camera.position.set(0, 50, 150)
  camera.lookAt(0, 0, 0)

  const hemi = new THREE.HemisphereLight('#d7f3ff', '#3a4a2a', 0.9)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight('#ffe6bf', 1.1)
  sun.position.set(3, 5, 4)
  scene.add(sun)

  const modelRoot = new THREE.Group()
  scene.add(modelRoot)

  const topCamera = createTopCamera()
  const cameraHelper = createMainCameraHelper(camera)
  scene.add(cameraHelper)

  return {
    renderer,
    scene,
    camera,
    modelRoot,
    topCamera,
    cameraHelper,
  }
}
