import * as THREE from 'three'

export interface Cameras {
  camera: THREE.PerspectiveCamera
  /** Orthographic, looking straight down; used by the minimap. */
  topCamera: THREE.OrthographicCamera
}

export const createTopCamera = (): THREE.OrthographicCamera => {
  const extent = 175
  const camera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, 0.1, 1000)
  // The GPU renderer works in WebGPU clip space, where depth runs 0..1 instead of -1..1.
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem
  camera.position.set(0, 150, 0.0001) // leve offset em z evita lookAt degenerado no polo
  camera.up.set(0, 0, -1)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  return camera
}

export const createCameras = (): Cameras => {
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000)
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem
  camera.position.set(0, 50, 150)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  return { camera, topCamera: createTopCamera() }
}

/**
 * Places the cameras around a model: the main camera outside the box on the +Z side looking at its
 * centre, the minimap camera above it. Returns the model's longest dimension (metres).
 */
export const frameModel = ({ camera, topCamera }: Cameras, bounds: THREE.Box3): number => {
  const size = bounds.getSize(new THREE.Vector3())
  const center = bounds.getCenter(new THREE.Vector3())
  const longest = Math.max(size.x, size.y, size.z)

  camera.position.set(
    center.x,
    center.y + size.y * 0.5 + longest * 0.15,
    bounds.max.z + longest * 0.6,
  )
  camera.lookAt(center)
  camera.far = Math.max(longest * 6, 500)
  camera.updateProjectionMatrix()

  topCamera.position.x = center.x
  topCamera.position.z = center.z + 0.0001
  return longest
}
