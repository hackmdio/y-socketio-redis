import * as Y from 'yjs'
import { createClient, defineScript, commandOptions } from 'redis'
import * as map from 'lib0/map'
import * as decoding from 'lib0/decoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as array from 'lib0/array'
import * as random from 'lib0/random'
import * as number from 'lib0/number'
import * as promise from 'lib0/promise'
import * as math from 'lib0/math'
import * as protocol from './protocol.js'
import * as env from 'lib0/environment'
import * as logging from 'lib0/logging'

const logWorker = logging.createModuleLogger('@y/redis/api/worker')
const logApi = logging.createModuleLogger('@y/redis/api')

let ydocUpdateCallback = env.getConf('ydoc-update-callback')
if (ydocUpdateCallback != null && ydocUpdateCallback.slice(-1) !== '/') {
  ydocUpdateCallback += '/'
}
const WORKER_DISABLED = env.getConf('y-worker-disabled') === 'true'
const ROOM_STREAM_TTL = number.parseInt(env.getConf('y-room-stream-ttl') || '300')

/**
 * @param {string} a
 * @param {string} b
 * @return {boolean} iff a < b
 */
export const isSmallerRedisId = (a, b) => {
  const [a1, a2 = '0'] = a.split('-')
  const [b1, b2 = '0'] = b.split('-')
  const a1n = number.parseInt(a1)
  const b1n = number.parseInt(b1)
  return a1n < b1n || (a1n === b1n && number.parseInt(a2) < number.parseInt(b2))
}

/**
 * @param {import('@redis/client/dist/lib/commands/generic-transformers.js').StreamsMessagesReply} streamReply
 * @param {string} prefix
 */
const extractMessagesFromStreamReply = (streamReply, prefix) => {
  /**
   * @type {Map<string, Map<string, { lastId: string, messages: Array<Uint8Array> }>>}
   */
  const messages = new Map()
  streamReply?.forEach(docStreamReply => {
    const { room, docid } = decodeRedisRoomStreamName(docStreamReply.name.toString(), prefix)
    const docMessages = map.setIfUndefined(
      map.setIfUndefined(
        messages,
        room,
        map.create
      ),
      docid,
      () => ({ lastId: array.last(docStreamReply.messages).id, messages: /** @type {Array<Uint8Array>} */ ([]) })
    )
    docStreamReply.messages.forEach(m => {
      if (m.message.m != null) {
        docMessages.messages.push(/** @type {Uint8Array} */ (m.message.m))
      }
    })
  })
  return messages
}

/**
 * @param {string} room
 * @param {string} docid
 * @param {string} prefix
 */
export const computeRedisRoomStreamName = (room, docid, prefix) => `${prefix}:room:${encodeURIComponent(room)}:${encodeURIComponent(docid)}`

/**
 * @param {string} rediskey
 * @param {string} expectedPrefix
 */
const decodeRedisRoomStreamName = (rediskey, expectedPrefix) => {
  const match = rediskey.match(/^(.*):room:(.*):(.*)$/)
  if (match == null || match[1] !== expectedPrefix) {
    throw new Error(`Malformed stream name! prefix="${match?.[1]}" expectedPrefix="${expectedPrefix}", rediskey="${rediskey}"`)
  }
  return { room: decodeURIComponent(match[2]), docid: decodeURIComponent(match[3]) }
}

/**
 * @param {import('./storage.js').AbstractStorage} store
 * @param {{ redisPrefix?: string, redisUrl?: string, enableAwareness?: boolean }} opts
 */
export const createApiClient = async (store, { redisPrefix, redisUrl, enableAwareness = true }) => {
  const a = new Api(store, redisPrefix, redisUrl, { enableAwareness })
  await a.redis.connect()
  try {
    await a.redis.xGroupCreate(a.redisWorkerStreamName, a.redisWorkerGroupName, '0', { MKSTREAM: true })
  } catch (e) { }
  return a
}

