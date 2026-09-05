/** 通过 Context 注入连接，允许测试替换 WebSocket 实现而无需 mock 模块。 */

import { createContext } from 'react'
import type { TranscriptConnection } from './connection'

export const TranscriptConnectionContext = createContext<TranscriptConnection | null>(null)
