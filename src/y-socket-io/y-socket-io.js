import * as Y from 'yjs'
import * as AwarenessProtocol from 'y-protocols/awareness'
import * as promise from 'lib0/promise'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { assert } from 'lib0/testing'
import * as api from '../api.js'
import * as protocol from '../protocol.js'
import * as number from 'lib0/number'
import * as env from 'lib0/environment'
import { createSubscriber } from '../subscriber.js'
import { isDeepStrictEqual } from 'util'
import { User } from './user.js'
import { createModuleLogger } from 'lib0/logging'
import toobusy from 'toobusy-js'
import { promiseWithResolvers } from './utils.js'
import { ClientClosedError } from 'redis'

const logSocketIO = createModuleLogger('@y/socket-io/server')
const PERSIST_INTERVAL = number.parseInt(env.getConf('y-socket-io-server-persist-interval') || '3000')
const MAX_PERSIST_INTERVAL = number.parseInt(env.getConf('y-socket-io-server-max-persist-interval') || '30000')
const REVALIDATE_TIMEOUT = number.parseInt(env.getConf('y-socket-io-server-revalidate-timeout') || '60000')
const WORKER_DISABLED = env.getConf('y-worker-disabled') === 'true'
const DEFAULT_CLEAR_TIMEOUT = number.parseInt(env.getConf('y-socket-io-default-clear-timeout') || '30000')
const WORKER_HEALTH_CHECK_INTERVAL = number.parseInt(env.getConf('y-socket-io-worker-health-check-interval') || '5000')
const NEVER_REJECT_CONNECTION = env.getConf('y-socket-io-never-reject-connection') === 'true'

process.on('SIGINT', function () {
  // calling .shutdown allows your process to exit normally
  toobusy.shutdown()
  process.exit()
})

/**
 * @typedef {import('socket.io').Namespace} Namespace
 * @typedef {import('socket.io').Socket} Socket
 * @typedef {import('socket.io').Server} Server
 *
 * @typedef {import('../subscriber.js').Subscriber} Subscriber
 */

/**
 * @typedef UserLike
 * @prop {string} userid
 *
 * @typedef {'sync-step-1' | 'sync-step-2' | 'sync-update' | 'awareness-update'} EventType
 *
 * @typedef {{
 *   ydoc: Y.Doc;
 *   awareness: AwarenessProtocol.Awareness | null;
 *   redisLastId: string;
 *   storeReferences: any[] | null;
 * }} RedisDoc
 */

/**
 * @typedef YSocketIOConfiguration
 * YSocketIO instance configuration. Here you can configure:
 * - authenticate: The callback to authenticate the client connection
 *
 * @prop {(socket: Socket)=> Promise<UserLike | null> | UserLike | null} authenticate
 * Callback to authenticate the client connection.
 * @prop {boolean=} enableAwareness
 * Enable/disable awareness functionality, defaults to true
 */

/**
 * YSocketIO class. This handles document synchronization.
 */
export class YSocketIO {
  /**
   * @type {Server}
   * @private
   * @readonly
   */
  io
  /**
   * @type {YSocketIOConfiguration}
   * @private
   * @readonly
   */
  configuration
  /**
   * @type {Namespace | null}
   * @public
   */
  nsp = null
  /**
   * @type {api.Api | null}
   * @private
   */
  client = null
  /**
   * @type {Subscriber | null}
   * @private
   */
  subscriber = null
  /**
   * @type {Map<string, string>}
   * @private
   * @readonly
   */
  namespaceStreamMap = new Map()
  /**
   * @type {Map<string, string>}
   * @private
   * @readonly
   */
  streamNamespaceMap = new Map()
  /**
   * @type {Map<string, Namespace>}
   * @private
   * @readonly
   */
  namespaceMap = new Map()
  /**
   * @type {Map<string, RedisDoc>}
   * @private
   * @readonly
   */
  namespaceDocMap = new Map()
  /**
   * @type {Map<Socket, { user: UserLike, validatedAt: number }>}
   * @private
   * @readonly
   */
  socketUserCache = new Map()
  /**
   * @type {Map<string, NodeJS.Timeout | null>}
   * @private
   * @readonly
   */
  debouncedPersistMap = new Map()
  /**
   * @type {Map<string, number>}
   * @private
   * @readonly
   */
  namespacePersistentMap = new Map()
  /**
   * @type {Map<string, { promise: Promise<void>, resolve: () => void }>}
   * @private
   * @readonly
   */
  awaitingPersistMap = new Map()
  /**
   * @type {Map<string, NodeJS.Timeout>}
   * @private
   * @readonly
   */
  awaitingCleanupNamespace = new Map()
  /**
   * @type {boolean}
   * @private
   */
  workerReady = false
  /**
   * @type {number | null}
   * @private
   */
  workerLastHeartbeat = null
  /**
   * @type {{ promise: Promise<boolean>, resolve: (result: boolean) => void } | null}
   * @private
   */
  workerHeartbeatContext = null
  /**
   * @type {NodeJS.Timeout | null}
   * @private
   */
  persistWorkerHealthCheckTimeout = null

