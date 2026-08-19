import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

/** 显式 mock profile 使用的完整浏览器 Mock。 */
export const worker = setupWorker(...handlers)
