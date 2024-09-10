/* eslint-env node */

import * as api from './api.tests.js'
import * as storage from './storage.tests.js'
import * as socketio from './socketio.tests.js'
import { runTests } from 'lib0/testing'

runTests({
  storage,
  api,
  socketio
}).then((success) => {
  process.exit(success ? 0 : 1)
})
