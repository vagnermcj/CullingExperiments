export const PYRAMID_FORMAT: GPUTextureFormat = 'r32float'

const WORKGROUP_SIZE = 8
const DEBUG_UNIFORM_BYTES = 32

interface PyramidLevel {
  width: number
  height: number
  /** Source (the depth buffer or the level above) and this level as the storage target. */
  bindGroup: GPUBindGroup
}

/**
 * Hierarchical depth buffer (Hi-Z): a mip chain built from the main depth buffer, where each texel holds
 * a conservative depth for the block of pixels it covers. Level 0 is half the size of the depth buffer.
 *
 * This class is only the plumbing (texture, views, one dispatch per level); the reduction itself is in
 * `shaders/hiz.wgsl`.
 */
export class DepthPyramid {
  private readonly device: GPUDevice
  private readonly reduceLayout: GPUBindGroupLayout
  private readonly reducePipeline: GPUComputePipeline
  private readonly debugLayout: GPUBindGroupLayout
  private readonly debugPipeline: GPURenderPipeline
  private readonly debugUniform: GPUBuffer
  private readonly debugParams = new ArrayBuffer(DEBUG_UNIFORM_BYTES)
  private readonly debugFloats = new Float32Array(this.debugParams)
  private readonly debugInts = new Uint32Array(this.debugParams)

  private texture: GPUTexture | null = null
  private debugBindGroup: GPUBindGroup | null = null
  private allLevels: GPUTextureView | null = null
  private levels: PyramidLevel[] = []
  private totalBytes = 0

  constructor(
    device: GPUDevice,
    reduceModule: GPUShaderModule,
    debugModule: GPUShaderModule,
    targetFormat: GPUTextureFormat,
  ) {
    this.device = device

    // Explicit layouts: r32float and depth32float are not filterable, so the sample type has to say so.
    this.reduceLayout = device.createBindGroupLayout({
      label: 'depth pyramid reduce',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: PYRAMID_FORMAT },
        },
      ],
    })
    this.reducePipeline = device.createComputePipeline({
      label: 'depth pyramid reduce',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.reduceLayout] }),
      compute: { module: reduceModule, entryPoint: 'main' },
    })

    this.debugLayout = device.createBindGroupLayout({
      label: 'depth pyramid debug',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })
    this.debugPipeline = device.createRenderPipeline({
      label: 'depth pyramid debug',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.debugLayout] }),
      vertex: { module: debugModule, entryPoint: 'vs' },
      fragment: { module: debugModule, entryPoint: 'fs', targets: [{ format: targetFormat }] },
      primitive: { topology: 'triangle-list' },
    })
    this.debugUniform = device.createBuffer({
      label: 'depth pyramid debug params',
      size: DEBUG_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  }

  get mipCount(): number {
    return this.levels.length
  }

  get bytes(): number {
    return this.totalBytes
  }

  /** Every level, for reading in a shader (unfilterable float); a new view after each `rebuild`. */
  get view(): GPUTextureView {
    if (!this.allLevels) throw new Error('The depth pyramid has not been built yet.')
    return this.allLevels
  }

  /** Recreates the pyramid for a (new) depth buffer; call whenever the depth texture is recreated. */
  rebuild(depth: GPUTexture): void {
    const { device } = this
    this.texture?.destroy()

    const width = Math.max(1, depth.width >> 1)
    const height = Math.max(1, depth.height >> 1)
    const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1
    const texture = device.createTexture({
      label: 'depth pyramid',
      size: [width, height],
      format: PYRAMID_FORMAT,
      mipLevelCount,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.texture = texture

    this.levels = []
    this.totalBytes = 0
    let source = depth.createView({ label: 'depth as pyramid source' })
    for (let level = 0; level < mipLevelCount; level++) {
      const target = texture.createView({
        label: `depth pyramid level ${level}`,
        baseMipLevel: level,
        mipLevelCount: 1,
      })
      const levelWidth = Math.max(1, width >> level)
      const levelHeight = Math.max(1, height >> level)
      this.levels.push({
        width: levelWidth,
        height: levelHeight,
        bindGroup: device.createBindGroup({
          label: `depth pyramid level ${level}`,
          layout: this.reduceLayout,
          entries: [
            { binding: 0, resource: source },
            { binding: 1, resource: target },
          ],
        }),
      })
      this.totalBytes += levelWidth * levelHeight * 4
      source = target
    }

    this.allLevels = texture.createView({ label: 'depth pyramid, all levels' })
    this.debugBindGroup = device.createBindGroup({
      label: 'depth pyramid debug',
      layout: this.debugLayout,
      entries: [
        { binding: 0, resource: this.allLevels },
        { binding: 1, resource: { buffer: this.debugUniform } },
      ],
    })
  }

  /**
   * Builds every level from the depth buffer given to `rebuild`. The depth buffer must not be an
   * attachment at this point, so this goes between render passes.
   */
  encode(encoder: GPUCommandEncoder): void {
    if (this.levels.length === 0) return
    // One pass is enough: each dispatch is its own usage scope, and level n - 1 (read) and level n
    // (written) are different subresources of the texture.
    const pass = encoder.beginComputePass({ label: 'depth pyramid' })
    pass.setPipeline(this.reducePipeline)
    for (const level of this.levels) {
      pass.setBindGroup(0, level.bindGroup)
      pass.dispatchWorkgroups(
        Math.ceil(level.width / WORKGROUP_SIZE),
        Math.ceil(level.height / WORKGROUP_SIZE),
      )
    }
    pass.end()
  }

  /** Debug: paints one level over the whole target, as linear depth. */
  encodeDebugView(
    encoder: GPUCommandEncoder,
    target: GPUTexture,
    mip: number,
    near: number,
    far: number,
  ): void {
    if (!this.debugBindGroup) return
    this.debugFloats[0] = target.width
    this.debugFloats[1] = target.height
    this.debugFloats[2] = near
    this.debugFloats[3] = far
    this.debugInts[4] = Math.min(Math.max(0, Math.floor(mip)), this.levels.length - 1)
    this.device.queue.writeBuffer(this.debugUniform, 0, this.debugParams)

    const pass = encoder.beginRenderPass({
      label: 'depth pyramid debug',
      colorAttachments: [{ view: target.createView(), loadOp: 'load', storeOp: 'store' }],
    })
    pass.setPipeline(this.debugPipeline)
    pass.setBindGroup(0, this.debugBindGroup)
    pass.draw(3)
    pass.end()
  }
}
