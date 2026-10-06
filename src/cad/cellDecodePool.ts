import { MeshoptDecoder, decodeCell } from './cellDecode'
import DecodeWorker from './cellDecode.worker?worker'
import type { DecodedCell } from './types'

interface Pending {
  resolve: (cell: DecodedCell) => void
  reject: (error: Error) => void
  slot: number
}

/** Decodes cell chunks in one or two workers; falls back to the main thread if workers fail. */
export class CellDecodePool {
  private workers: { worker: Worker; busy: number }[] = []
  private pending = new Map<number, Pending>()
  private nextId = 1

  constructor(size = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 4) - 1))) {
    try {
      for (let i = 0; i < size; i++) {
        const worker = new DecodeWorker()
        worker.onmessage = (e: MessageEvent<{ id: number; cell?: DecodedCell; error?: string }>) => this.settle(i, e.data)
        worker.onerror = () => this.fail()
        this.workers.push({ worker, busy: 0 })
      }
    } catch {
      this.fail()
    }
  }

  /** `buf` is transferred to the worker; the caller must not use it afterwards. */
  decode(buf: ArrayBuffer): Promise<DecodedCell> {
    if (this.workers.length === 0) return MeshoptDecoder.ready.then(() => decodeCell(buf))
    let slot = 0
    for (let i = 1; i < this.workers.length; i++) if (this.workers[i].busy < this.workers[slot].busy) slot = i
    const id = this.nextId++
    this.workers[slot].busy++
    return new Promise<DecodedCell>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, slot })
      this.workers[slot].worker.postMessage({ id, buf }, [buf])
    })
  }

  dispose(): void {
    for (const { worker } of this.workers) worker.terminate()
    this.workers = []
    for (const job of this.pending.values()) job.reject(new Error('decode pool disposed'))
    this.pending.clear()
  }

  private settle(slot: number, data: { id: number; cell?: DecodedCell; error?: string }): void {
    const job = this.pending.get(data.id)
    if (!job) return
    this.pending.delete(data.id)
    this.workers[slot].busy--
    if (data.cell) job.resolve(data.cell)
    else job.reject(new Error(`cell decode failed in worker: ${data.error}`))
  }

  private fail(): void {
    console.warn('[CellDecodePool] decode worker failed; decoding on the main thread')
    this.dispose()
  }
}
