import { MeshoptDecoder, cellTransferList, decodeCell } from './cellDecode'

interface Job {
  id: number
  buf: ArrayBuffer
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

scope.onmessage = ({ data: { id, buf } }) => {
  MeshoptDecoder.ready
    .then(() => {
      const cell = decodeCell(buf)
      scope.postMessage({ id, cell }, cellTransferList(cell))
    })
    .catch((error: unknown) => scope.postMessage({ id, error: String(error) }))
}
