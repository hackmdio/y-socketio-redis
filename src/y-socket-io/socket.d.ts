import type { User } from './user.js'

declare module 'socket.io' {
  interface Socket {
    user?: User
  }
}
