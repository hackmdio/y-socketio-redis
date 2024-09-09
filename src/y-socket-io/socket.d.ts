import type { User } from './user.js'

declare module 'socket.io' {
  class Socket {
    user?: User
  }
}
