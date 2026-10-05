import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Server } from 'socket.io'
import { io as connect } from 'socket.io-client'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import * as Y from 'yjs'
import { createMemoryStorage } from '../src/storage/memory.js'
import { promiseWithResolvers } from '../src/y-socket-io/utils.js'

process.env.Y_WORKER_DISABLED = 'true'
process.env.Y_SOCKET_IO_SERVER_PERSIST_INTERVAL = '20'
process.env.Y_SOCKET_IO_WORKER_HEALTH_CHECK_INTERVAL = '20'
/** @typedef {import('../src/y-socket-io/y-socket-io.js').YSocketIO} SocketIOServer */
const { YSocketIO } = await import('../src/y-socket-io/y-socket-io.js')
const { createApiClient, computeRedisRoomStreamName } = await import('../src/api.js')

/** @param {() => boolean | Promise<boolean>} predicate */
async function until (predicate) {
  const deadline = Date.now() + 3000
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not settle')
    await delay(5)
  }
}

function createServer () {
  return new YSocketIO(new Server(), { authenticate: () => ({ userid: 'test' }), enableAwareness: false })
}

function createUpdates () {
  const doc = new Y.Doc()
  doc.getMap().set('first', 1)
  const first = Y.encodeStateAsUpdate(doc)
  doc.getMap().set('second', 2)
  const second = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return { first, second }
}

// Exercise the registered sync handler with controlled append completion.
function createSyncHarness () {
  const server = createServer()
  /** @type {Map<string, Function>} */
  const handlers = new Map()
  /** @type {Array<ReturnType<typeof promiseWithResolvers<void>>>} */
  const appends = []
  Reflect.set(server, 'client', {
    addMessage: () => {
      const append = promiseWithResolvers()
      appends.push(append)
      return append.promise
    }
  })
  Reflect.get(server, 'initSyncListeners')({
    nsp: { name: '/yjs|test' },
    on: (/** @type {string} */ event, /** @type {Function} */ handler) => handlers.set(event, handler)
  })
  const update = handlers.get('sync-update')
  assert.ok(update)
  return { update, appends }
}

test('failed append stays unacknowledged and an identical retry appends again', async () => {
  const { update, appends } = createSyncHarness()
  const { first } = createUpdates()
  let acks = 0
  const originalError = console.error
  /** @type {unknown[]} */
  const errors = []
  console.error = error => errors.push(error)
  try {
    update(first, () => acks++)
    appends[0].reject(new Error('append failed'))
    await until(() => errors.length === 1)
    assert.equal(acks, 0)
    update(first.slice(), () => acks++)
    assert.equal(appends.length, 2)
    assert.equal(acks, 0)
    appends[1].resolve(undefined)
    await until(() => acks === 1)
  } finally {
    console.error = originalError
  }
})

test('concurrent duplicates and different updates each await successful acceptance', async () => {
  const { update, appends } = createSyncHarness()
  const { first, second } = createUpdates()
  /** @type {string[]} */
  const acks = []
  update(first, () => acks.push('first'))
  update(first.slice(), () => acks.push('retry'))
  update(second, () => acks.push('second'))
  assert.equal(appends.length, 3)
  assert.deepEqual(acks, [])
  appends[2].resolve(undefined)
  await until(() => acks.length === 1)
  assert.deepEqual(acks, ['second'])
  appends[1].resolve(undefined)
  await until(() => acks.length === 2)
  assert.deepEqual(acks, ['second', 'retry'])
  appends[0].resolve(undefined)
  await until(() => acks.length === 3)
})

test('an accepted update with a lost ACK can be safely submitted again', async () => {
  const { update, appends } = createSyncHarness()
  const { first } = createUpdates()
  update(first, () => {}) // ACK is lost to the sender.
  appends[0].resolve(undefined)
  await delay(0)
  let acked = false
  update(first.slice(), () => { acked = true })
  assert.equal(appends.length, 2)
  assert.equal(acked, false)
  appends[1].resolve(undefined)
  await until(() => acked)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, first)
  Y.applyUpdate(doc, first)
  assert.deepEqual(doc.getMap().toJSON(), { first: 1 })
  doc.destroy()
})

