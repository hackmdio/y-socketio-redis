export class User {
  /**
   * @param {string} room
   * @param {string} userid identifies the user globally.
   */
  constructor(room, userid) {
    this.room = room
    /**
     * @type {string}
     */
    this.initialRedisSubId = '0'
    /**
     * @type {Set<string>}
     */
    this.subs = new Set()
    /**
     * Identifies the User globally.
     * Note that several clients can have the same userid (e.g. if a user opened several browser
     * windows)
     */
    this.userid = userid
  }
}