  /**
   * YSocketIO constructor.
   * @constructor
   * @param {Server} io Server instance from Socket IO
   * @param {YSocketIOConfiguration} configuration The YSocketIO configuration
   */
  constructor (io, configuration) {
    this.io = io
    this.configuration = {
      enableAwareness: true,
      ...configuration
    }
  }

  /**
   * YSocketIO initialization.
   *
   *  This method set ups a dynamic namespace manager for namespaces that match with the regular expression `/^\/yjs\|.*$/`
   *  and adds the connection authentication middleware to the dynamics namespaces.
   *
   *  It also starts socket connection listeners.
   * @param {import('../storage.js').AbstractStorage} store
   * @param {{ redisPrefix?: string, redisUrl?: string, getPersistWorker?: () => import('worker_threads').Worker }=} opts
   * @public
   */
  async initialize (store, { redisUrl, redisPrefix = 'y', getPersistWorker } = {}) {
    const { enableAwareness } = this.configuration
    const [client, subscriber] = await promise.all([
      api.createApiClient(store, { redisUrl, redisPrefix, enableAwareness }),
      createSubscriber(store, { redisUrl, redisPrefix, enableAwareness })
    ])
    this.client = client
    this.subscriber = subscriber
    if (getPersistWorker) {
      this.getPersistWorker = getPersistWorker
      this.persistWorker = getPersistWorker()
      this.registerPersistWorkerResolve()
      this.registerPersistWorkerHealthCheck()
    }

    this.nsp = this.io.of(/^\/yjs\|.*$/)

    this.nsp.use(async (socket, next) => {
      if (this.configuration.authenticate === null) return next()
      const userCache = this.socketUserCache.get(socket)
      const namespace = this.getNamespaceString(socket.nsp)
      if (!userCache || Date.now() - userCache.validatedAt > REVALIDATE_TIMEOUT) {
        this.socketUserCache.delete(socket)
        const user = await this.configuration.authenticate(socket)
        if (!user) return next(new Error('Unauthorized'))
        this.socketUserCache.set(socket, { user, validatedAt: Date.now() })
        socket.user = new User(namespace, user.userid)
      } else {
        socket.user = new User(namespace, userCache.user.userid)
      }

      if (socket.user) return next()
      else return next(new Error('Unauthorized'))
    })

    this.nsp.on('connection', async (socket) => {
      assert(this.client)
      assert(this.subscriber)
      const namespace = this.getNamespaceString(socket.nsp)
      if (!NEVER_REJECT_CONNECTION && toobusy()) {
        logSocketIO(`warning server too busy, rejecting connection: ${namespace}`)
        // wait a bit to prevent client reconnect too fast
        await promise.wait(100)
        socket.send('server too busy, please try again latter')
        socket.disconnect(true)
        return
      }
      if (!socket.user) throw new Error('user does not exist in socket')

      logSocketIO(`new connection in namespace: ${namespace}`)
      const stream = api.computeRedisRoomStreamName(
        namespace,
        'index',
        redisPrefix
      )
      const prevAwaitCleanup = this.awaitingCleanupNamespace.get(namespace)
      if (prevAwaitCleanup) {
        clearTimeout(prevAwaitCleanup)
        this.cleanupNamespace(namespace, stream)
      }

      if (!this.namespaceMap.has(namespace)) {
        this.namespaceMap.set(namespace, socket.nsp)
      }
      socket.user.subs.add(stream)
      socket.user.initialRedisSubId = subscriber.subscribe(
        stream,
        this.redisMessageSubscriber
      ).redisId
      this.namespaceStreamMap.set(namespace, stream)
      this.streamNamespaceMap.set(stream, namespace)

      this.initSyncListeners(socket)
      if (this.configuration.enableAwareness) {
        this.initAwarenessListeners(socket)
      }
      this.initSocketListeners(socket)
      ;(async () => {
        assert(this.client)
        assert(socket.user)
        const doc = (WORKER_DISABLED && this.namespaceDocMap.get(namespace)) || (await this.client.getDoc(namespace, 'index'))
        if (WORKER_DISABLED) this.namespaceDocMap.set(namespace, doc)

        if (
          api.isSmallerRedisId(doc.redisLastId, socket.user.initialRedisSubId)
        ) {
          // our subscription is newer than the content that we received from the api
          // need to renew subscription id and make sure that we catch the latest content.
          this.subscriber?.ensureSubId(stream, doc.redisLastId)
        }
        this.startSynchronization(socket, doc)
      })()
    })

    return { client, subscriber }
  }

