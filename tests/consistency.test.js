import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Server } from 'socket.io'
import { io as connect } from 'socket.io-client'
import * as Y from 'yjs'
import { YSocketIO } from '../src/y-socket-io/y-socket-io.js'
import { createApiClient } from '../src/api.js'
import { createMemoryStorage } from '../src/storage/memory.js'
import { promiseWithResolvers } from '../src/y-socket-io/utils.js'

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
/** @type {YSocketIO[]} */
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
  }
  if (clients[0]) {
    const keys = await clients[0].redis.keys(`${prefix}:*`)
    if (keys.length) await clients[0].redis.del(keys)
  }
  await Promise.all(clients.map(client => client.destroy()))
})

/** @param {YSocketIO} server @param {string} room */
function activate (server, room) {
  Reflect.get(server, 'namespaceMap').set(room, Reflect.get(server, 'io').of(`/yjs|${room}`))
}

/** @param {YSocketIO} server @param {string} room */
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
