import { useEffect, useState } from 'react'

/** 单个任务运行浮条与摘要的纯展示状态。 */
export type StoryboardAgentMonitorUi = {
  dismissed: boolean
  expanded: boolean
  open: boolean
}

export const DEFAULT_MONITOR_UI: StoryboardAgentMonitorUi = {
  dismissed: false,
  expanded: false,
  open: false,
}

/** 监控浮条的展示状态与操作句柄（由页面层持有，跨任务切换保留）。 */
export type StoryboardAgentMonitorHandle = ReturnType<typeof useStoryboardAgentMonitor>

/**
 * 管理真实运行记录的浮条开合与运行计时，不推演任何 Agent 业务阶段。
 *
 * @param live - 当前选中 session 是否有进行中的 Agent 运行（驱动计时刷新）。
 * @returns 监控浮条展示状态与操作。
 */
export const useStoryboardAgentMonitor = (live: boolean) => {
  const [monitorUiByConversation, setMonitorUiByConversation] = useState<
    Record<string, StoryboardAgentMonitorUi>
  >({})
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!live) return

    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [live])

  const update = (
    conversationId: string,
    updater: (current: StoryboardAgentMonitorUi) => StoryboardAgentMonitorUi,
  ) => {
    setMonitorUiByConversation((current) => ({
      ...current,
      [conversationId]: updater(current[conversationId] ?? DEFAULT_MONITOR_UI),
    }))
  }

  return {
    close: (conversationId: string) =>
      update(conversationId, (current) => ({ ...current, expanded: false, open: false })),
    dismiss: (conversationId: string) =>
      update(conversationId, (current) => ({ ...current, dismissed: true })),
    monitorUiByConversation,
    nowMs,
    open: (conversationId: string, expanded = true) =>
      update(conversationId, (current) => ({
        ...current,
        dismissed: false,
        expanded,
        open: true,
      })),
    toggleExpanded: (conversationId: string) =>
      update(conversationId, (current) => ({ ...current, expanded: !current.expanded })),
  }
}