  /**
   * This function initializes the socket event listeners to synchronize document changes.
   *
   *  The synchronization protocol is as follows:
   *  - A client emits the sync step one event (`sync-step-1`) which sends the document as a state vector
   *    and the sync step two callback as an acknowledgment according to the socket io acknowledgments.
   *  - When the server receives the `sync-step-1` event, it executes the `syncStep2` acknowledgment callback and sends
   *    the difference between the received state vector and the local document (this difference is called an update).
   *  - The second step of the sync is to apply the update sent in the `syncStep2` callback parameters from the server
   *    to the document on the client side.
   *  - There is another event (`sync-update`) that is emitted from the client, which sends an update for the document,
   *    and when the server receives this event, it applies the received update to the local document.
   *  - When an update is applied to a document, it will fire the document's "update" event, which
   *    sends the update to clients connected to the document's namespace.
   * @private
   * @param {Socket} socket The socket connection
   * @readonly
   */
  initSyncListeners = (socket) => {
    socket.on(
      'sync-step-1',
      async (
        /** @type {Uint8Array} */
        stateVector,
        /** @type {(update: Uint8Array) => void} */
        syncStep2
      ) => {
        assert(this.client)
        const namespace = this.getNamespaceString(socket.nsp)
        const doc = (WORKER_DISABLED && this.namespaceDocMap.get(namespace)) || (await this.client.getDoc(namespace, 'index'))
        if (WORKER_DISABLED) this.namespaceDocMap.set(namespace, doc)
        assert(doc)
        syncStep2(Y.encodeStateAsUpdate(doc.ydoc, stateVector))
      }
    )

    /** @type {unknown} */
    let prevMsg = null
    socket.on('sync-update', (/** @type {ArrayBuffer} */ update) => {
      if (isDeepStrictEqual(update, prevMsg)) return
      assert(this.client)
      const namespace = this.getNamespaceString(socket.nsp)
      const message = Buffer.from(update.slice(0, update.byteLength))
      this.client
        .addMessage(
          namespace,
          'index',
          Buffer.from(this.toRedis('sync-update', message))
        )
        .catch(console.error)
      prevMsg = update
    })
  }

  /**
   * This function initializes socket event listeners to synchronize awareness changes.
   *
   *  The awareness protocol is as follows:
   *  - A client emits the `awareness-update` event by sending the awareness update.
   *  - The server receives that event and applies the received update to the local awareness.
   *  - When an update is applied to awareness, the awareness "update" event will fire, which
   *    sends the update to clients connected to the document namespace.
   * @private
   * @param {Socket} socket The socket connection
   * @readonly
   */
  initAwarenessListeners = (socket) => {
    /** @type {unknown} */
    const prevMsg = null
    socket.on('awareness-update', (/** @type {ArrayBuffer} */ update) => {
      if (isDeepStrictEqual(update, prevMsg)) return
      assert(this.client)
      const message = Buffer.from(update.slice(0, update.byteLength))
      this.client
        .addMessage(
          this.getNamespaceString(socket.nsp),
          'index',
          Buffer.from(this.toRedis('awareness-update', new Uint8Array(message)))
        )
        .catch(console.error)
    })
  }

