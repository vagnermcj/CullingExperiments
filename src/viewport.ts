import type { PerspectiveCamera } from 'three'
import { WebGPURenderer } from 'three/webgpu'

interface ResizeConfig {
  container: HTMLElement
  camera: PerspectiveCamera
  renderer: WebGPURenderer
}

export const setupResizeHandler = ({
  container,
  camera,
  renderer,
}: ResizeConfig): void => {
  const onResize = () => {
    const { clientWidth, clientHeight } = container
    const width = Math.max(clientWidth, 1)
    const height = Math.max(clientHeight, 1)

    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
  }

  window.addEventListener('resize', onResize)
  onResize()
}
