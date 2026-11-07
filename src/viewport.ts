import type { PerspectiveCamera } from 'three'
import type { GpuRenderer } from './gpu/renderer'

interface ResizeConfig {
  container: HTMLElement
  camera: PerspectiveCamera
  gpu: GpuRenderer
}

export const setupResizeHandler = ({ container, camera, gpu }: ResizeConfig): void => {
  const onResize = () => {
    const width = Math.max(container.clientWidth, 1)
    const height = Math.max(container.clientHeight, 1)

    camera.aspect = width / height
    camera.updateProjectionMatrix()
    gpu.resize(width, height, Math.min(window.devicePixelRatio, 2))
  }

  window.addEventListener('resize', onResize)
  onResize()
}
