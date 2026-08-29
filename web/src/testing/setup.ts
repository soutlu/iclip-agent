import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { resetMockSession, resetMockTasks } from './mocks/handlers'
import { server } from './mocks/server'

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

// 网络一律过 MSW：没写 handler 的请求直接报错，而不是静默打到真后端。
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})

afterEach(() => {
  server.resetHandlers()
  server.events.removeAllListeners()
  resetMockSession()
  resetMockTasks()
  cleanup()
})

afterAll(() => {
  server.close()
})