  /**
   *  This function initializes socket event listeners for general purposes.
   * @private
   * @param {Socket} socket The socket connection
   * @readonly
   */
  initSocketListeners = (socket) => {
    socket.on('disconnect', async () => {
      assert(this.subscriber)
      if (!socket.user) return
      this.socketUserCache.delete(socket)
      for (const stream of socket.user.subs) {
        const ns = this.streamNamespaceMap.get(stream)
        if (!ns) continue
        const nsp = this.namespaceMap.get(ns)
        if (nsp?.sockets.size === 0 && stream) {
          this.cleanupNamespace(ns, stream, DEFAULT_CLEAR_TIMEOUT)
          if (this.namespaceDocMap.has(ns)) this.debouncedPersist(ns, true)
        }
        logSocketIO(`disconnecting socket in ${ns}, ${nsp?.sockets.size || 0} remaining`)
      }
    })
    socket.onAnyOutgoing(async (ev) => {
      if (ev !== 'reload') return
      if (!WORKER_DISABLED) return
      const namespace = this.getNamespaceString(socket.nsp)
      logSocketIO(`reload event triggered, updating namespace doc in: ${namespace}`)
      assert(this.client)
      const doc = await this.client.getDoc(namespace, 'index')
      this.namespaceDocMap.set(namespace, doc)
    })
  }

  /**
   * This function is called when a client connects and it emit the `sync-step-1` and `awareness-update`
   * events to the client to start the sync.
   * @private
   * @param {Socket} socket The socket connection
   * @param {RedisDoc} doc The document
   */
  startSynchronization = (socket, doc) => {
    socket.emit(
      'sync-step-1',
      Y.encodeStateVector(doc.ydoc),
      (/** @type {Uint8Array} */ update) => {
        assert(this.client)
        const message = Buffer.from(update.slice(0, update.byteLength))
        this.client
          .addMessage(
            this.getNamespaceString(socket.nsp),
            'index',
            Buffer.from(this.toRedis('sync-step-2', message))
          )
          .catch(console.error)
      }
    )
    if (this.configuration.enableAwareness && doc.awareness && doc.awareness.states.size > 0) {
      socket.emit(
        'awareness-update',
        AwarenessProtocol.encodeAwarenessUpdate(
          doc.awareness,
          Array.from(doc.awareness.getStates().keys())
        )
      )
    }
  }

  /**
   * @private
   * @param {string} stream
   * @param {Array<Uint8Array>} messages
   */
  redisMessageSubscriber = async (stream, messages) => {
    const namespace = this.streamNamespaceMap.get(stream)
    if (!namespace) return
    const nsp = this.namespaceMap.get(namespace)
    if (!nsp) return
    if (nsp.sockets.size === 0 && this.subscriber) {
      this.cleanupNamespace(namespace, stream, DEFAULT_CLEAR_TIMEOUT)
    }

    /** @type {Uint8Array[]} */
    const updates = []
    /** @type {Uint8Array[]} */
    const awareness = []

    for (const m of messages) {
      const decoded = this.fromRedis(m)
      if (decoded.type === 'awareness-update' && this.configuration.enableAwareness) awareness.push(decoded.message)
      else updates.push(decoded.message)
    }

    for (const msg of updates) {
      if (msg.length === 0) continue
      nsp.emit('sync-update', msg)
    }
    for (const msg of awareness) {
      if (msg.length === 0) continue
      nsp.emit('awareness-update', msg)
    }

    if (!WORKER_DISABLED) return

    let changed = false
    const existDoc = this.namespaceDocMap.get(namespace)
    if (existDoc) {
      existDoc.ydoc.on('afterTransaction', (tr) => {
        changed = tr.changed.size > 0
      })
      Y.transact(existDoc.ydoc, () => {
        for (const msg of updates) {
          if (msg.length === 0) continue
          Y.applyUpdate(existDoc.ydoc, msg)
        }
        if (existDoc.awareness) {
          for (const msg of awareness) {
            if (msg.length === 0) continue
            AwarenessProtocol.applyAwarenessUpdate(existDoc.awareness, msg, null)
          }
        }
      })
    }

    assert(this.client)
    let doc = existDoc
    if (!existDoc) {
      const getDoc = await this.client.getDoc(namespace, 'index')
      doc = getDoc
      changed = getDoc.changed
    }
    assert(doc)
    const lastPersistCalledAt = this.namespacePersistentMap.get(namespace) ?? 0
    const now = Date.now()
    const shouldPersist = now - lastPersistCalledAt > MAX_PERSIST_INTERVAL
    if (changed || shouldPersist || nsp.sockets.size === 0) {
      this.namespacePersistentMap.set(namespace, now)
      this.debouncedPersist(namespace, nsp.sockets.size === 0)
    }
    this.namespaceDocMap.get(namespace)?.ydoc.destroy()
    this.namespaceDocMap.set(namespace, doc)
  }