// All Redis keys are scoped to this run; no shared database is flushed.
const redisUrl = process.env.YSR_TEST_REDIS || 'redis://127.0.0.1:36379'
const prefix = `consistency-${randomUUID()}`
const store = createMemoryStorage()
/** @type {import('../src/api.js').Api[]} */
const clients = []
/** @type {SocketIOServer[]} */
const servers = []

before(async () => {
  for (let i = 0; i < 3; i++) {
    const client = await createApiClient(store, { redisUrl, redisPrefix: prefix, enableAwareness: false })
    clients.push(client)
    const server = createServer()
    Reflect.set(server, 'client', client)
    servers.push(server)
  }
})

after(async () => {
  for (const server of servers) {
    for (const timer of Reflect.get(server, 'awaitingCleanupNamespace').values()) clearTimeout(timer)
    for (const timer of Reflect.get(server, 'debouncedPersistMap').values()) clearTimeout(timer)
    await server.destroy()
  }
  const cleanup = await createApiClient(store, { redisUrl, redisPrefix: prefix, enableAwareness: false })
  try {
    const keys = await cleanup.redis.keys(`${prefix}:*`)
    if (keys.length) await cleanup.redis.del(keys)
  } finally {
    await cleanup.destroy()
  }
  await Promise.all(clients.map(client => client.destroy()))
})

/** @param {SocketIOServer} server @param {string} room */
function activate (server, room) {
  Reflect.get(server, 'namespaceMap').set(room, Reflect.get(server, 'io').of(`/yjs|${room}`))
}

/** @param {SocketIOServer} server @param {string} room */
function cleanup (server, room) {
  Reflect.get(server, 'cleanupNamespaceImpl').call(server, room, `${prefix}:room:${room}:index`)
}

/** @param {string} key */
async function expireLease (key) {
  await clients[0].redis.pExpire(key, 1)
  await until(async () => await clients[0].redis.get(key) === null)
}

test('follower cleanup cannot release the active leader; owner cleanup allows takeover', async () => {
  const [a, b, c] = servers
  const room = 'follower-cleanup'
  activate(a, room)
  assert.equal(await a.tryAcquirePersistentLeader(room), true)
  const key = a.getLeaderKeyOf(room)
  const token = await clients[0].redis.get(key)
  assert.equal(await b.tryAcquirePersistentLeader(room), false)
  cleanup(b, room)
  assert.equal(await clients[0].redis.get(key), token)
  assert.equal(await c.tryAcquirePersistentLeader(room), false)
  cleanup(a, room)
  await until(async () => await clients[0].redis.get(key) === null)
  assert.equal(await c.tryAcquirePersistentLeader(room), true)
})

test('concurrent acquisition has one winner and same-server calls share the acquisition', async () => {
  const [a, b, c] = servers
  const room = 'concurrent-acquisition'
  const first = a.tryAcquirePersistentLeader(room)
  assert.equal(a.tryAcquirePersistentLeader(room), first)
  const results = await Promise.all([first, b.tryAcquirePersistentLeader(room), c.tryAcquirePersistentLeader(room)])
  assert.equal(results.filter(Boolean).length, 1)
  const winner = servers[results.indexOf(true)]
  const key = winner.getLeaderKeyOf(room)
  const token = await clients[0].redis.get(key)
  assert.equal(await winner.tryAcquirePersistentLeader(room), true)
  assert.equal(await clients[0].redis.get(key), token)
})

test('expired owner cannot release or renew a different server lease', async () => {
  const [a, b] = servers
  const room = 'expired-owner'
  activate(a, room)
  assert.equal(await a.tryAcquirePersistentLeader(room), true)
  const key = a.getLeaderKeyOf(room)
  const oldToken = await clients[0].redis.get(key)
  assert.ok(oldToken)
  await expireLease(key)
  assert.equal(await b.tryAcquirePersistentLeader(room), true)
  const newToken = await clients[0].redis.get(key)
  await clients[0].redis.pExpire(key, 2000)
  await a.renewPersistentLeaders()
  assert.equal(await clients[0].redis.get(key), newToken)
  assert.ok(await clients[0].redis.pTTL(key) <= 2000)
  assert.equal(await a.releasePersistentLeader(room, oldToken), 0)
  assert.equal(await clients[0].redis.get(key), newToken)
})

