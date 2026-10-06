export interface HudElements {
  canvas: HTMLCanvasElement
}

export interface SceneSetup {
  renderer: import('three/webgpu').WebGPURenderer
  scene: import('three').Scene
  camera: import('three').PerspectiveCamera
  /** Parent of the streamed CAD model once it has loaded. */
  modelRoot: import('three').Group
  topCamera: import('three').OrthographicCamera
  cameraHelper: import('three').CameraHelper
}
