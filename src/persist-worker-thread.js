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
      else this.persist(rest)
    })
  }

  /**
   * @param {{ room: string, docstate: SharedArrayBuffer }} props
   */
  persist = async ({ room, docstate }) => {
    this.log(`persisting ${room} in worker`)
    const state = new Uint8Array(docstate)
    const doc = new Y.Doc()
    Y.applyUpdateV2(doc, state)
    await this.store?.persistDoc(room, 'index', doc)
    doc.destroy()
    parentPort?.postMessage({ event: 'persisted', room })
  }
}

/**
 * @param {import('./storage.js').AbstractStorage} store
 */
export function createPersistWorkerThread (store) {
  if (isMainThread) throw new Error('cannot create persist worker in main thread')
  return new PersistWorkerThread(store)
}