test('reacquisition by the same server gets a fresh token immune to old cleanup', async () => {
  const [a] = servers
  const room = 'same-server-reacquisition'
  assert.equal(await a.tryAcquirePersistentLeader(room), true)
  const key = a.getLeaderKeyOf(room)
  const oldToken = await clients[0].redis.get(key)
  assert.ok(oldToken)
  await expireLease(key)
  assert.equal(await a.tryAcquirePersistentLeader(room), true)
  const newToken = await clients[0].redis.get(key)
  assert.notEqual(newToken, oldToken)
  assert.equal(await a.releasePersistentLeader(room, oldToken), 0)
  assert.equal(await clients[0].redis.get(key), newToken)
})

test('heartbeat extends only a still-owned active lease', async () => {
  const [a] = servers
  const room = 'heartbeat'
  activate(a, room)
  await a.tryAcquirePersistentLeader(room)
  const key = a.getLeaderKeyOf(room)
  const token = await clients[0].redis.get(key)
  await clients[0].redis.pExpire(key, 500)
  await a.renewPersistentLeaders()
  assert.equal(await clients[0].redis.get(key), token)
  assert.ok(await clients[0].redis.pTTL(key) > 500)
})

test('cleanup during acquisition releases the late result without restoring local ownership', async () => {
  const [a] = servers
  const room = 'cleanup-during-acquisition'
  const redis = clients[0].redis
  const originalEval = redis.eval.bind(redis)
  const acquired = promiseWithResolvers()
  const resume = promiseWithResolvers()
  redis.eval = async (...args) => {
    const result = await originalEval(...args)
    acquired.resolve(undefined)
    await resume.promise
    return result
  }
  try {
    const request = a.tryAcquirePersistentLeader(room)
    await acquired.promise
    cleanup(a, room)
    redis.eval = originalEval
    resume.resolve(undefined)
    assert.equal(await request, false)
    assert.equal(await redis.get(a.getLeaderKeyOf(room)), null)
    assert.equal(Reflect.get(a, 'persistentLeaderOf').has(room), false)
  } finally {
    redis.eval = originalEval
    resume.resolve(undefined)
  }
})

test('delayed heartbeat cannot steal a successor lease', async () => {
  const [a, b] = servers
  const room = 'delayed-heartbeat'
  activate(a, room)
  await a.tryAcquirePersistentLeader(room)
  const key = a.getLeaderKeyOf(room)
  const redis = clients[0].redis
  const originalEval = redis.eval.bind(redis)
  const entered = promiseWithResolvers()
  const resume = promiseWithResolvers()
  redis.eval = async (...args) => {
    entered.resolve(undefined)
    await resume.promise
    return originalEval(...args)
  }
  try {
    const heartbeat = a.renewPersistentLeaders()
    await entered.promise
    await expireLease(key)
    await b.tryAcquirePersistentLeader(room)
    const token = await redis.get(key)
    resume.resolve(undefined)
    await heartbeat
    assert.equal(await redis.get(key), token)
    assert.equal(Reflect.get(a, 'persistentLeaderOf').has(room), false)
  } finally {
    redis.eval = originalEval
    resume.resolve(undefined)
  }
})

test('reconnect cancels cleanup even after its timer has begun waiting for persistence', async () => {
  const [a] = servers
  const room = 'reconnect'
  activate(a, room)
  await a.tryAcquirePersistentLeader(room)
  const key = a.getLeaderKeyOf(room)
  const token = await clients[0].redis.get(key)
  const persistence = promiseWithResolvers()
  Reflect.get(a, 'awaitingPersistMap').set(room, persistence)
  a.cleanupNamespace(room, `${prefix}:room:${room}:index`, 1)
  await delay(20)
  a.cancelNamespaceCleanup(room)
  persistence.resolve(undefined)
  await delay(20)
  assert.equal(await clients[0].redis.get(key), token)
  assert.equal(Reflect.get(a, 'namespaceMap').has(room), true)
  Reflect.get(a, 'awaitingPersistMap').delete(room)
})

