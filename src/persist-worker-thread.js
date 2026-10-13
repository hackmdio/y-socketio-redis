import * as Y from 'yjs'
import * as logging from 'lib0/logging'
import { isMainThread, parentPort } from 'worker_threads'

export class PersistWorkerThread {
  /**
   * @private
   * @readonly
   */
  log = logging.createModuleLogger('@y/persist-worker-thread')

  /**
   * @param {import('./storage.js').AbstractStorage} store
   */
  constructor (store) {
    if (isMainThread) {
      this.log('persist worker cannot run on main thread')
      return
    }
    this.store = store
    parentPort?.postMessage({ event: 'ready' })
    parentPort?.on('message', ({ event, ...rest }) => {
      if (event === 'ping') parentPort?.postMessage({ event: 'pong' })
      else if (event === undefined || event === 'persist') this.persist(rest)
    })
  }

  /**
   * @param {{ room: string, requestId: string, docstate: Uint8Array }} props
   */
  persist = async ({ room, requestId, docstate }) => {
    this.log(`persisting ${room} in worker`)
    const state = new Uint8Array(docstate)
    const doc = new Y.Doc()
    try {
      Y.applyUpdateV2(doc, state)
      if (!this.store) throw new Error('Persistence storage is unavailable')
      await this.store.persistDoc(room, 'index', doc)
      parentPort?.postMessage({ event: 'persisted', room, requestId })
    } catch (error) {
      parentPort?.postMessage({ event: 'persist-error', room, requestId, error: String(error) })
    } finally {
      doc.destroy()
    }
  }
}

/**
 * @param {import('./storage.js').AbstractStorage} store
 */
export function createPersistWorkerThread (store) {
  if (isMainThread) throw new Error('cannot create persist worker in main thread')
  return new PersistWorkerThread(store)
}
