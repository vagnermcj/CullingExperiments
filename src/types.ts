export interface HudElements {
  canvas: HTMLCanvasElement
}

export interface SceneSetup {
  renderer: import('three').WebGLRenderer
  scene: import('three').Scene
  camera: import('three').PerspectiveCamera
  tiles: import('3d-tiles-renderer').TilesRenderer
}
