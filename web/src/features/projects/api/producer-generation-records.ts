import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  mergeProducerGenerationRecords,
  type ProducerGenerationScope,
  producerGenerationRecordsKey,
  useProducerGenerationFacts,
} from '@/features/projects/api/producer-generation-events'
import {
  listProducerProjectGenerations,
  listProducerSessionGenerations,
} from '@/features/projects/api/producer-generation.api'
import type { ProducerGenerationRecord } from '@/features/projects/producer-project.types'
import { errorFromUnknown } from '@/shared/lib/guards'

interface ProducerGenerationRecordsState {
  error: Error | null
  generationRecords: ProducerGenerationRecord[]
  isInitialLoadPending: boolean
  mergeLocalGenerationRecords: (records: ProducerGenerationRecord[]) => void
}

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

const areJsonSerializableValuesEqual = (left: unknown, right: unknown) => {
  if (Object.is(left, right)) {
    return true
  }

  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

const preserveEqualSerializableValue = <T>(current: T, next: T) =>
  areJsonSerializableValuesEqual(current, next) ? current : next

const listPersistedGenerations = (
  scope: ProducerGenerationScope,
  options: { signal?: AbortSignal } = {},
) => {
  if (scope.type === 'project') {
    return listProducerProjectGenerations(scope.projectId, options)
  }

  return listProducerSessionGenerations(scope.sessionId, options)
}

/**
 * 统一维护 generation facts：HTTP 负责刷新恢复，WS 负责实时增量，本地提交响应也走同一 merge 入口。
 *
 * @param scope - project 或 session generation 作用域。
 * @returns 当前 scope 的已合并 generation records、错误和本地 merge 入口。
 */
export const useProducerGenerationRecords = (
  scope: ProducerGenerationScope,
): ProducerGenerationRecordsState => {
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope])
  const stableScope = useMemo(() => JSON.parse(scopeKey) as ProducerGenerationScope, [scopeKey])
  const liveFacts = useProducerGenerationFacts(stableScope)
  const liveGenerationsRef = useRef(liveFacts.generations)
  const recordsRef = useRef<ProducerGenerationRecord[]>([])
  const ignoredLiveRecordsKeyRef = useRef(producerGenerationRecordsKey(liveFacts.generations))
  const [error, setError] = useState<Error | null>(null)
  const [generationRecords, setGenerationRecords] = useState<ProducerGenerationRecord[]>([])
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null)

  liveGenerationsRef.current = liveFacts.generations

  const applyRecords = useCallback((updates: ProducerGenerationRecord[]) => {
    if (updates.length === 0) {
      return
    }

    const merged = mergeProducerGenerationRecords(recordsRef.current, updates)

    recordsRef.current = merged
    setGenerationRecords((current) => preserveEqualSerializableValue(current, merged))
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    ignoredLiveRecordsKeyRef.current = producerGenerationRecordsKey(liveGenerationsRef.current)
    recordsRef.current = []
    setError(null)
    setGenerationRecords([])
    setLoadedScopeKey(null)

    listPersistedGenerations(stableScope, { signal: controller.signal })
      .then((records) => {
        if (controller.signal.aborted) {
          return
        }

        applyRecords(records)
        setLoadedScopeKey(scopeKey)
      })
      .catch((candidateError: unknown) => {
        if (isAbortError(candidateError)) {
          return
        }

        setError(errorFromUnknown(candidateError))
      })

    return () => {
      controller.abort()
    }
  }, [applyRecords, scopeKey, stableScope])

  useEffect(() => {
    const liveRecordsKey = producerGenerationRecordsKey(liveFacts.generations)

    if (liveRecordsKey === ignoredLiveRecordsKeyRef.current) {
      return
    }

    ignoredLiveRecordsKeyRef.current = liveRecordsKey

    try {
      applyRecords(liveFacts.generations)
    } catch (candidateError) {
      setError(errorFromUnknown(candidateError))
    }
  }, [applyRecords, liveFacts.generations])

  useEffect(() => {
    if (!liveFacts.error) {
      return
    }

    setError(liveFacts.error)
  }, [liveFacts.error])

  return {
    error,
    generationRecords,
    isInitialLoadPending: loadedScopeKey !== scopeKey,
    mergeLocalGenerationRecords: applyRecords,
  }
}
