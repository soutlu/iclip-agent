/**
 * 这个标签页唯一那条订阅连接的存放处。
 *
 * 连接放 context 而不是模块顶层：测试要能换掉 WebSocket 实现（同仓模块不许 `vi.mock`）。
 */

import { createContext } from 'react'
import type { TranscriptConnection } from './connection'

export const TranscriptConnectionContext = createContext<TranscriptConnection | null>(null)
