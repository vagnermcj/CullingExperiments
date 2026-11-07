export interface GpuDevice {
  device: GPUDevice
  /** True when `timestamp-query` is available, so passes can be timed on the GPU. */
  timestamps: boolean
}

export const requestGpuDevice = async (onLost: (message: string) => void): Promise<GpuDevice> => {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.')
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('No WebGPU adapter was found.')

  const timestamps = adapter.features.has('timestamp-query')
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] })

  device.addEventListener('uncapturederror', (event) => console.error('[WebGPU]', (event as GPUUncapturedErrorEvent).error.message))
  void device.lost.then((info) => {
    if (info.reason !== 'destroyed') onLost(info.message || 'The GPU device was lost.')
  })
  return { device, timestamps }
}