  /**
   * @param {string} namespace
   * @param {boolean=} immediate
   */
  debouncedPersist (namespace, immediate = false) {
    if (this.debouncedPersistMap.has(namespace)) {
      if (!immediate) return
      clearTimeout(this.debouncedPersistMap.get(namespace) || undefined)
    }
    const timeoutInterval = immediate
      ? 0
      : PERSIST_INTERVAL + (Math.random() - 0.5) * PERSIST_INTERVAL
    const timeout = setTimeout(
      async () => {
        // wait for previous persisting operation if exists
        const prev = this.awaitingPersistMap.get(namespace)
        if (prev?.promise) await prev.promise
        // delete persist entry to allow queueing next persisting operation
        // we can delete it here because the following until awaiting persist
        // are all synchronize operations
        this.debouncedPersistMap.delete(namespace)

        try {
          assert(this.client)
          const doc = this.namespaceDocMap.get(namespace)?.ydoc
          logSocketIO(`trying to persist ${namespace}`)
          if (!doc) return
          if (this.persistWorker && this.workerReady) {
            /** @type {ReturnType<typeof promiseWithResolvers<void>>} */
            const { promise, resolve } = promiseWithResolvers()
            this.awaitingPersistMap.set(namespace, { promise, resolve })

            const docState = Y.encodeStateAsUpdateV2(doc)
            const buf = new Uint8Array(new SharedArrayBuffer(docState.length))
            buf.set(docState)
            this.persistWorker.postMessage({
              room: namespace,
              docstate: buf
            })
            await promise
          } else {
            const promise = this.client.store.persistDoc(namespace, 'index', doc)
            this.awaitingPersistMap.set(namespace, { promise, resolve: () => {} })
            await promise
          }

          await this.client.trimRoomStream(namespace, 'index')
        } catch (e) {
          // suppress redis client closed error
          if (!(e instanceof ClientClosedError)) {
            console.error(e)
          }
        }
      },
      timeoutInterval
    )

    this.debouncedPersistMap.set(namespace, timeout)
  }

  /**
   * @param {Namespace} namespace
   */
  getNamespaceString (namespace) {
    return namespace.name.replace(/\/yjs\|/, '')
  }

  /**
   * @param {Uint8Array | ArrayBuffer | Buffer} message
   * @returns {{ type: EventType, message: Uint8Array }}
   */
  fromRedis (message) {
    const decoder = decoding.createDecoder(new Uint8Array(message))
    const opt = decoding.readUint8(decoder)

    switch (opt) {
      case protocol.messageSync: {
        const syncStep = decoding.readUint8(decoder)
        const message = decoding.readVarUint8Array(decoder)
        switch (syncStep) {
          case protocol.messageSyncStep1:
            return {
              type: 'sync-step-1',
              message
            }
          case protocol.messageSyncStep2:
            return {
              type: 'sync-step-2',
              message
            }
          case protocol.messageSyncUpdate:
            return {
              type: 'sync-update',
              message
            }
        }
        break
      }
      case protocol.messageAwareness: {
        const message = decoding.readVarUint8Array(decoder)
        return {
          type: 'awareness-update',
          message
        }
      }
    }
    throw new Error('unknown encoding')
  }

  /**
   * @param {EventType} type
   * @param {Uint8Array | ArrayBuffer | Buffer} message
   */
  toRedis (type, message) {
    return encoding.encode((encoder) => {
      switch (type) {
        case 'sync-step-1':
          encoding.writeVarUint(encoder, protocol.messageSync)
          encoding.writeVarUint(encoder, protocol.messageSyncStep1)
          break
        case 'sync-step-2':
          encoding.writeVarUint(encoder, protocol.messageSync)
          encoding.writeVarUint(encoder, protocol.messageSyncStep2)
          break
        case 'sync-update':
          encoding.writeVarUint(encoder, protocol.messageSync)
          encoding.writeVarUint(encoder, protocol.messageSyncUpdate)
          break
        case 'awareness-update':
          encoding.writeVarUint(encoder, protocol.messageAwareness)
          break
      }
      encoding.writeVarUint8Array(encoder, new Uint8Array(message))
    })
  }

