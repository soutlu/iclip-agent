import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { resetMockConversations, resetMockSession, resetMockTasks } from './mocks/handlers'
import { server } from './mocks/server'
import { resetMockWorkspace } from './mocks/workspace'

// jsdom 没有 matchMedia：组件按断点取初始态（如侧栏在紧凑屏默认折叠）时需要最小实现。
// matches 恒为 false——测试里一律视为紧凑屏。
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
}

// jsdom 没有布局几何：ProseMirror 在选区变化时会量光标位置（Range / 元素的 getClientRects），
// 没有这两个方法就抛未捕获异常。给一个「一个矩形都没有」的答案，编辑器照常工作、只是不滚动。
const noRects = () => ({ length: 0, item: () => null }) as unknown as DOMRectList
const zeroRect = () =>
  ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0 }) as DOMRect
for (const proto of [Range.prototype, Element.prototype]) {
  if (!('getClientRects' in proto))
    Object.defineProperty(proto, 'getClientRects', { value: noRects })
  if (!('getBoundingClientRect' in proto)) {
    Object.defineProperty(proto, 'getBoundingClientRect', { value: zeroRect })
  }
}

// 网络一律过 MSW：没写 handler 的请求直接报错，而不是静默打到真后端。
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})

afterEach(() => {
  server.resetHandlers()
  server.events.removeAllListeners()
  resetMockConversations()
  resetMockSession()
  resetMockTasks()
  resetMockWorkspace()
  cleanup()
})

afterAll(() => {
  server.close()
})
