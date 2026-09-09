/** 通过 Context 注入连接与读取器登记表，允许测试替换 WebSocket 实现而无需 mock 模块。 */

import { createContext } from 'react'
import type { TranscriptConnection } from './connection'
import type { TranscriptReaders } from './readers'

export const TranscriptConnectionContext = createContext<TranscriptConnection | null>(null)

export const TranscriptReadersContext = createContext<TranscriptReaders | null>(null)
