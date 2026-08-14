import { FlyControls } from 'three/examples/jsm/controls/FlyControls.js'
import type { PerspectiveCamera } from 'three'

export interface ControlsConfig {
  camera: PerspectiveCamera
  domElement: HTMLElement
  movementSpeed?: number
  rollSpeed?: number
}

export const createControls = ({ 
  camera,
  domElement,
  movementSpeed = 5,
  rollSpeed = 0.5,
}: ControlsConfig): FlyControls => {
  const controls = new FlyControls(camera, domElement)
  controls.movementSpeed = movementSpeed
  controls.rollSpeed = rollSpeed
  controls.dragToLook = true
  return controls
}
