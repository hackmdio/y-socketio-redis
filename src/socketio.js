import { YSocketIO } from './y-socket-io/y-socket-io.js'

/**
 * how to sync
 *   receive sync-step 1
 *   // @todo y-websocket should only accept updates after receiving sync-step 2
 *   redisId = ws.sub(conn)
 *   {doc,redisDocLastId} = api.getdoc()
 *   compute sync-step 2
 *   if (redisId > redisDocLastId) {
 *     subscriber.ensureId(redisDocLastId)
 *   }
 */

class YSocketIOServer {
  /**
   * @param {YSocketIO} app
   * @param {import('./api.js').Api} client
   * @param {import('./subscriber.js').Subscriber} subscriber
   */
  constructor (app, client, subscriber) {
    this.app = app
    this.subscriber = subscriber
    this.client = client
  }

  async destroy () {
    this.subscriber.destroy()
    await this.client.destroy()
  }
}

/**
 * @param {import('socket.io').Server} io
 * @param {import('./storage.js').AbstractStorage} store
 * @param {Object} conf
 * @param {string} [conf.redisPrefix]
 * @param {import('./y-socket-io/y-socket-io.js').YSocketIOConfiguration['authenticate']} conf.authenticate
 */
export const registerYSocketIOServer = async (io, store, conf) => {
  const app = new YSocketIO(io, { authenticate: conf.authenticate })
  const { client, subscriber } = await app.initialize(store, conf)
  return new YSocketIOServer(app, client, subscriber)
}