export class Api {
  redis
  /**
   * @param {import('./storage.js').AbstractStorage} store
   * @param {string=} prefix
   * @param {string=} url
   * @param {Object} opts
   * @param {boolean=} opts.enableAwareness
   */
  constructor (store, prefix = 'y', url = env.ensureConf('ysr-redis'), { enableAwareness = true } = {}) {
    this.store = store
    this.prefix = prefix
    this.enableAwareness = enableAwareness
    this.consumername = random.uuidv4()
    /**
     * After this timeout, a new worker will pick up the task
     * @todo rename this variable
     */
    this.redisWorkerTimeout = number.parseInt(env.getConf('redis-task-timeout') || '1000')
    /**
     * Minimum lifetime of y* update messages in redis streams.
     */
    this.redisMinMessageLifetime = number.parseInt(env.getConf('redis-min-message-lifetime') || '60000')
    this.redisWorkerStreamName = this.prefix + ':worker'
    this.redisWorkerGroupName = this.prefix + ':worker'
    this.workerSetName = `${this.prefix}:worker:${this.consumername}:idset`
    this._destroyed = false

    const addScript = WORKER_DISABLED
      ? `
          redis.call("XADD", KEYS[1], "*", "m", ARGV[1])
          redis.call("EXPIRE", KEYS[1], ${ROOM_STREAM_TTL})
        `
      : `
          if redis.call("EXISTS", KEYS[1]) == 0 then
            redis.call("XADD", "${this.redisWorkerStreamName}", "*", "compact", KEYS[1])
          elseif redis.call("XLEN", KEYS[1]) > 100 then
            redis.call("SADD", "${this.prefix}:worker:checklist", KEYS[1])
          end
          redis.call("XADD", KEYS[1], "*", "m", ARGV[1])
          redis.call("EXPIRE", KEYS[1], ${ROOM_STREAM_TTL})
        `

    this.redis = createClient({
      url,
      // scripting: https://github.com/redis/node-redis/#lua-scripts
      scripts: {
        addMessage: defineScript({
          NUMBER_OF_KEYS: 1,
          SCRIPT: addScript,
          /**
           * @param {string} key
           * @param {Buffer} message
           */
          transformArguments (key, message) {
            return [key, message]
          },
          /**
           * @param {null} x
           */
          transformReply (x) {
            return x
          }
        }),
        xDelIfEmpty: defineScript({
          NUMBER_OF_KEYS: 1,
          SCRIPT: `
            if redis.call("XLEN", KEYS[1]) == 0 then
              redis.call("DEL", KEYS[1])
            end
          `,
          /**
           * @param {string} key
           */
          transformArguments (key) {
            return [key]
          },
          /**
           * @param {null} x
           */
          transformReply (x) {
            return x
          }
        })
      }
    })
  }

  /**
   * @param {Array<{key:string,id:string}>} streams streamname-clock pairs
   * @return {Promise<Array<{ stream: string, messages: Array<Uint8Array>, lastId: string }>>}
   */
  async getMessages (streams) {
    if (streams.length === 0) {
      await promise.wait(50)
      return []
    }
    const reads = await this.redis.xRead(
      commandOptions({ returnBuffers: true }),
      streams,
      { BLOCK: 1000, COUNT: 1000 }
    )
    /**
     * @type {Array<{ stream: string, messages: Array<Uint8Array>, lastId: string }>}
     */
    const res = []
    reads?.forEach(stream => {
      res.push({
        stream: stream.name.toString(),
        messages: protocol.mergeMessages(stream.messages.map(message => message.message.m).filter(m => m != null)),
        lastId: array.last(stream.messages).id.toString()
      })
    })
    return res
  }

  /**
   * @param {string} room
   * @param {string} docid
   * @param {Buffer} m
   */
  addMessage (room, docid, m) {
    // handle sync step 2 like a normal update message
    if (m[0] === protocol.messageSync && m[1] === protocol.messageSyncStep2) {
      if (m.byteLength < 4) {
        // message does not contain any content, don't distribute
        return promise.resolve()
      }
      m[1] = protocol.messageSyncUpdate
    }
    return this.redis.addMessage(computeRedisRoomStreamName(room, docid, this.prefix), m)
  }

  /**
   * @param {string} room
   * @param {string} docid
   */
  async getStateVector (room, docid = '/') {
    return this.store.retrieveStateVector(room, docid)
  }