  destroy () {
    try {
      if (this.persistWorkerHealthCheckTimeout) {
        clearInterval(this.persistWorkerHealthCheckTimeout)
      }
      this.subscriber?.destroy()
      return this.client?.destroy()
    } catch (e) {
      console.error(e)
    }
  }

  registerPersistWorkerResolve () {
    if (!this.persistWorker) return
    this.persistWorker.on('message', ({ event, room }) => {
      if (event === 'persisted') this.awaitingPersistMap.get(room)?.resolve()
      if (event === 'pong' && this.workerHeartbeatContext) {
        this.workerHeartbeatContext.resolve(true)
      }
      this.workerReady = true
    })
  }

  /**
   * @param {string} namespace
   * @param {string} stream
   * @param {number=} removeAfterWait
   */
  cleanupNamespace (namespace, stream, removeAfterWait) {
    if (!removeAfterWait) {
      this.awaitingCleanupNamespace.delete(namespace)
      return this.cleanupNamespaceImpl(namespace, stream)
    }
    if (this.awaitingCleanupNamespace.has(namespace)) return

    const timer = setTimeout(async () => {
      const awaitingPersist = this.awaitingPersistMap.get(namespace)
      if (awaitingPersist) await awaitingPersist.promise
      this.cleanupNamespaceImpl(namespace, stream)
      this.awaitingCleanupNamespace.delete(namespace)
      logSocketIO(`no active connection, namespace: ${namespace} cleared`)
    }, removeAfterWait)
    this.awaitingCleanupNamespace.set(namespace, timer)
  }

  /**
   * @param {string} namespace
   * @param {string} stream
   * @private
   */
  cleanupNamespaceImpl (namespace, stream) {
    this.subscriber?.unsubscribe(stream, this.redisMessageSubscriber)
    this.namespaceStreamMap.delete(namespace)
    this.streamNamespaceMap.delete(stream)
    this.namespaceMap.delete(namespace)
    this.namespaceDocMap.get(namespace)?.ydoc.destroy()
    this.namespaceDocMap.delete(namespace)
    this.namespacePersistentMap.delete(namespace)
  }

  async waitUntilWorkerReady () {
    if (!this.persistWorker || this.workerReady) return
    /** @type {ReturnType<typeof promiseWithResolvers<void>>} */
    const { promise, resolve } = promiseWithResolvers()
    const timer = setInterval(() => {
      if (!this.workerReady) return
      clearInterval(timer)
      resolve()
    }, 100)
    await promise
  }

  registerPersistWorkerHealthCheck () {
    this.persistWorkerHealthCheckTimeout = setTimeout(async () => {
      const workerHealth = await this.workerHealthCheck()
      if (!workerHealth) {
        logSocketIO('worker thread is unhealthy, recreating')
        assert(this.getPersistWorker)
        this.workerReady = false
        await this.persistWorker?.removeAllListeners().terminate()
        this.persistWorker = this.getPersistWorker()
        this.registerPersistWorkerResolve()
        await this.waitUntilWorkerReady()
      }
      this.registerPersistWorkerHealthCheck()
    }, WORKER_HEALTH_CHECK_INTERVAL)
  }

  async workerHealthCheck () {
    if (!this.persistWorker || this.workerHeartbeatContext) return null
    if (
      this.workerLastHeartbeat &&
      Date.now() - this.workerLastHeartbeat < WORKER_HEALTH_CHECK_INTERVAL * 2
    ) {
      return true
    }

    /** @type {ReturnType<typeof promiseWithResolvers<boolean>>} */
    const { promise: heartbeatPromise, resolve } = promiseWithResolvers()
    this.workerHeartbeatContext = { promise: heartbeatPromise, resolve }
    const now = performance.now()
    this.persistWorker.postMessage({ event: 'ping' })
    const health = await Promise.race([
      heartbeatPromise,
      promise.wait(3000).then(() => false)
    ])
    this.workerHeartbeatContext = null
    if (health) {
      logSocketIO(`worker health check: responded in ${performance.now() - now}ms`)
      this.workerLastHeartbeat = Date.now()
    }
    return health
  }
}
