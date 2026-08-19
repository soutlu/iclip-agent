import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProducerVideoGenerationSubmission } from '@/features/projects/producer-project.types'
import { errorFromUnknown, isRecord, nonEmptyString } from '@/shared/lib/guards'

export type ProducerGenerationScope =
  { projectId: string; type: 'project' } | { sessionId: string; type: 'session' }

export interface ProducerGenerationFacts {
  error: Error | null
  generations: Record<string, unknown>[]
}

const GENERATION_WS_PATH = '/generations/ws'
const GENERATION_WS_RECONNECT_DELAY_MS = 1000
const GENERATION_WS_SUBPROTOCOL = 'iclip-generation-v1'

const recordArray = (value: unknown, field: string) => {
  if (!Array.isArray(value)) {
    throw new Error(`generation WS ${field} 必须是数组`)
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`generation WS ${field}[${index}] 必须是对象`)
    }

    if (!nonEmptyString(item.id)) {
      throw new Error(`generation WS ${field}[${index}] 缺少 id`)
    }

    return item
  })
}

const generationRecord = (value: unknown, field: string) => {
  if (!isRecord(value)) {
    throw new Error(`generation WS ${field} 必须是对象`)
  }

  if (!nonEmptyString(value.id)) {
    throw new Error(`generation WS ${field} 缺少 id`)
  }

  return value
}

const GENERATION_STATUS_RANK: Record<string, number> = {
  created: 1,
  submitted: 2,
  completed: 3,
  failed: 3,
}
const GENERATION_ACTIVE_STATUSES = new Set(['created', 'submitted'])
const GENERATION_INACTIVE_STATUSES = new Set(['completed', 'failed'])

const buildGenerationWsUrl = () => {
  // 同源 /api 前缀经 dev/prod 代理直达后端，会话 HttpOnly cookie 在握手时自动携带。
  const wsUrl = new URL(`/api${GENERATION_WS_PATH}`, globalThis.location.origin)

  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'

  return wsUrl.toString()
}

const timestampMs = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  const parsed = Date.parse(value)

  return Number.isFinite(parsed) ? parsed : null
}

const generationRecordRank = (record: Record<string, unknown>) => {
  const status = nonEmptyString(record.status)

  return status ? (GENERATION_STATUS_RANK[status] ?? 0) : 0
}

const shouldUseGenerationUpdate = (
  current: Record<string, unknown>,
  update: Record<string, unknown>,
) => {
  const currentRank = generationRecordRank(current)
  const updateRank = generationRecordRank(update)

  if (updateRank !== currentRank) {
    return updateRank > currentRank
  }

  const currentUpdatedAt = timestampMs(current.updatedAt)
  const updateUpdatedAt = timestampMs(update.updatedAt)

  if (
    currentUpdatedAt !== null &&
    updateUpdatedAt !== null &&
    currentUpdatedAt !== updateUpdatedAt
  ) {
    return updateUpdatedAt > currentUpdatedAt
  }

  if (currentUpdatedAt !== null && updateUpdatedAt === null) {
    return false
  }

  if (currentUpdatedAt === null && updateUpdatedAt !== null) {
    return true
  }

  return true
}

export const producerGenerationRecordFromSubmission = (
  submission: ProducerVideoGenerationSubmission,
): Record<string, unknown> => ({
  assetType: submission.generation.assetType,
  completedAt: submission.generation.completedAt,
  createdAt: submission.generation.createdAt,
  errorCode: submission.generation.errorCode,
  errorMessage: submission.generation.errorMessage,
  failedAt: submission.generation.failedAt,
  id: submission.generation.id,
  providerSnapshot: submission.generation.providerSnapshot,
  providerStatus: submission.generation.providerStatus,
  providerTaskId: submission.generation.providerTaskId,
  requestPayload: submission.generation.requestPayload,
  status: submission.generation.rawStatus,
  submittedAt: submission.generation.submittedAt,
  updatedAt: submission.generation.updatedAt,
})

export const mergeProducerGenerationRecords = (
  current: Record<string, unknown>[],
  updates: Record<string, unknown>[],
) => {
  const recordsById = new Map<string, Record<string, unknown>>()

  for (const record of current) {
    const id = nonEmptyString(record.id)

    if (!id) {
      throw new Error('generation record 缺少 id')
    }

    recordsById.set(id, record)
  }

  for (const record of updates) {
    const id = nonEmptyString(record.id)

    if (!id) {
      throw new Error('generation record 缺少 id')
    }

    const currentRecord = recordsById.get(id)

    if (!currentRecord || shouldUseGenerationUpdate(currentRecord, record)) {
      recordsById.set(id, record)
    }
  }

  return [...recordsById.values()]
}

