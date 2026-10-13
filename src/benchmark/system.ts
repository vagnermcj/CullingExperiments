/** Best-effort GPU name from the WebGPU adapter; browsers hide parts of it, so whatever is non-empty is joined. */
export const detectGpuName = async (): Promise<string> => {
  try {
    const adapter = await navigator.gpu?.requestAdapter()
    const info = adapter?.info
    if (!info) return 'Unknown GPU'
    const parts = [info.vendor, info.architecture, info.device, info.description].filter(Boolean)
    return parts.length > 0 ? [...new Set(parts)].join(' ') : 'Unknown GPU'
  } catch {
    return 'Unknown GPU'
  }
}
