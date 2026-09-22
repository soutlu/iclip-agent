/** jsdom 不加载媒体，`loadedmetadata` 永远不来；探时长的组件测试用这个桩按地址给时长。 */

import { vi } from 'vitest'

/** 给每个地址一个时长（秒）；`null` 是读不到（触发 `error`）。没列的地址照 jsdom 的样子静默。
 *
 * 只在 `src` 被赋值时回调，与 `useMediaDurations` 先挂事件再赋 `src` 的顺序一致；返回恢复函数。 */
export const stubMediaDurations = (durations: Readonly<Record<string, number | null>>) => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return this.getAttribute('src') ?? ''
    },
    set(this: HTMLMediaElement, url: string) {
      this.setAttribute('src', url)
      const duration = durations[url]
      if (duration === undefined) return
      queueMicrotask(() => {
        if (duration === null) {
          this.dispatchEvent(new Event('error'))
          return
        }
        Object.defineProperty(this, 'duration', { configurable: true, value: duration })
        this.dispatchEvent(new Event('loadedmetadata'))
      })
    },
  })
  return () => {
    if (descriptor !== undefined)
      Object.defineProperty(HTMLMediaElement.prototype, 'src', descriptor)
  }
}
