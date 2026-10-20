import { generateBatchChunk, type BingoBlock } from './bingo'

type WorkerRequest = { campaign: string; totalSheets: number; startingPage?: number; startingBlockNumber?: number; chunkSheets?: number; usedSignatures?: string[] }
type WorkerResponse =
  | { type: 'progress'; percent: number }
  | { type: 'chunk'; blocks: BingoBlock[]; completedSheets: number; nextPage: number; nextBlockNumber: number }
  | { type: 'complete'; completedSheets: number }
  | { type: 'error'; message: string }

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: WorkerResponse) => void
}

workerScope.onmessage = (event) => {
  try {
    const request = event.data
    const chunkSheets = Math.max(40, Math.min(400, request.chunkSheets ?? 400))
    const usedSignatures = new Set(request.usedSignatures ?? [])
    let remaining = request.totalSheets
    let completedSheets = 0
    let nextPage = request.startingPage ?? 1
    let nextBlockNumber = request.startingBlockNumber ?? 1

    while (remaining > 0) {
      const currentSheets = Math.min(chunkSheets, remaining)
      const blocks = generateBatchChunk(request.campaign, currentSheets, nextPage, nextBlockNumber, usedSignatures, (percent) => {
        const overall = Math.round(((completedSheets + (percent / 100) * currentSheets) / request.totalSheets) * 100)
        workerScope.postMessage({ type: 'progress', percent: Math.min(99, overall) })
      })
      completedSheets += currentSheets
      nextPage += currentSheets
      nextBlockNumber += blocks.length
      remaining -= currentSheets
      workerScope.postMessage({ type: 'chunk', blocks, completedSheets, nextPage, nextBlockNumber })
    }
    workerScope.postMessage({ type: 'complete', completedSheets })
  } catch (error) {
    workerScope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'No se pudo generar el lote.' })
  }
}

export {}