  /**
   * @param {string} room
   * @param {string} docid
   */
  async getDoc (room, docid) {
    const ms = extractMessagesFromStreamReply(await this.redis.xRead(commandOptions({ returnBuffers: true }), { key: computeRedisRoomStreamName(room, docid, this.prefix), id: '0' }), this.prefix)
    const docMessages = ms.get(room)?.get(docid) || null
    if (docMessages?.messages) logApi(`processing messages of length: ${docMessages?.messages.length} in room: ${room}`)
    const docstate = await this.store.retrieveDoc(room, docid)
    const ydoc = new Y.Doc()
    let awareness = null
    if (this.enableAwareness) {
      awareness = new awarenessProtocol.Awareness(ydoc)
      awareness.setLocalState(null) // we don't want to propagate awareness state
    }
    const now = performance.now()
    if (docstate) { Y.applyUpdateV2(ydoc, docstate.doc) }
    let changed = false
    ydoc.once('afterTransaction', (tr) => { changed = tr.changed.size > 0 })
    ydoc.transact(() => {
      docMessages?.messages.forEach(m => {
        const decoder = decoding.createDecoder(m)
        switch (decoding.readVarUint(decoder)) {
          case 0: { // sync message
            if (decoding.readVarUint(decoder) === 2) { // update message
              Y.applyUpdate(ydoc, decoding.readVarUint8Array(decoder))
            }
            break
          }
          case 1: { // awareness message
            if (this.enableAwareness && awareness) {
              awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), null)
            }
            break
          }
        }
      })
    })
    logApi(`took ${performance.now() - now}ms to process messages for room: ${room}`)
    return {
      ydoc,
      awareness,
      redisLastId: docMessages?.lastId.toString() || '0',
      storeReferences: docstate?.references || null,
      changed
    }
  }

  /**
   * @param {string} room
   * @param {string} docid
   */
  async getRedisLastId (room, docid) {
    const ms = extractMessagesFromStreamReply(await this.redis.xRead(commandOptions({ returnBuffers: true }), { key: computeRedisRoomStreamName(room, docid, this.prefix), id: '0' }), this.prefix)
    const docMessages = ms.get(room)?.get(docid) || null
    return docMessages?.lastId.toString() || '0'
  }

  /**
   * @param {string} room
   * @param {string} docid
   */
  async trimRoomStream (room, docid) {
    const roomName = computeRedisRoomStreamName(room, docid, this.prefix)
    const redisLastId = await this.getRedisLastId(room, docid)
    const lastId = number.parseInt(redisLastId.split('-')[0])
    await this.redis.xTrim(roomName, 'MINID', lastId - this.redisMinMessageLifetime)
  }

  /**
   * @param {Object} opts
   * @param {number} [opts.blockTime]
   * @param {number} [opts.tryReclaimCount]
   * @param {number} [opts.tryClaimCount]
   */
  async consumeWorkerQueue ({ blockTime = 1000, tryReclaimCount = 5, tryClaimCount = 5 } = {}) {
    /**
     * @type {Array<{stream: string, id: string}>}
     */
    const tasks = []
    if (tryReclaimCount > 0) {
      const reclaimedTasks = await this.redis.xAutoClaim(this.redisWorkerStreamName, this.redisWorkerGroupName, this.consumername, this.redisWorkerTimeout, '0', { COUNT: tryReclaimCount })
      reclaimedTasks.messages.forEach(m => {
        const stream = m?.message.compact
        stream && tasks.push({ stream, id: m?.id })
      })
    }
    if (tryClaimCount > 0) {
      const claimedTasks = await this.redis.xReadGroup(this.redisWorkerGroupName, this.consumername, { key: this.redisWorkerStreamName, id: '>' }, { COUNT: tryClaimCount - tasks.length, BLOCK: tasks.length === 0 ? blockTime : undefined })
      claimedTasks?.forEach(task => {
        task.messages.forEach(message => {
          const stream = message.message.compact
          stream && tasks.push({ stream, id: message.id })
        })
      })
    }
    tasks.length > 0 && logWorker('Accepted tasks ', { tasks })
    if (this.redis.isOpen) await this.redis.expire(this.workerSetName, 60 * 5)
    let reclaimCounts = 0
    await promise.all(tasks.map(async task => {
      const streamlen = await this.redis.xLen(task.stream)
      if (streamlen === 0) {
        await this.redis.multi()
          .xDelIfEmpty(task.stream)
          .xAck(this.redisWorkerStreamName, this.redisWorkerGroupName, task.id)
          .xDel(this.redisWorkerStreamName, task.id)
          .sRem(this.workerSetName, task.stream)
          .exec()
        logWorker('Stream still empty, removing recurring task from queue ', { stream: task.stream })
      } else {
        reclaimCounts++
        const { room, docid } = decodeRedisRoomStreamName(task.stream, this.prefix)
        const { ydoc, storeReferences, redisLastId, changed } = await this.getDoc(room, docid)
        const lastId = math.max(number.parseInt(redisLastId.split('-')[0]), number.parseInt(task.id.split('-')[0]))
        if (changed) {
          logWorker(`persisting changes in room: ${room}`)
          await this.store.persistDoc(room, docid, ydoc)
        } else logWorker(`skip persisting room: ${room} due to no changes`)
        await promise.all([
          storeReferences && changed ? this.store.deleteReferences(room, docid, storeReferences) : promise.resolve(),
          this.redis.multi()
            .xTrim(task.stream, 'MINID', lastId - this.redisMinMessageLifetime)
            .xAdd(this.redisWorkerStreamName, '*', { compact: task.stream })
            .xAck(this.redisWorkerStreamName, this.redisWorkerGroupName, task.id)
            .xDel(this.redisWorkerStreamName, task.id)
            .sAdd(this.workerSetName, task.stream)
            .exec()
        ])
        logWorker('Compacted stream ', { stream: task.stream, taskId: task.id, newLastId: lastId - this.redisMinMessageLifetime })
        try {
          if (ydocUpdateCallback != null) {
            // call YDOC_UPDATE_CALLBACK here
            const formData = new FormData()
            // @todo only convert ydoc to updatev2 once
            // @ts-ignore
            formData.append('ydoc', new Blob([Y.encodeStateAsUpdateV2(ydoc)]))
            // @todo should add a timeout to fetch (see fetch signal abortcontroller)
            const res = await fetch(new URL(room, ydocUpdateCallback), { body: formData, method: 'PUT' })
            if (!res.ok) {
              console.error(`Issue sending data to YDOC_UPDATE_CALLBACK. status="${res.status}" statusText="${res.statusText}"`)
            }
          }
        } catch (e) {
          console.error(e)
        }
        // destroy ydoc after persisting
        ydoc.destroy()
      }
    }))
    return { tasks, reclaimCounts }
  }

  async destroy () {
    this._destroyed = true
    try {
      await this.redis.quit()
    } catch (e) {}
  }
}

