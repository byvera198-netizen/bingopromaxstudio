import { generateBatch, type BingoBlock } from './bingo'

type WorkerRequest = { campaign: string; totalSheets: number; startingPage?: number }
type WorkerResponse =
  | { type: 'progress'; percent: number }
  | { type: 'complete'; blocks: BingoBlock[] }
  | { type: 'error'; message: string }

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: WorkerResponse) => void
}

workerScope.onmessage = (event) => {
  try {
    const request = event.data
    const blocks = generateBatch(request.campaign, request.totalSheets, request.startingPage ?? 1, (percent) => {
      workerScope.postMessage({ type: 'progress', percent })
    })
    workerScope.postMessage({ type: 'complete', blocks })
  } catch (error) {
    workerScope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'No se pudo generar el lote.' })
  }
}

export {}
