import * as THREE from 'three'
import cullShader from './shaders/cull.wgsl?raw'
import hizShader from './shaders/hiz.wgsl?raw'
import hizDebugShader from './shaders/hizDebug.wgsl?raw'
import overlayShader from './shaders/overlay.wgsl?raw'
import renderShader from './shaders/render.wgsl?raw'
import { ARGS_BYTES, CellStore } from './cellStore'
import { DepthPyramid } from './depthPyramid'
import { requestGpuDevice } from './device'
import { PLANE_COUNT, extractFrustumPlanes } from './frustum'

export const MINIMAP_SIZE = 220
export const MINIMAP_MARGIN = 20

const DEPTH_FORMAT: GPUTextureFormat = 'depth32float'
const WORKGROUP_SIZE = 64
const BACKGROUND = 0x9cc7e8
const FRAME_FLOATS = 36
// 6 planes (96 bytes), cellCount, flags, near, pad, then viewProj at byte 112
const CULL_UNIFORM_BYTES = 176
const CULL_NEAR_FLOAT = 26
const CULL_VIEW_PROJ_FLOAT = 28
const FLAG_FRUSTUM = 1
const FLAG_OCCLUSION = 2
// counters (4 x u32) then 4 timestamps (4 x u64)
const STAGING_COUNT = 3
const STAGING_BYTES = 48

export interface GpuFrameStats {
  /** Cells the HLOD selection asked for, and how many survived culling. Read back from the GPU, one to two frames late. */
  selectedDraws: number
  visibleDraws: number
  visibleTriangles: number
  /** Cells that passed the frustum test and were then rejected by the occlusion test. */
  occludedDraws: number
  /** Indirect draws encoded this frame: every resident cell, culled or not. */
  issuedDraws: number
  /** GPU milliseconds; null without `timestamp-query`. */
  gpuMs: number | null
  cullMs: number | null
  renderMs: number | null
  gpuBytes: number
  cells: number
}

/** Which cell bounding boxes to draw: none, only the drawn cells, every HLOD-selected cell, or every resident cell. */
export type BoxView = 'off' | 'drawn' | 'selected' | 'resident'

const BOX_VIEW_CODE: Record<BoxView, number> = { off: 0, drawn: 1, selected: 2, resident: 3 }

export interface RenderRequest {
  camera: THREE.PerspectiveCamera
  /** When set, the minimap is drawn from this camera, with the main camera's culling results. */
  minimapCamera: THREE.OrthographicCamera | null
  /** Run the frustum test in the culling shader. */
  frustumCulling: boolean
  /** Run the Hi-Z occlusion test in the culling shader (off while the culling frustum is frozen). */
  occlusionCulling: boolean
  /** Keep culling against the last frustum while the camera moves freely. */
  freezeCulling: boolean
  /** Bounding-box overlay, coloured by the culling result (green drawn, red culled, grey not selected). */
  boxView: BoxView
  /** Draw the boxes through the geometry instead of depth-testing them against it. */
  boxesOnTop: boolean
  /** Debug: build the depth pyramid and show this level of it over the main view; null for off. */
  pyramidMip: number | null
}

type ShaderModules = Record<'render' | 'overlay' | 'cull' | 'hiz' | 'hizDebug', GPUShaderModule>

const sRgb = (hex: number) => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
]

/** Frame uniform: viewProj, then the lighting constants of the old three.js scene. */
const createFrameUniform = (): Float32Array => {
  const data = new Float32Array(FRAME_FLOATS)
  const sun = new THREE.Vector3(3, 5, 4).normalize()
  const sunColor = new THREE.Color('#ffe6bf')
  const skyColor = new THREE.Color('#d7f3ff')
  const groundColor = new THREE.Color('#3a4a2a')
  const [br, bg, bb] = sRgb(BACKGROUND)
  data.set([sun.x, sun.y, sun.z, 0], 16)
  data.set([sunColor.r, sunColor.g, sunColor.b, 1.1], 20)
  data.set([skyColor.r, skyColor.g, skyColor.b, 0.9], 24)
  data.set([groundColor.r, groundColor.g, groundColor.b, 0], 28)
  data.set([br, bg, bb, 1], 32)
  return data
}