/**
 * @param {import('./storage.js').AbstractStorage} store
 * @param {{ redisPrefix?: string, redisUrl?: string, enableAwareness?: boolean }} opts
 */
export const createWorker = async (store, opts) => {
  const a = await createApiClient(store, opts)
  return new Worker(a)
}

export class Worker {
  /**
   * @param {Api} client
   * @param {Object} opts
   * @param {number} [opts.blockTime]
   * @param {number} [opts.tryReclaimCount]
   * @param {number} [opts.tryClaimCount]
   */
  constructor (client, opts = {}) {
    this.client = client
    logWorker('Created worker process ', { id: client.consumername, prefix: client.prefix, minMessageLifetime: client.redisMinMessageLifetime })
    ;(async () => {
      let prev = performance.now()
      while (!client._destroyed) {
        try {
          const { reclaimCounts } = await client.consumeWorkerQueue(opts)
          const now = performance.now()
          if (reclaimCounts === 0) {
            await promise.wait(client.redisWorkerTimeout)
          } else if (now - prev < client.redisWorkerTimeout) {
            await promise.wait(client.redisWorkerTimeout - (now - prev))
          }
          prev = now

          await this.checkAndRecoverOrphanStreams()
        } catch (e) {
          console.error(e)
        }
      }
      logWorker('Ended worker process ', { id: client.consumername })
    })()
  }

  async checkAndRecoverOrphanStreams () {
    if (!this.client.redis.isOpen) return
    const rawConsumers = await this.client.redis.xInfoConsumers(
      this.client.redisWorkerStreamName,
      this.client.redisWorkerGroupName
    )
    const consumers = rawConsumers
      .filter((c) => c.pending > 0 || c.inactive < this.client.redisWorkerTimeout)
      .map(({ name }) => name)
    const leader = consumers.sort()[0]
    if (this.client.consumername !== leader) return

    /** @type {Set<string>} */
    const processingSet = new Set()
    for (const consumer of consumers) {
      const ids = await this.client.redis.sMembers(
        `${this.client.prefix}:worker:${consumer}:idset`
      )
      for (const id of ids) processingSet.add(id)
    }

    const checkListKey = `${this.client.prefix}:worker:checklist`
    const checklist = await this.client.redis.sMembers(checkListKey)

    const orphans = checklist.filter((room) => !processingSet.has(room))
    if (!orphans) return
    logWorker(`adding ${orphans.length} orphans back to worker`)

    await Promise.all(
      orphans.map((room) =>
        this.client.redis.xAdd(
          this.client.redisWorkerStreamName,
          '*',
          { compact: room }
        )
      )
    )
    await this.client.redis.del(checkListKey)
  }
}
