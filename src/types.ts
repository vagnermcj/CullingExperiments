export interface HudElements {
  canvas: HTMLCanvasElement
}

export interface SceneSetup {
  renderer: import('three/webgpu').WebGPURenderer
  scene: import('three').Scene
  camera: import('three').PerspectiveCamera
  forest: import('./forestScene').ForestScene
  topCamera: import('three').OrthographicCamera
  cameraHelper: import('three').CameraHelper
}