export const producerGenerationRecordsKey = (records: Record<string, unknown>[]) =>
  JSON.stringify(records)

export const hasActiveProducerGenerations = (records: Record<string, unknown>[]) => {
  for (const record of records) {
    const status = nonEmptyString(record.status)

    if (!status) {
      throw new Error('generation record 缺少 status')
    }

    if (GENERATION_ACTIVE_STATUSES.has(status)) {
      return true
    }

    if (!GENERATION_INACTIVE_STATUSES.has(status)) {
      throw new Error(`generation status 无效：${status}`)
    }
  }

  return false
}

export const applyProducerGenerationEvent = (
  current: Record<string, unknown>[],
  event: unknown,
): Record<string, unknown>[] => {
  if (!isRecord(event)) {
    throw new Error('generation WS event 必须是对象')
  }

  switch (event.type) {
    case 'generation.snapshot':
      return mergeProducerGenerationRecords(current, recordArray(event.generations, 'generations'))
    case 'generation.updated':
      return mergeProducerGenerationRecords(current, [
        generationRecord(event.generation, 'generation'),
      ])
    case 'generation.heartbeat':
      return current
    default:
      throw new Error(`未知 generation WS event: ${String(event.type)}`)
  }
}

/**
 * 订阅后端 generation facts，并维护当前 scope 下的 generation 列表。
 *
 * @param scope - project 或 session generation 订阅范围。
 * @returns 当前 generation facts 与连接错误。
 */
export const useProducerGenerationFacts = (
  scope: ProducerGenerationScope,
): ProducerGenerationFacts => {
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope])
  const recordsRef = useRef<Record<string, unknown>[]>([])
  const [facts, setFacts] = useState<ProducerGenerationFacts>({
    error: null,
    generations: [],
  })

  useEffect(() => {
    const subscriptionScope = JSON.parse(scopeKey) as ProducerGenerationScope
    let closedByEffect = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let socket: WebSocket | null = null

    recordsRef.current = []
    setFacts({ error: null, generations: [] })

    const setError = (error: unknown) => {
      if (closedByEffect) {
        return
      }

      setFacts({
        error: errorFromUnknown(error),
        generations: recordsRef.current,
      })
    }

    const clearReconnectTimer = () => {
      if (reconnectTimer === null) {
        return
      }

      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    const scheduleReconnect = () => {
      if (closedByEffect) {
        return
      }

      clearReconnectTimer()
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        try {
          connect()
        } catch (error) {
          setError(error)
        }
      }, GENERATION_WS_RECONNECT_DELAY_MS)
    }

    const connect = () => {
      if (typeof WebSocket === 'undefined') {
        throw new Error('当前运行环境不支持 WebSocket。')
      }

      const nextSocket = new WebSocket(buildGenerationWsUrl(), [GENERATION_WS_SUBPROTOCOL])
      socket = nextSocket
      nextSocket.addEventListener('open', () => {
        if (closedByEffect || socket !== nextSocket) {
          return
        }

        nextSocket.send(
          JSON.stringify({
            scope: subscriptionScope,
            type: 'subscribe',
          }),
        )
      })
      nextSocket.addEventListener('message', (event) => {
        if (closedByEffect || socket !== nextSocket) {
          return
        }

        try {
          const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
          const generations = applyProducerGenerationEvent(recordsRef.current, payload)

          recordsRef.current = generations
          setFacts({
            error: null,
            generations,
          })
        } catch (error) {
          setError(error)
        }
      })
      nextSocket.addEventListener('error', () => {
        if (closedByEffect || socket !== nextSocket) {
          return
        }

        socket = null
        scheduleReconnect()
      })
      nextSocket.addEventListener('close', () => {
        if (closedByEffect || socket !== nextSocket) {
          return
        }

        socket = null
        scheduleReconnect()
      })
    }

    queueMicrotask(() => {
      if (closedByEffect) {
        return
      }

      try {
        connect()
      } catch (error) {
        setError(error)
      }
    })

    return () => {
      closedByEffect = true
      clearReconnectTimer()
      socket?.close(1000, 'scope changed')
    }
  }, [scopeKey])

  return facts
}