const checkShader = async (module: GPUShaderModule, name: string): Promise<void> => {
  const info = await module.getCompilationInfo()
  const errors = info.messages.filter((m) => m.type === 'error')
  if (errors.length > 0) {
    throw new Error(
      `${name} failed to compile:\n${errors.map((m) => `  line ${m.lineNum}: ${m.message}`).join('\n')}`,
    )
  }
}

export class GpuRenderer {
  readonly store: CellStore
  readonly stats: GpuFrameStats = {
    selectedDraws: 0,
    visibleDraws: 0,
    visibleTriangles: 0,
    occludedDraws: 0,
    issuedDraws: 0,
    gpuMs: null,
    cullMs: null,
    renderMs: null,
    gpuBytes: 0,
    cells: 0,
  }
  readonly timestamps: boolean
  pixelRatio = 1

  private readonly canvas: HTMLCanvasElement
  private readonly device: GPUDevice
  private readonly context: GPUCanvasContext
  private readonly format: GPUTextureFormat

  private readonly renderPipeline: GPURenderPipeline
  private readonly backgroundPipeline: GPURenderPipeline
  private readonly linePipeline: GPURenderPipeline
  private readonly boxPipeline: GPURenderPipeline
  private readonly boxOnTopPipeline: GPURenderPipeline
  private readonly boxUniform: GPUBuffer
  private readonly boxBindGroup: GPUBindGroup
  private readonly boxParams = new Uint32Array(4)
  private readonly cullPipeline: GPUComputePipeline
  private readonly pyramid: DepthPyramid

  private readonly mainUniform: GPUBuffer
  private readonly minimapUniform: GPUBuffer
  private readonly mainBindGroup: GPUBindGroup
  private readonly minimapBindGroup: GPUBindGroup
  private readonly cullUniform: GPUBuffer
  private readonly cullLayout: GPUBindGroupLayout
  /** Holds a view of the depth pyramid, so it is recreated with it on resize. */
  private cullBindGroup: GPUBindGroup | null = null
  private readonly counters: GPUBuffer
  private readonly lineBuffer: GPUBuffer

  private readonly querySet: GPUQuerySet | null
  private readonly resolveBuffer: GPUBuffer | null
  private readonly staging: GPUBuffer[] = []
  private readonly stagingBusy: boolean[] = []

  private depthTexture: GPUTexture | null = null
  private minimapDepthTexture: GPUTexture | null = null
  private width = 0
  private height = 0

  private readonly mainFrame = createFrameUniform()
  private readonly minimapFrame = createFrameUniform()
  private readonly cullParams = new ArrayBuffer(CULL_UNIFORM_BYTES)
  private readonly cullFloats = new Float32Array(this.cullParams)
  private readonly cullInts = new Uint32Array(this.cullParams)
  private readonly planes = new Float32Array(PLANE_COUNT * 4)
  private readonly frustumLines = new Float32Array(24 * 3)
  private haveCullFrustum = false
  /** The pyramid was built last frame from the current depth buffer, so the occlusion test may read it. */
  private pyramidReady = false
  private readonly viewProjection = new THREE.Matrix4()
  private readonly corner = new THREE.Vector3()

