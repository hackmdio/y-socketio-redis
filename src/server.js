import * as env from 'lib0/environment'
import * as logging from 'lib0/logging'
import * as jwt from 'lib0/crypto/jwt'
import * as ecdsa from 'lib0/crypto/ecdsa'
import * as json from 'lib0/json'
import { Server } from 'socket.io'
import { registerYSocketIOServer } from './socketio.js'
import http from 'http'
import { randomUUID } from 'crypto'

const authPublicKey = env.getConf('auth-public-key')
/** @type {CryptoKey | null} */
let wsServerPublicKey = null
if (authPublicKey) {
  ecdsa
    .importKeyJwk(json.parse(env.ensureConf('auth-public-key')))
    .then((key) => { wsServerPublicKey = key })
}

/**
 * @param {Object} opts
 * @param {number} opts.port
 * @param {import('./storage.js').AbstractStorage} opts.store
 * @param {string} [opts.redisPrefix]
 */
export const createYSocketIOServer = async ({
  redisPrefix = 'y',
  port,
  store
}) => {
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  const io = new Server(httpServer)

  const server = await registerYSocketIOServer(io, store, {
    redisPrefix,
    authenticate: async (socket) => {
      if (!wsServerPublicKey) return { userid: randomUUID().toString() }
      const token = socket.handshake.query.yauth
      if (!token) return null
      // verify that the user has a valid token
      const { payload: userToken } = await jwt.verifyJwt(
        wsServerPublicKey,
        typeof token === 'string' ? token : token[0]
      )
      if (!userToken.yuserid) return null
      return { userid: userToken.yuserid }
    }
  })

  httpServer.listen(port, undefined, undefined, () => {
    logging.print(logging.GREEN, '[y-redis] Listening to port ', port)
  })
  return server
}
