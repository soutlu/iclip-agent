import { ExportedMessageRepository, useAuiState } from '@assistant-ui/react'
import { fromAgUiMessages } from '@assistant-ui/react-ag-ui'
import { useCallback, useEffect, type ReactNode } from 'react'
import { listConversationMessages } from '@/features/conversations'
import AguiConversationRuntimeProvider, { type AguiHistoryRepository } from '@/shared/agui/provider'
import { STORYBOARD_AGENT } from '@/shared/config/agui-target'

/**
 * 读一段 Storyboard 对话的历史并还原成 runtime 能注水的 repository。
 *
 * 后端给的是服务端最新那份存档里的 AG-UI 消息（一次都没跑过就是空数组）；
 * Storyboard 输出是线性历史，直接按数组还原，没有分支信息要消费。
 */
const loadStoryboardHistory = async (
  conversationId: string,
  showThinking: boolean,
): Promise<AguiHistoryRepository> => {
  const messages = await listConversationMessages(conversationId)

  return {
    ...ExportedMessageRepository.fromArray(fromAgUiMessages(messages, { showThinking })),
    state: {},
    unstable_resume: false,
  }
}

/** 把当前对话的 thread 运行态上报给页面层（书签徽标与监控计时用）。 */
function StoryboardRunReporter({
  conversationId,
  onRunningChange,
}: {
  conversationId: string
  onRunningChange: (conversationId: string, running: boolean) => void
}) {
  const isRunning = useAuiState((state) => state.thread.isRunning)

  useEffect(() => {
    onRunningChange(conversationId, isRunning)
    return () => onRunningChange(conversationId, false)
  }, [conversationId, isRunning, onRunningChange])

  return null
}

/**
 * 为一段 Storyboard 对话提供官方 AG-UI runtime。
 *
 * 每段对话一个独立 runtime host：切换任务不掐流；卸载时的 abort 防误杀由通用
 * `AguiConversationRuntimeProvider` 承担。
 */
export function StoryboardAssistantProvider({
  children,
  conversationId,
  onRunningChange,
  onRuntimeError,
  showThinking = false,
}: {
  children?: ReactNode
  conversationId: string
  onRunningChange: (conversationId: string, running: boolean) => void
  onRuntimeError: (error: Error) => void
  showThinking?: boolean
}) {
  const loadHistory = useCallback(
    (id: string) => loadStoryboardHistory(id, showThinking),
    [showThinking],
  )

  return (
    <AguiConversationRuntimeProvider
      conversationId={conversationId}
      loadHistory={loadHistory}
      onRuntimeError={onRuntimeError}
      runUrl={STORYBOARD_AGENT.runUrl}
      showThinking={showThinking}
    >
      <StoryboardRunReporter conversationId={conversationId} onRunningChange={onRunningChange} />
      {children}
    </AguiConversationRuntimeProvider>
  )
}
