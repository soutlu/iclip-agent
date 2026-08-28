import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { resetMockSession } from './mocks/handlers'
import { server } from './mocks/server'

// 网络一律过 MSW：没写 handler 的请求直接报错，而不是静默打到真后端。
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})

afterEach(() => {
  server.resetHandlers()
  server.events.removeAllListeners()
  resetMockSession()
  cleanup()
})

afterAll(() => {
  server.close()
})
