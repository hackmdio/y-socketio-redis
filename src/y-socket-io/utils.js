/**
 * Basically Promise.withResolvers()
 * @template T
 * @see https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers
 */
export function promiseWithResolvers () {
  /** @type {(value: T | PromiseLike<T>) => void} */
  let res = () => {}
  /** @type {(reason?: Error) => void} */
  let rej = () => {}
  /** @type {Promise<T>} */
  const promise = new Promise((resolve, reject) => {
    res = resolve
    rej = reject
  })
  return { promise, resolve: res, reject: rej }
}