test('Socket.IO retry after disconnect is accepted and acknowledged through Redis', async () => {
  const httpServer = createHttpServer()
  const io = new Server(httpServer)
  const server = new YSocketIO(io, { authenticate: () => ({ userid: 'test' }), enableAwareness: false })
  Reflect.set(server, 'client', clients[0])
  const namespace = io.of('/yjs|socket-reconnect')
  namespace.on('connection', socket => Reflect.get(server, 'initSyncListeners')(socket))
  httpServer.listen(0)
  const address = httpServer.address()
  assert.ok(address && typeof address !== 'string')
  const socket = connect(`http://127.0.0.1:${address.port}/yjs|socket-reconnect`, { reconnection: false, forceNew: true })
  const { first } = createUpdates()
  try {
    await until(() => socket.connected)
    await socket.timeout(2000).emitWithAck('sync-update', first)
    socket.disconnect()
    socket.connect()
    await until(() => socket.connected)
    await socket.timeout(2000).emitWithAck('sync-update', first.slice())
    const persisted = await clients[0].getDoc('socket-reconnect', 'index')
    assert.deepEqual(persisted.ydoc.getMap().toJSON(), { first: 1 })
    persisted.ydoc.destroy()
    assert.equal(await clients[0].redis.xLen(`${prefix}:room:socket-reconnect:index`), 2)
  } finally {
    socket.disconnect()
    await new Promise(resolve => io.close(resolve))
  }
})

test('failed concurrent duplicates receive no ACK and remain retryable', async () => {
  const { update, appends } = createSyncHarness()
  const { first } = createUpdates()
  let acks = 0
  const originalError = console.error
  /** @type {unknown[]} */
  const errors = []
  console.error = error => errors.push(error)
  try {
    update(first, () => acks++)
    update(first.slice(), () => acks++)
    appends[0].reject(new Error('first append failed'))
    appends[1].reject(new Error('duplicate append failed'))
    await until(() => errors.length === 2)
    assert.equal(acks, 0)
    update(first.slice(), () => acks++)
    assert.equal(appends.length, 3)
    appends[2].resolve(undefined)
    await until(() => acks === 1)
  } finally {
    console.error = originalError
  }
})

test('a rejected Redis acquisition does not block subsequent attempts', async () => {
  const [a] = servers
  const room = 'acquisition-failure'
  const redis = clients[0].redis
  const originalEval = redis.eval.bind(redis)
  redis.eval = () => Promise.reject(new Error('Redis unavailable'))
  try {
    await assert.rejects(a.tryAcquirePersistentLeader(room), /Redis unavailable/)
    assert.equal(Reflect.get(a, 'pendingLeaderAcquisitions').has(room), false)
  } finally {
    redis.eval = originalEval
  }
  assert.equal(await a.tryAcquirePersistentLeader(room), true)
})

test('a superseded cleanup callback cannot release the lease while a newer timer waits', async () => {
  const [a] = servers
  const room = 'extended-cleanup'
  activate(a, room)
  await a.tryAcquirePersistentLeader(room)
  const key = a.getLeaderKeyOf(room)
  const token = await clients[0].redis.get(key)
  const persistence = promiseWithResolvers()
  Reflect.get(a, 'awaitingPersistMap').set(room, persistence)
  a.cleanupNamespace(room, `${prefix}:room:${room}:index`, 1)
  await delay(20)
  a.cleanupNamespace(room, `${prefix}:room:${room}:index`, 1000, true)
  persistence.resolve(undefined)
  await delay(20)
  assert.equal(await clients[0].redis.get(key), token)
  assert.equal(Reflect.get(a, 'namespaceMap').has(room), true)
  a.cancelNamespaceCleanup(room)
  Reflect.get(a, 'awaitingPersistMap').delete(room)
})

/** @param {import('node:test').TestContext} t */
async function persistenceCase (t) {
  const storage = createMemoryStorage()
  const client = await createApiClient(storage, { redisUrl, redisPrefix: `${prefix}:${randomUUID()}`, enableAwareness: false })
  client.redisMinMessageLifetime = 0
  const server = createServer()
  Reflect.set(server, 'client', client)
  const room = 'snapshot'
  const stream = computeRedisRoomStreamName(room, 'index', client.prefix)
  activate(server, room)
  Reflect.get(server, 'streamNamespaceMap').set(stream, room)
  clients.push(client)
  servers.push(server)
  t.after(async () => {
    await server.destroy()
    for (const doc of Reflect.get(server, 'namespaceDocMap').values()) doc.ydoc.destroy()
  })
  return {
    server,
    client,
    storage,
    room,
    stream,
    /** @param {string} id @param {Uint8Array} update */
    append: (id, update) => client.redis.xAdd(stream, id, { m: Buffer.from(server.toRedis('sync-update', update)) }),
    load: async () => {
      const doc = await client.getDoc(room, 'index')
      Reflect.get(server, 'namespaceDocMap').set(room, doc)
      return doc
    }
  }
}

