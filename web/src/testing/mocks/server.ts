import { setupServer } from 'msw/node'
import { handlers } from './handlers'

/** 单测（node 端）用的 MSW：与浏览器原型同一份 handlers。 */
export const server = setupServer(...handlers)
