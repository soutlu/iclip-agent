import { ExportedMessageRepository, useAuiState } from '@assistant-ui/react'
import { fromAgUiMessages } from '@assistant-ui/react-ag-ui'
import type { ReadonlyJSONValue } from 'assistant-stream/utils'
import { useCallback, useEffect, type ReactNode } from 'react'
import { z } from 'zod'
import AguiSessionRuntimeProvider, { type AguiRestoreHistory } from '@/shared/agui/provider'
import { apiFetch } from '@/shared/api/client'
import { requiredStringSchema } from '@/shared/api/schemas'
import { STORYBOARD_AGUI_TARGET } from '@/shared/config/agui-target'

const storyboardRestoreSchema = z.object({
  activeRun: z
    .object(
      { runId: requiredStringSchema('AG-UI restore activeRun 缺少 runId。') },
      { error: 'AG-UI restore activeRun 格式无效。' },
    )
    .nullable(),
  messages: z.array(z.unknown(), { error: 'AG-UI restore 响应缺少 messages 数组。' }),
  state: z.unknown().optional(),
})

/**
 * 加载 Storyboard session 的 restore 快照。
 *
 * 「是否有 run 可重连」只由响应中的 `activeRun` 决定（后端归因唯一权威，
 * ADR-0005）；Storyboard 输出是线性历史，不消费 headId 分支信息。
 *
 * @param sessionId - 当前 Agno session id，同时作为 AG-UI threadId。
 * @returns restore repository 与 activeRun 决策。
 */
const loadStoryboardHistory = async (
  sessionId: string,
  showThinking: boolean,
): Promise<AguiRestoreHistory> => {
  const payload = await apiFetch(
    `${STORYBOARD_AGUI_TARGET.path}/restore`,
    storyboardRestoreSchema,
    {
      body: { threadId: sessionId },
      cache: 'no-store',
      fallbackErrorMessage: '加载 Storyboard 会话失败',
      method: 'POST',
    },
  )

  return {
    activeRun: payload.activeRun,
    repository: {
      ...ExportedMessageRepository.fromArray(fromAgUiMessages(payload.messages, { showThinking })),
      state: (payload.state ?? {}) as ReadonlyJSONValue,
      unstable_resume: false,
    },
  }
}

/** 把当前 session 的 thread 运行态上报给页面层（书签徽标与监控计时用）。 */
function StoryboardSessionRunReporter({
  onRunningChange,
  sessionId,
}: {
  onRunningChange: (sessionId: string, running: boolean) => void
  sessionId: string
}) {
  const isRunning = useAuiState((state) => state.thread.isRunning)

  useEffect(() => {
    onRunningChange(sessionId, isRunning)
    return () => onRunningChange(sessionId, false)
  }, [isRunning, onRunningChange, sessionId])

  return null
}

/**
 * 为一个 Storyboard session 提供官方 AG-UI runtime。
 *
 * 每个 session 一个独立 runtime host（与 project 页同构）：切换任务不掐流，
 * 后台 run 由 restore 的 `activeRun` 在注水后自动 attach；断线重连与卸载
 * abort 防误杀由通用 `AguiSessionRuntimeProvider` 承担。
 */
export function StoryboardAssistantProvider({
  children,
  onRunningChange,
  onRuntimeError,
  sessionId,
  showThinking = false,
}: {
  children?: ReactNode
  onRunningChange: (sessionId: string, running: boolean) => void
  onRuntimeError: (error: Error) => void
  sessionId: string
  showThinking?: boolean
}) {
  const loadHistory = useCallback(
    (threadSessionId: string) => loadStoryboardHistory(threadSessionId, showThinking),
    [showThinking],
  )

  return (
    <AguiSessionRuntimeProvider
      loadHistory={loadHistory}
      onRuntimeError={onRuntimeError}
      runUrl={STORYBOARD_AGUI_TARGET.apiPrefix}
      sessionId={sessionId}
      showThinking={showThinking}
    >
      <StoryboardSessionRunReporter onRunningChange={onRunningChange} sessionId={sessionId} />
      {children}
    </AguiSessionRuntimeProvider>
  )
}