  private pendingCapture:
    | ((image: { width: number; height: number; bgra: Uint8Array }) => void)
    | null = null

  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    timestamps: boolean,
    modules: ShaderModules,
  ) {
    this.canvas = canvas
    this.device = device
    this.timestamps = timestamps
    const context = canvas.getContext('webgpu')
    if (!context) throw new Error('Could not create a WebGPU canvas context.')
    this.context = context
    this.format = navigator.gpu.getPreferredCanvasFormat()
    // COPY_SRC lets tests read the final image back.
    context.configure({
      device,
      format: this.format,
      alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })

    this.store = new CellStore(device)
    this.pyramid = new DepthPyramid(device, modules.hiz, modules.hizDebug, this.format)

    const uniformLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    })
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [uniformLayout] })
    const target: GPUColorTargetState = { format: this.format }
    const overlayDepth: GPUDepthStencilState = {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: 'always',
    }

    this.renderPipeline = device.createRenderPipeline({
      label: 'cells',
      layout: pipelineLayout,
      vertex: {
        module: modules.render,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: 'snorm8x4' }] },
          { arrayStride: 4, attributes: [{ shaderLocation: 2, offset: 0, format: 'unorm8x4' }] },
        ],
      },
      fragment: { module: modules.render, entryPoint: 'fs', targets: [target] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    })
    this.backgroundPipeline = device.createRenderPipeline({
      label: 'minimap background',
      layout: pipelineLayout,
      vertex: { module: modules.overlay, entryPoint: 'bgVs' },
      fragment: { module: modules.overlay, entryPoint: 'bgFs', targets: [target] },
      primitive: { topology: 'triangle-list' },
      depthStencil: overlayDepth,
    })
    this.linePipeline = device.createRenderPipeline({
      label: 'frustum lines',
      layout: pipelineLayout,
      vertex: {
        module: modules.overlay,
        entryPoint: 'lineVs',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: { module: modules.overlay, entryPoint: 'lineFs', targets: [target] },
      primitive: { topology: 'line-list' },
      depthStencil: overlayDepth,
    })
    const boxLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    })
    const boxPipeline = (label: string, depthStencil: GPUDepthStencilState) =>
      device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [uniformLayout, boxLayout] }),
        vertex: { module: modules.overlay, entryPoint: 'boxVs' },
        fragment: { module: modules.overlay, entryPoint: 'boxFs', targets: [target] },
        primitive: { topology: 'line-list' },
        depthStencil,
      })
    this.boxPipeline = boxPipeline('cell boxes', {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    })
    this.boxOnTopPipeline = boxPipeline('cell boxes on top', overlayDepth)
    // Explicit layout: the pyramid is r32float (not filterable), and an automatic layout would drop the
    // binding while the shader does not read it yet.
    this.cullLayout = device.createBindGroupLayout({
      label: 'cull',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
      ],
    })
    this.cullPipeline = device.createComputePipeline({
      label: 'cull',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.cullLayout] }),
      compute: { module: modules.cull, entryPoint: 'main' },
    })

    const uniformBuffer = (label: string) =>
      device.createBuffer({
        label,
        size: FRAME_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
    this.mainUniform = uniformBuffer('main frame')
    this.minimapUniform = uniformBuffer('minimap frame')
    this.mainBindGroup = device.createBindGroup({
      layout: uniformLayout,
      entries: [{ binding: 0, resource: { buffer: this.mainUniform } }],
    })
    this.minimapBindGroup = device.createBindGroup({
      layout: uniformLayout,
      entries: [{ binding: 0, resource: { buffer: this.minimapUniform } }],
    })

    this.cullUniform = device.createBuffer({
      label: 'cull params',
      size: CULL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.counters = device.createBuffer({
      label: 'cull counters',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })
    this.boxUniform = device.createBuffer({
      label: 'box params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.boxBindGroup = device.createBindGroup({
      layout: boxLayout,
      entries: [
        { binding: 0, resource: { buffer: this.store.boxes } },
        { binding: 1, resource: { buffer: this.store.selectedBuffer } },
        { binding: 2, resource: { buffer: this.store.args } },
        { binding: 3, resource: { buffer: this.boxUniform } },
      ],
    })
    this.lineBuffer = device.createBuffer({
      label: 'frustum lines',
      size: this.frustumLines.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })

    this.querySet = timestamps ? device.createQuerySet({ type: 'timestamp', count: 4 }) : null
    this.resolveBuffer = timestamps
      ? device.createBuffer({
          label: 'timestamps',
          size: 32,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        })
      : null
    for (let i = 0; i < STAGING_COUNT; i++) {
      this.staging.push(
        device.createBuffer({
          label: `readback ${i}`,
          size: STAGING_BYTES,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
      )
      this.stagingBusy.push(false)
    }
  }

  static async create(
    canvas: HTMLCanvasElement,
    onLost: (message: string) => void,
  ): Promise<GpuRenderer> {
    const { device, timestamps } = await requestGpuDevice(onLost)
    const module = (code: string, label: string) => device.createShaderModule({ label, code })
    const sources = {
      render: renderShader,
      overlay: overlayShader,
      cull: cullShader,
      hiz: hizShader,
      hizDebug: hizDebugShader,
    }
    const names = Object.keys(sources) as (keyof typeof sources)[]
    const modules = Object.fromEntries(
      names.map((name) => [name, module(sources[name], `${name}.wgsl`)]),
    ) as ShaderModules
    await Promise.all(names.map((name) => checkShader(modules[name], `${name}.wgsl`)))
    return new GpuRenderer(canvas, device, timestamps, modules)
  }

  get size(): { width: number; height: number } {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight }
  }

  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.pixelRatio = pixelRatio
    const width = Math.max(1, Math.round(cssWidth * pixelRatio))
    const height = Math.max(1, Math.round(cssHeight * pixelRatio))
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
    this.depthTexture?.destroy()
    this.minimapDepthTexture?.destroy()
    this.minimapDepthTexture = null
    this.depthTexture = this.createDepth('main depth')
    this.pyramid.rebuild(this.depthTexture)
    // A fresh pyramid is all zeros (everything at the near plane): not usable until it is built once.
    this.pyramidReady = false
    this.cullBindGroup = this.device.createBindGroup({
      label: 'cull',
      layout: this.cullLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cullUniform } },
        { binding: 1, resource: { buffer: this.store.boxes } },
        { binding: 2, resource: { buffer: this.store.selectedBuffer } },
        { binding: 3, resource: { buffer: this.store.args } },
        { binding: 4, resource: { buffer: this.counters } },
        { binding: 5, resource: this.pyramid.view },
      ],
    })
  }

  render(request: RenderRequest): void {
    const { device, store } = this
    const {
      camera,
      minimapCamera,
      frustumCulling,
      occlusionCulling,
      freezeCulling,
      boxView,
      boxesOnTop,
      pyramidMip,
    } = request
    if (!this.depthTexture || !this.cullBindGroup) return

    // The culling frustum follows the camera unless frozen.
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.mainFrame.set(this.viewProjection.elements, 0)
    if (!freezeCulling || !this.haveCullFrustum) {
      extractFrustumPlanes(this.viewProjection, this.planes)
      this.updateFrustumLines(camera)
      this.haveCullFrustum = true
    }
    device.queue.writeBuffer(this.mainUniform, 0, this.mainFrame)

    const cellCount = store.highWater
    this.cullFloats.set(this.planes, 0)
    this.cullInts[24] = cellCount
    // The pyramid comes from the live camera, so the occlusion test makes no sense against a frozen frustum.
    const testOcclusion = occlusionCulling && !freezeCulling && this.pyramidReady
    this.cullInts[25] = (frustumCulling ? FLAG_FRUSTUM : 0) | (testOcclusion ? FLAG_OCCLUSION : 0)
    this.cullFloats[CULL_NEAR_FLOAT] = camera.near
    this.cullFloats.set(this.viewProjection.elements, CULL_VIEW_PROJ_FLOAT)
    device.queue.writeBuffer(this.cullUniform, 0, this.cullParams)
    store.flush()
    const boxPipeline =
      boxView === 'off' || cellCount === 0
        ? null
        : boxesOnTop
          ? this.boxOnTopPipeline
          : this.boxPipeline
    if (boxPipeline && this.boxParams[0] !== BOX_VIEW_CODE[boxView]) {
      this.boxParams[0] = BOX_VIEW_CODE[boxView]
      device.queue.writeBuffer(this.boxUniform, 0, this.boxParams)
    }

    const room = (MINIMAP_SIZE + MINIMAP_MARGIN) * this.pixelRatio
    const minimap =
      minimapCamera !== null && this.width > room && this.height > room ? minimapCamera : null
    if (minimap) {
      minimap.updateMatrixWorld()
      this.viewProjection.multiplyMatrices(minimap.projectionMatrix, minimap.matrixWorldInverse)
      this.minimapFrame.set(this.viewProjection.elements, 0)
      device.queue.writeBuffer(this.minimapUniform, 0, this.minimapFrame)
    }

    const target = this.context.getCurrentTexture()
    const encoder = device.createCommandEncoder({ label: 'frame' })
    const staging = this.stagingBusy.indexOf(false)

    // 1. Reset the counters, 2. cull on the GPU: this is what decides which draws below do anything.
    // The occlusion test reads the pyramid built at the end of the previous frame.
    encoder.clearBuffer(this.counters)
    const compute = encoder.beginComputePass({
      label: 'cull',
      timestampWrites: this.querySet
        ? { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
        : undefined,
    })
    compute.setPipeline(this.cullPipeline)
    compute.setBindGroup(0, this.cullBindGroup)
    if (cellCount > 0) compute.dispatchWorkgroups(Math.ceil(cellCount / WORKGROUP_SIZE))
    compute.end()

    // 3. Draw every resident cell with an indirect draw; culled ones have instanceCount 0.
    const main = encoder.beginRenderPass({
      label: 'main view',
      colorAttachments: [
        {
          view: target.createView(),
          clearValue: this.clearColor(),
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
      timestampWrites: this.querySet
        ? { querySet: this.querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 }
        : undefined,
    })
    const issued = this.drawCells(main, this.mainBindGroup)
    if (boxPipeline) this.drawBoxes(main, this.mainBindGroup, boxPipeline, cellCount)
    main.end()

    // Depth pyramid from this frame's depth: next frame's occlusion test reads it.
    const buildPyramid = occlusionCulling || pyramidMip !== null
    if (buildPyramid) this.pyramid.encode(encoder)
    this.pyramidReady = buildPyramid
    if (pyramidMip !== null) {
      this.pyramid.encodeDebugView(encoder, target, pyramidMip, camera.near, camera.far)
    }

    // 4. The minimap shows the same culling results from above, plus the culling frustum.
    if (minimap) this.drawMinimap(encoder, target, boxPipeline, cellCount)

    if (this.pendingCapture) this.encodeCapture(encoder, target)

    // 5. Counters and timestamps come back a frame or two later.
    if (staging >= 0) {
      encoder.copyBufferToBuffer(this.counters, 0, this.staging[staging], 0, 16)
      if (this.querySet && this.resolveBuffer) {
        encoder.resolveQuerySet(this.querySet, 0, 4, this.resolveBuffer, 0)
        encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.staging[staging], 16, 32)
      }
    }
    device.queue.submit([encoder.finish()])
    if (staging >= 0) this.readBack(staging)

    this.stats.issuedDraws = issued
    this.stats.cells = issued
    this.stats.gpuBytes =
      store.bytes +
      this.width * this.height * 4 * (this.minimapDepthTexture ? 2 : 1) +
      this.pyramid.bytes
  }

  /** Test utility: the draw arguments the culling shader wrote last frame (5 u32 per slot). */
  async debugReadArgs(): Promise<Uint32Array> {
    const size = Math.max(1, this.store.highWater) * ARGS_BYTES
    const buffer = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    const encoder = this.device.createCommandEncoder()
    encoder.copyBufferToBuffer(this.store.args, 0, buffer, 0, size)
    this.device.queue.submit([encoder.finish()])
    await buffer.mapAsync(GPUMapMode.READ)
    const copy = new Uint32Array(buffer.getMappedRange().slice(0))
    buffer.destroy()
    return copy
  }

  /** Test utility: the final image of the next rendered frame, as BGRA with rows padded to 256 bytes. */
  captureNextFrame(): Promise<{ width: number; height: number; bgra: Uint8Array }> {
    return new Promise((resolve) => {
      this.pendingCapture = resolve
    })
  }

  private clearColor(): GPUColor {
    const [r, g, b] = sRgb(BACKGROUND)
    return { r, g, b, a: 1 }
  }

  private createDepth(label: string): GPUTexture {
    return this.device.createTexture({
      label,
      size: [this.width, this.height],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
  }

  private drawCells(pass: GPURenderPassEncoder, bindGroup: GPUBindGroup): number {
    const { store } = this
    pass.setPipeline(this.renderPipeline)
    pass.setBindGroup(0, bindGroup)
    let issued = 0
    const cells = store.cells
    for (let slot = 0; slot < cells.length; slot++) {
      const cell = cells[slot]
      if (!cell) continue
      pass.setVertexBuffer(0, cell.position)
      pass.setVertexBuffer(1, cell.normal)
      pass.setVertexBuffer(2, cell.color)
      pass.setIndexBuffer(cell.index, 'uint32')
      pass.drawIndexedIndirect(store.args, slot * ARGS_BYTES)
      issued++
    }
    return issued
  }

  private drawBoxes(
    pass: GPURenderPassEncoder,
    bindGroup: GPUBindGroup,
    pipeline: GPURenderPipeline,
    cellCount: number,
  ): void {
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.setBindGroup(1, this.boxBindGroup)
    pass.draw(24, cellCount)
  }

  private drawMinimap(
    encoder: GPUCommandEncoder,
    target: GPUTexture,
    boxPipeline: GPURenderPipeline | null,
    cellCount: number,
  ): void {
    this.minimapDepthTexture ??= this.createDepth('minimap depth')
    const size = Math.round(MINIMAP_SIZE * this.pixelRatio)
    const x = this.width - size - Math.round(MINIMAP_MARGIN * this.pixelRatio)
    // WebGPU's viewport origin is the top-left corner.
    const y = this.height - size - Math.round(MINIMAP_MARGIN * this.pixelRatio)

    const pass = encoder.beginRenderPass({
      label: 'minimap',
      colorAttachments: [{ view: target.createView(), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: this.minimapDepthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    })
    pass.setViewport(x, y, size, size, 0, 1)
    pass.setScissorRect(x, y, size, size)
    pass.setPipeline(this.backgroundPipeline)
    pass.setBindGroup(0, this.minimapBindGroup)
    pass.draw(3)
    // Same draw arguments as the main view: what the culling removed is not drawn here either.
    this.drawCells(pass, this.minimapBindGroup)
    if (boxPipeline) this.drawBoxes(pass, this.minimapBindGroup, boxPipeline, cellCount)
    pass.setPipeline(this.linePipeline)
    pass.setBindGroup(0, this.minimapBindGroup)
    pass.setVertexBuffer(0, this.lineBuffer)
    pass.draw(24)
    pass.end()
  }

  /** The 12 edges of the culling camera's frustum, in world space. */
  private updateFrustumLines(camera: THREE.PerspectiveCamera): void {
    const corners: THREE.Vector3[] = []
    for (const z of [0, 1]) {
      for (const [x, y] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        corners.push(
          this.corner
            .set(x, y, z)
            .clone()
            .applyMatrix4(camera.projectionMatrixInverse)
            .applyMatrix4(camera.matrixWorld),
        )
      }
    }
    const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]
    edges.forEach((corner, i) => corners[corner].toArray(this.frustumLines, i * 3))
    this.device.queue.writeBuffer(this.lineBuffer, 0, this.frustumLines)
  }

  private encodeCapture(encoder: GPUCommandEncoder, target: GPUTexture): void {
    const resolve = this.pendingCapture
    this.pendingCapture = null
    if (!resolve) return
    const bytesPerRow = Math.ceil((this.width * 4) / 256) * 256
    const buffer = this.device.createBuffer({
      size: bytesPerRow * this.height,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [
      this.width,
      this.height,
    ])
    const { width, height } = this
    void this.device.queue.onSubmittedWorkDone().then(async () => {
      await buffer.mapAsync(GPUMapMode.READ)
      const bgra = new Uint8Array(buffer.getMappedRange().slice(0))
      buffer.destroy()
      resolve({ width, height, bgra })
    })
  }

  private readBack(index: number): void {
    const buffer = this.staging[index]
    this.stagingBusy[index] = true
    buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const data = buffer.getMappedRange().slice(0)
        buffer.unmap()
        this.stagingBusy[index] = false
        const counts = new Uint32Array(data, 0, 4)
        const s = this.stats
        s.selectedDraws = counts[0]
        s.visibleDraws = counts[1]
        s.visibleTriangles = counts[2]
        s.occludedDraws = counts[3]
        if (this.querySet) {
          const t = new BigUint64Array(data, 16, 4)
          const ms = (from: number, to: number) =>
            t[to] >= t[from] ? Number(t[to] - t[from]) / 1e6 : null
          s.cullMs = ms(0, 1)
          s.renderMs = ms(2, 3)
          s.gpuMs = s.cullMs !== null && s.renderMs !== null ? s.cullMs + s.renderMs : null
        }
      })
      .catch(() => {
        this.stagingBusy[index] = false
      })
  }
}
