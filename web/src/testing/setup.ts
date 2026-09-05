import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { resetMockConversations, resetMockSession, resetMockTasks } from './mocks/handlers'
import { server } from './mocks/server'
import { resetMockWorkspace } from './mocks/workspace'

// matchMedia 恒为 false，模拟紧凑屏。
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

// 提供空几何结果，满足 ProseMirror 选区 API；jsdom 不执行真实滚动。
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

// 未声明 handler 的请求直接报错，避免访问真实后端。
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