test('a delayed direct save keeps its snapshot and retains later updates from the same millisecond', async t => {
  const { server, client, storage, room, stream, append, load } = await persistenceCase(t)
  const { first, second } = createUpdates()
  await append('1000-0', first)
  await load()
  const started = promiseWithResolvers()
  const release = promiseWithResolvers()
  const persist = storage.persistDoc.bind(storage)
  storage.persistDoc = async (...args) => {
    started.resolve(undefined)
    await release.promise
    await persist(...args)
  }
  const operation = server.persistNamespace(room)
  await started.promise
  try {
    await append('1000-1', second)
    await Reflect.get(server, 'redisMessageSubscriber')(stream, [server.toRedis('sync-update', second)])
    const scheduled = Reflect.get(server, 'debouncedPersistMap')
    clearTimeout(scheduled.get(room))
    scheduled.delete(room)
  } finally {
    release.resolve(undefined)
  }
  await operation
  assert.deepEqual((await client.redis.xRange(stream, '-', '+')).map(m => m.id), ['1000-1'])
  const saved = await storage.retrieveDoc(room, 'index')
  assert.ok(saved)
  const doc = new Y.Doc()
  Y.applyUpdateV2(doc, saved.doc)
  assert.deepEqual(doc.getMap().toJSON(), { first: 1 })
  doc.destroy()
  await server.persistNamespace(room)
  assert.equal(await client.redis.xLen(stream), 0)
})

test('trimming requires a snapshot boundary and honors minimum retention', async t => {
  const { client, room, stream, append } = await persistenceCase(t)
  const { first } = createUpdates()
  await append('1000-0', first)
  const recent = `${Date.now()}-0`
  await append(recent, first)
  await client.trimRoomStream(room, 'index')
  assert.equal(await client.redis.xLen(stream), 2)
  client.redisMinMessageLifetime = 60000
  await client.trimRoomStream(room, 'index', recent)
  assert.deepEqual((await client.redis.xRange(stream, '-', '+')).map(m => m.id), [recent])
})

test('queue workers trim through their snapshot rather than the task ID or current stream head', async t => {
  const { client, storage, stream, append } = await persistenceCase(t)
  const { first, second } = createUpdates()
  await append('1000-0', first)
  await client.redis.xAdd(client.redisWorkerStreamName, '*', { compact: stream })
  const started = promiseWithResolvers()
  const release = promiseWithResolvers()
  const persist = storage.persistDoc.bind(storage)
  storage.persistDoc = async (...args) => {
    started.resolve(undefined)
    await release.promise
    await persist(...args)
  }
  const operation = client.consumeWorkerQueue({ tryReclaimCount: 0, tryClaimCount: 1, blockTime: 10 })
  await started.promise
  await append('1000-1', second)
  release.resolve(undefined)
  await operation
  assert.deepEqual((await client.redis.xRange(stream, '-', '+')).map(m => m.id), ['1000-1'])
  await client.consumeWorkerQueue({ tryReclaimCount: 0, tryClaimCount: 1, blockTime: 10 })
  assert.equal(await client.redis.xLen(stream), 0)
  await client.consumeWorkerQueue({ tryReclaimCount: 0, tryClaimCount: 1, blockTime: 10 })
  assert.equal(await client.redis.xLen(client.redisWorkerStreamName), 0)
})

test('a failed queue save retains its stream and can be reclaimed', async t => {
  const { client, storage, stream, append } = await persistenceCase(t)
  await append('1000-0', createUpdates().first)
  await client.redis.xAdd(client.redisWorkerStreamName, '*', { compact: stream })
  const persist = storage.persistDoc.bind(storage)
  storage.persistDoc = async () => { throw new Error('Save failed') }
  await assert.rejects(client.consumeWorkerQueue({ tryReclaimCount: 0, tryClaimCount: 1, blockTime: 10 }), /Save failed/)
  assert.equal(await client.redis.xLen(stream), 1)
  storage.persistDoc = persist
  client.redisWorkerTimeout = 0
  await client.consumeWorkerQueue({ tryReclaimCount: 1, tryClaimCount: 0 })
  assert.equal(await client.redis.xLen(stream), 0)
})

