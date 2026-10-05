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
import { randomUUID } from 'crypto'

const logSocketIO = createModuleLogger('@y/socket-io/server')
const PERSIST_INTERVAL = number.parseInt(env.getConf('y-socket-io-server-persist-interval') || '3000')
const MAX_PERSIST_INTERVAL = number.parseInt(env.getConf('y-socket-io-server-max-persist-interval') || '30000')
const REVALIDATE_TIMEOUT = number.parseInt(env.getConf('y-socket-io-server-revalidate-timeout') || '60000')
const WORKER_DISABLED = env.getConf('y-worker-disabled') === 'true'
const DEFAULT_CLEAR_TIMEOUT = number.parseInt(env.getConf('y-socket-io-default-clear-timeout') || '30000')
const WORKER_HEALTH_CHECK_INTERVAL = number.parseInt(env.getConf('y-socket-io-worker-health-check-interval') || '5000')
const NEVER_REJECT_CONNECTION = env.getConf('y-socket-io-never-reject-connection') === 'true'
const PERSIST_LEADER_HEARTBEAT_INTERVAL = number.parseInt(env.getConf('y-socket-io-server-persist-leader-heartbeat-interval') || '5000')

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
   * @type {Map<string, { room: string, worker: import('worker_threads').Worker, resolve: () => void, reject: (error: Error) => void }>}
   * @private
   */
  workerPersistRequests = new Map()
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
   * @type {NodeJS.Timeout | null}
   * @private
   */
  persistentHeartbeatTimeout = null
  /**
   * Acquisition tokens, not server IDs: an expired lease must never be reused.
   * @type {Map<string, string>}
   * @private
   */
  persistentLeaderOf = new Map()
  /** @type {Map<string, Promise<boolean>>} */
  pendingLeaderAcquisitions = new Map()
  destroyed = false
  /**
   * @type {string}
   * @private
   */
  serverId = randomUUID()

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

    this.registerPersistentLeaderHeartbeat()

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
      this.cancelNamespaceCleanup(namespace)

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
        await this.tryAcquirePersistentLeader(namespace)
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

    socket.on('sync-update', (/** @type {ArrayBuffer} */ update, /** @type {() => void} */ ack) => {
      // Retries are safe to append: Yjs updates are idempotent. Every ACK must
      // follow its own successful append, including overlapping retries.
      assert(this.client)
      const namespace = this.getNamespaceString(socket.nsp)
      const message = Buffer.from(update.slice(0, update.byteLength))
      this.client
        .addMessage(
          namespace,
          'index',
          Buffer.from(this.toRedis('sync-update', message))
        )
        .then(() => ack())
        .catch(console.error)
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
      const isLeader = this.persistentLeaderOf.has(namespace)
      this.cleanupNamespace(namespace, stream, DEFAULT_CLEAR_TIMEOUT, isLeader)
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
      existDoc.ydoc.once('afterTransaction', (tr) => {
        changed = tr.changed.size > 0 || tr.doc.store.pendingStructs !== null || tr.doc.store.pendingDs !== null
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
    const previousDoc = this.namespaceDocMap.get(namespace)
    if (previousDoc !== doc) previousDoc?.ydoc.destroy()
    this.namespaceDocMap.set(namespace, doc)
  }

  /**
   * @param {string} namespace
   * @param {boolean=} immediate
   */
  debouncedPersist (namespace, immediate = false) {
    if (this.destroyed) return
    if (this.debouncedPersistMap.has(namespace)) {
      if (!immediate) return
      clearTimeout(this.debouncedPersistMap.get(namespace) || undefined)
    }
    const timeoutInterval = immediate
      ? 0
      : PERSIST_INTERVAL + (Math.random() - 0.5) * PERSIST_INTERVAL
    const timeout = setTimeout(
      async () => {
        const prev = this.awaitingPersistMap.get(namespace)
        if (prev) await prev.promise.catch(() => {})
        if (this.destroyed || this.debouncedPersistMap.get(namespace) !== timeout) return
        this.debouncedPersistMap.delete(namespace)
        const operation = this.persistNamespace(namespace)
        this.awaitingPersistMap.set(namespace, { promise: operation, resolve: () => {} })
        try {
          await operation
        } catch (e) {
          if (!(e instanceof ClientClosedError)) {
            console.error(e)
          }
          if (this.namespaceDocMap.has(namespace)) this.debouncedPersist(namespace)
        } finally {
          if (this.awaitingPersistMap.get(namespace)?.promise === operation) {
            this.awaitingPersistMap.delete(namespace)
          }
        }
      },
      timeoutInterval
    )

    this.debouncedPersistMap.set(namespace, timeout)
  }

  /** @param {string} namespace */
  async persistNamespace (namespace) {
    const isLeader = await this.tryAcquirePersistentLeader(namespace)
    if (!isLeader || this.destroyed) return
    assert(this.client)
    if (!this.namespaceDocMap.has(namespace)) return
    // Read the stream prefix and document together. The subscription cache may
    // lag behind Redis, so its contents cannot authorize trimming the head.
    const snapshot = await this.client.getDoc(namespace, 'index')
    logSocketIO(`trying to persist ${namespace} in [SID: ${this.serverId}]`)
    try {
      if (this.destroyed) return
      if (this.persistWorker && this.workerReady) {
        await this.persistInWorker(namespace, Y.encodeStateAsUpdateV2(snapshot.ydoc))
      } else {
        await this.client.store.persistDoc(namespace, 'index', snapshot.ydoc)
      }
      await this.client.trimRoomStream(namespace, 'index', snapshot.redisLastId)
    } finally {
      snapshot.awareness?.destroy()
      snapshot.ydoc.destroy()
    }
  }

  /**
   * @param {string} room
   * @param {Uint8Array} state
   */
  async persistInWorker (room, state) {
    const worker = this.persistWorker
    assert(worker)
    const requestId = randomUUID()
    /** @type {ReturnType<typeof promiseWithResolvers<void>>} */
    const pending = promiseWithResolvers()
    this.workerPersistRequests.set(requestId, { room, worker, resolve: pending.resolve, reject: pending.reject })
    try {
      const docstate = new Uint8Array(new SharedArrayBuffer(state.length))
      docstate.set(state)
      worker.postMessage({ room, requestId, docstate })
      await pending.promise
    } finally {
      this.workerPersistRequests.delete(requestId)
    }
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
    if (this.destroyed) return
    this.destroyed = true
    this.pendingLeaderAcquisitions.clear()
    for (const timeout of this.debouncedPersistMap.values()) clearTimeout(timeout || undefined)
    this.debouncedPersistMap.clear()
    for (const timeout of this.awaitingCleanupNamespace.values()) clearTimeout(timeout)
    this.awaitingCleanupNamespace.clear()
    if (this.persistWorker) {
      this.failPersistWorker(this.persistWorker, new Error('Server destroyed'))
      this.persistWorker.terminate().catch(console.error)
    }
    try {
      if (this.persistWorkerHealthCheckTimeout) {
        clearInterval(this.persistWorkerHealthCheckTimeout)
      }
      if (this.persistentHeartbeatTimeout) {
        clearTimeout(this.persistentHeartbeatTimeout)
      }
      this.subscriber?.destroy()
      return this.client?.destroy()
    } catch (e) {
      console.error(e)
    }
  }

  registerPersistWorkerResolve () {
    const worker = this.persistWorker
    if (!worker) return
    worker.on('message', ({ event, room, requestId, error }) => {
      if (worker !== this.persistWorker || this.destroyed) return
      const request = this.workerPersistRequests.get(requestId)
      if (request?.worker === worker && request.room === room) {
        if (event === 'persisted') request.resolve()
        if (event === 'persist-error') request.reject(new Error(error || 'Worker persistence failed'))
      }
      if (event === 'pong' && this.workerHeartbeatContext) {
        this.workerHeartbeatContext.resolve(true)
      }
      if (event === 'ready' || event === 'pong') this.workerReady = true
    })
    worker.on('error', error => this.failPersistWorker(worker, error))
    worker.on('exit', code => this.failPersistWorker(worker, new Error(`Persistence worker exited (${code})`)))
  }

  /**
   * @param {import('worker_threads').Worker} worker
   * @param {Error} error
   */
  failPersistWorker (worker, error) {
    if (worker === this.persistWorker) {
      this.workerReady = false
      this.workerLastHeartbeat = null
      this.workerHeartbeatContext?.resolve(false)
    }
    for (const request of this.workerPersistRequests.values()) {
      if (request.worker === worker) request.reject(error)
    }
  }

  /** @param {string} namespace */
  cancelNamespaceCleanup (namespace) {
    clearTimeout(this.awaitingCleanupNamespace.get(namespace))
    this.awaitingCleanupNamespace.delete(namespace)
  }

  /**
   * @param {string} namespace
   * @param {string} stream
   * @param {number=} removeAfterWait
   * @param {boolean=} extendExisting
   */
  cleanupNamespace (namespace, stream, removeAfterWait, extendExisting = false) {
    if (!removeAfterWait) {
      this.awaitingCleanupNamespace.delete(namespace)
      return this.cleanupNamespaceImpl(namespace, stream)
    }

    const existingTimer = this.awaitingCleanupNamespace.get(namespace)
    if (existingTimer) {
      if (!extendExisting) return
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(async () => {
      const awaitingPersist = this.awaitingPersistMap.get(namespace)
      try {
        if (awaitingPersist) await awaitingPersist.promise
      } catch (error) {
        if (this.awaitingCleanupNamespace.get(namespace) === timer) {
          this.cleanupNamespace(namespace, stream, DEFAULT_CLEAR_TIMEOUT, true)
        }
        return
      }
      // A reconnect or a newer cleanup timer may have superseded this callback
      // while it was waiting for persistence.
      if (this.awaitingCleanupNamespace.get(namespace) !== timer) return
      if (this.namespaceMap.get(namespace)?.sockets.size) {
        this.awaitingCleanupNamespace.delete(namespace)
        return
      }
      if (this.debouncedPersistMap.has(namespace)) {
        this.cleanupNamespace(namespace, stream, DEFAULT_CLEAR_TIMEOUT, true)
        return
      }
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
    const pendingPersist = this.debouncedPersistMap.get(namespace)
    if (pendingPersist) clearTimeout(pendingPersist)
    this.debouncedPersistMap.delete(namespace)
    this.pendingLeaderAcquisitions.delete(namespace)
    const token = this.persistentLeaderOf.get(namespace)
    this.persistentLeaderOf.delete(namespace)

    if (token) this.releasePersistentLeader(namespace, token).catch(console.error)
  }

  /**
   * @param {string} namespace
   * @param {string} token
   */
  async releasePersistentLeader (namespace, token) {
    assert(this.client)
    return this.client.redis.eval(`
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `, { keys: [this.getLeaderKeyOf(namespace)], arguments: [token] })
  }

  registerPersistWorkerHealthCheck () {
    if (this.destroyed) return
    this.persistWorkerHealthCheckTimeout = setTimeout(async () => {
      try {
        const workerHealth = await this.workerHealthCheck()
        if (!workerHealth && !this.destroyed) {
          logSocketIO('worker thread is unhealthy, recreating')
          assert(this.getPersistWorker)
          if (this.persistWorker) {
            this.failPersistWorker(this.persistWorker, new Error('Persistence worker is unresponsive'))
            await this.persistWorker.terminate()
          }
          if (this.destroyed) return
          this.persistWorker = this.getPersistWorker()
          this.registerPersistWorkerResolve()
        }
      } catch (error) {
        console.error(error)
      } finally {
        this.registerPersistWorkerHealthCheck()
      }
    }, WORKER_HEALTH_CHECK_INTERVAL)
  }

  async workerHealthCheck () {
    if (!this.persistWorker) return false
    if (this.workerHeartbeatContext) return this.workerHeartbeatContext.promise
    if (
      this.workerLastHeartbeat &&
      Date.now() - this.workerLastHeartbeat < WORKER_HEALTH_CHECK_INTERVAL * 2
    ) {
      return true
    }

    /** @type {ReturnType<typeof promiseWithResolvers<boolean>>} */
    const { promise: heartbeatPromise, resolve } = promiseWithResolvers()
    const context = { promise: heartbeatPromise, resolve }
    this.workerHeartbeatContext = context
    const now = performance.now()
    const timer = setTimeout(() => resolve(false), 3000)
    let health = false
    try {
      this.persistWorker.postMessage({ event: 'ping' })
      health = await heartbeatPromise
    } catch (error) {
      health = false
    } finally {
      clearTimeout(timer)
      if (this.workerHeartbeatContext === context) this.workerHeartbeatContext = null
    }
    if (health) {
      logSocketIO(`worker health check: responded in ${performance.now() - now}ms`)
      this.workerLastHeartbeat = Date.now()
    }
    return health
  }

  /**
   * @param {string} namespace
  */
  getLeaderKeyOf (namespace) {
    assert(this.client)
    return `${this.client.prefix}:persist-leader:${namespace}`
  }

  async registerPersistentLeaderHeartbeat () {
    if (this.destroyed) return
    this.persistentHeartbeatTimeout = setTimeout(async () => {
      try {
        await this.renewPersistentLeaders()
      } catch (e) {
        if (!(e instanceof ClientClosedError)) console.error(e)
      }
      this.registerPersistentLeaderHeartbeat()
    }, PERSIST_LEADER_HEARTBEAT_INTERVAL / 2)
  }

  async renewPersistentLeaders () {
    assert(this.client)
    for (const [namespace, token] of this.persistentLeaderOf) {
      const isActiveHere = this.namespaceMap.has(namespace) ||
        this.namespaceDocMap.has(namespace) || this.awaitingCleanupNamespace.has(namespace)
      if (!isActiveHere) {
        this.persistentLeaderOf.delete(namespace)
        await this.releasePersistentLeader(namespace, token)
        continue
      }
      const renewed = await this.client.redis.eval(`
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('PEXPIRE', KEYS[1], ARGV[2])
        end
        return 0
      `, {
        keys: [this.getLeaderKeyOf(namespace)],
        arguments: [token, String(PERSIST_LEADER_HEARTBEAT_INTERVAL)]
      })
      if (!renewed && this.persistentLeaderOf.get(namespace) === token) {
        this.persistentLeaderOf.delete(namespace)
      }
    }
  }

  /**
   * @param {string} namespace
   */
  tryAcquirePersistentLeader (namespace) {
    if (this.destroyed) return Promise.resolve(false)
    const pending = this.pendingLeaderAcquisitions.get(namespace)
    if (pending) return pending
    assert(this.client)
    const previousToken = this.persistentLeaderOf.get(namespace) || ''
    const newToken = `${this.serverId}:${randomUUID()}`
    // Renew an existing acquisition atomically, or create a fresh token. A
    // delayed release/renewal from an expired acquisition cannot touch this one.
    const request = this.client.redis.eval(`
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        redis.call('PEXPIRE', KEYS[1], ARGV[3])
        return ARGV[1]
      end
      if redis.call('SET', KEYS[1], ARGV[2], 'NX', 'PX', ARGV[3]) then
        return ARGV[2]
      end
      return false
    `, {
      keys: [this.getLeaderKeyOf(namespace)],
      arguments: [previousToken, newToken, String(PERSIST_LEADER_HEARTBEAT_INTERVAL)]
    }).then(async result => {
      const token = typeof result === 'string' ? result : null
      // Cleanup may have run while Redis was processing the acquisition.
      if (this.pendingLeaderAcquisitions.get(namespace) !== request) {
        if (token) await this.releasePersistentLeader(namespace, token)
        return false
      }
      if (token) this.persistentLeaderOf.set(namespace, token)
      else this.persistentLeaderOf.delete(namespace)
      return token !== null
    }).finally(() => {
      if (this.pendingLeaderAcquisitions.get(namespace) === request) {
        this.pendingLeaderAcquisitions.delete(namespace)
      }
    })
    this.pendingLeaderAcquisitions.set(namespace, request)
    return request
  }
}