test('out-of-order Yjs structs are persisted before their stream entries are trimmed', async t => {
  const { client, storage, room, stream, append } = await persistenceCase(t)
  const source = new Y.Doc()
  /** @type {Uint8Array[]} */
  const updates = []
  source.on('update', update => updates.push(update))
  source.getText().insert(0, 'a')
  source.getText().insert(1, 'b')
  await append('1000-0', updates[1])
  await client.redis.xAdd(client.redisWorkerStreamName, '*', { compact: stream })
  await client.consumeWorkerQueue({ tryReclaimCount: 0, tryClaimCount: 1, blockTime: 10 })
  assert.equal(await client.redis.xLen(stream), 0)
  const saved = await storage.retrieveDoc(room, 'index')
  assert.ok(saved)
  const restored = new Y.Doc()
  Y.applyUpdateV2(restored, saved.doc)
  Y.applyUpdate(restored, updates[0])
  assert.equal(restored.getText().toString(), 'ab')
  source.destroy()
  restored.destroy()
})

test('failed direct saves retry without another update and defer namespace cleanup', async t => {
  const { server, client, storage, room, stream, append, load } = await persistenceCase(t)
  await append('1000-0', createUpdates().first)
  await load()
  const firstSave = promiseWithResolvers()
  const retry = promiseWithResolvers()
  const persist = storage.persistDoc.bind(storage)
  let attempts = 0
  storage.persistDoc = async (...args) => {
    attempts++
    if (attempts === 1) {
      await firstSave.promise
      throw new Error('Temporary save failure')
    }
    await retry.promise
    await persist(...args)
  }
  t.mock.method(console, 'error', () => {})
  server.debouncedPersist(room, true)
  await until(() => attempts === 1)
  server.cleanupNamespace(room, stream, 1)
  await delay(10)
  firstSave.resolve(undefined)
  await until(() => attempts === 2)
  assert.equal(await client.redis.xLen(stream), 1)
  assert.equal(Reflect.get(server, 'namespaceDocMap').has(room), true)
  server.cancelNamespaceCleanup(room)
  retry.resolve(undefined)
  await until(async () => await client.redis.xLen(stream) === 0)
  await until(() => !Reflect.get(server, 'awaitingPersistMap').has(room))
  assert.equal(Reflect.get(server, 'namespaceDocMap').has(room), true)
  server.cleanupNamespace(room, stream, 1)
  await until(() => !Reflect.get(server, 'namespaceDocMap').has(room))
})

class ControlledWorker extends EventEmitter {
  /** @type {Array<{room: string, requestId: string, docstate: Uint8Array}>} */
  requests = []
  stopped = false

  /** @param {{event?: string, room?: string, requestId?: string, docstate?: Uint8Array}} message */
  postMessage (message) {
    if (this.stopped) throw new Error('Worker stopped')
    if (message.event === 'ping') {
      this.emit('message', { event: 'pong' })
    } else {
      assert.ok(message.room && message.requestId && message.docstate)
      this.requests.push({ room: message.room, requestId: message.requestId, docstate: message.docstate })
    }
  }

  async terminate () {
    this.stopped = true
    this.emit('exit', 1)
    return 1
  }
}

/** @param {SocketIOServer} server @param {ControlledWorker | Worker} worker */
function attachWorker (server, worker) {
  Reflect.set(server, 'persistWorker', worker)
  server.registerPersistWorkerResolve()
  worker.emit('message', { event: 'ready' })
}

test('stale, uncorrelated, and wrong-room worker completions cannot settle a retry', async t => {
  const { server, client, room, stream, append, load } = await persistenceCase(t)
  await append('1000-0', createUpdates().first)
  await load()
  const worker = new ControlledWorker()
  attachWorker(server, worker)
  t.mock.method(console, 'error', () => {})
  server.debouncedPersist(room, true)
  await until(() => worker.requests.length === 1)
  const first = worker.requests[0]
  worker.emit('message', { event: 'persist-error', room, requestId: first.requestId, error: 'Save failed' })
  await until(() => worker.requests.length === 2)
  const second = worker.requests[1]
  assert.notEqual(first.requestId, second.requestId)
  worker.emit('message', { event: 'persisted', room, requestId: first.requestId })
  worker.emit('message', { event: 'persisted', room })
  worker.emit('message', { event: 'persisted', room: 'another-room', requestId: second.requestId })
  await delay(10)
  assert.equal(await client.redis.xLen(stream), 1)
  assert.equal(Reflect.get(server, 'workerPersistRequests').size, 1)
  worker.emit('message', { event: 'persisted', room, requestId: second.requestId })
  await until(async () => await client.redis.xLen(stream) === 0)
  assert.equal(Reflect.get(server, 'workerPersistRequests').size, 0)
})

for (const failure of ['error', 'exit', 'health']) {
  test(`worker ${failure} releases pending saves and allows retry after replacement`, async t => {
    const { server, client, room, stream, append, load } = await persistenceCase(t)
    await append('1000-0', createUpdates().first)
    await load()
    const oldWorker = new ControlledWorker()
    attachWorker(server, oldWorker)
    const replacement = new ControlledWorker()
    Reflect.set(server, 'getPersistWorker', () => {
      queueMicrotask(() => replacement.emit('message', { event: 'ready' }))
      return replacement
    })
    t.mock.method(console, 'error', () => {})
    server.debouncedPersist(room, true)
    await until(() => oldWorker.requests.length === 1)
    oldWorker.stopped = true
    if (failure === 'error') oldWorker.emit('error', new Error('Worker crashed'))
    if (failure === 'exit') oldWorker.emit('exit', 1)
    let checked = false
    t.mock.method(server, 'workerHealthCheck', async () => {
      const health = checked
      checked = true
      return health
    })
    server.registerPersistWorkerHealthCheck()
    await until(() => Object.is(Reflect.get(server, 'persistWorker'), replacement))
    // A retry may use direct persistence while the worker is unavailable.
    await until(async () => replacement.requests.length > 0 || await client.redis.xLen(stream) === 0)
    const request = replacement.requests[0]
    if (request) {
      oldWorker.emit('message', { event: 'persisted', room, requestId: request.requestId })
      await delay(5)
      assert.equal(await client.redis.xLen(stream), 1)
      replacement.emit('message', { event: 'persisted', room, requestId: request.requestId })
    }
    await until(async () => await client.redis.xLen(stream) === 0)
    await until(() => !Reflect.get(server, 'awaitingPersistMap').has(room))
    assert.equal(Reflect.get(server, 'workerPersistRequests').size, 0)
  })
}

test('the real persistence worker reports storage errors and completes a later retry', async t => {
  const { server, client, room, stream, append, load } = await persistenceCase(t)
  await append('1000-0', createUpdates().first)
  await load()
  const moduleUrl = new URL('../src/persist-worker-thread.js', import.meta.url).href
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads')
    ;(async () => {
      const { createPersistWorkerThread } = await import(${JSON.stringify(moduleUrl)})
      const Y = await import('yjs')
      let attempts = 0
      createPersistWorkerThread({
        persistDoc: async (room, docname, doc) => {
          if (++attempts === 1) throw new Error('Storage unavailable')
          parentPort.postMessage({ event: 'stored', state: Y.encodeStateAsUpdateV2(doc) })
        }
      })
    })()
  `, { eval: true })
  /** @type {Array<{event: string, requestId?: string, state?: Uint8Array}>} */
  const messages = []
  worker.on('message', message => messages.push(message))
  Reflect.set(server, 'persistWorker', worker)
  server.registerPersistWorkerResolve()
  await until(() => Reflect.get(server, 'workerReady'))
  t.mock.method(console, 'error', () => {})
  server.debouncedPersist(room, true)
  await until(async () => await client.redis.xLen(stream) === 0)
  const failed = messages.find(m => m.event === 'persist-error')
  const succeeded = messages.find(m => m.event === 'persisted')
  assert.ok(failed?.requestId && succeeded?.requestId)
  assert.notEqual(failed.requestId, succeeded.requestId)
  const state = messages.find(m => m.event === 'stored')?.state
  assert.ok(state)
  const saved = new Y.Doc()
  Y.applyUpdateV2(saved, state)
  assert.deepEqual(saved.getMap().toJSON(), { first: 1 })
  saved.destroy()
})
