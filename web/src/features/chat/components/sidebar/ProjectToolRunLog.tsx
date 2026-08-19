import type { ReactNode } from 'react'
import type {
  ProjectToolLogEntry,
  ProjectToolLogSegmentTimelineItem,
} from '@/features/chat/contracts'
import { cn } from '@/shared/lib/utils'

export type ProjectToolLogDetailsRenderer = (toolCallId: string) => ReactNode

/**
 * 获取工具运行日志的用户可见状态。
 *
 * @param stage - 工具日志阶段。
 * @returns 展示文案和样式标记。
 */
export const getProjectToolRunLogStatusMeta = (stage: ProjectToolLogEntry['stage']) => {
  switch (stage) {
    case 'completed':
      return {
        icon: 'check',
        label: '已运行',
        textClassName: 'text-[color:var(--color-chat-status-success)]',
      }
    case 'failed':
      return {
        icon: 'error',
        label: '运行失败',
        textClassName: 'text-[color:var(--color-chat-error-text)]',
      }
    case 'started':
      return {
        icon: 'running',
        label: '运行中',
        textClassName: 'text-[color:var(--color-chat-status-running)]',
      }
    default:
      return {
        icon: 'check',
        label: '已运行',
        textClassName: 'text-[color:var(--color-chat-status-success)]',
      }
  }
}

/**
 * 获取工具运行日志的动作文案。
 *
 * @param log - 工具日志条目。
 * @returns 去掉阶段词后的动作文案。
 */
export const getProjectToolRunLogActionText = (log: ProjectToolLogEntry) => {
  switch (log.rawToolName) {
    case 'edit_file':
      return '制片人编辑文件'
    case 'get_skill_instructions':
      return '制片人加载技能'
    case 'get_skill_reference':
      return '制片人加载创作参考'
    case 'image_parser':
      return '制片人分析图片'
    case 'list_files':
      return '制片人列出文件'
    case 'read_file':
      return '制片人读取文件'
    case 'search_content':
      return '制片人搜索内容'
    case 'video_parser':
      return '制片人分析视频'
    case 'write_file':
      return '制片人写入文件'
    default:
      return log.message
  }
}

/**
 * 格式化工具运行日志正文。
 *
 * @param log - 工具日志条目。
 * @returns 包含目标素材标签的日志正文。
 */
export const formatProjectToolRunLogText = (log: ProjectToolLogEntry) => {
  const actionText = getProjectToolRunLogActionText(log)

  return log.targetLabel ? `${actionText} ${log.targetLabel}` : actionText
}

/**
 * 按时间顺序整理工具日志。
 *
 * @param logs - 当前 timeline 段工具日志。
 * @returns 时间升序排列后的日志。
 */
export const orderedProjectToolRunLogs = (logs: ProjectToolLogEntry[]) =>
  logs
    .map((log, index) => ({ index, log }))
    .sort((left, right) => left.log.timestamp - right.log.timestamp || left.index - right.index)
    .map(({ log }) => log)

/**
 * 从工具日志中选出默认折叠行展示的当前日志。
 *
 * @param logs - 当前 timeline 段工具日志。
 * @returns 优先返回仍在运行的最新日志，否则返回最后一条日志。
 */
export const latestProjectToolRunLog = (logs: ProjectToolLogEntry[]) => {
  const orderedLogs = orderedProjectToolRunLogs(logs)

  for (let index = orderedLogs.length - 1; index >= 0; index -= 1) {
    const log = orderedLogs[index]

    if (log?.stage === 'started') {
      return log
    }
  }

  return orderedLogs.at(-1) ?? null
}

/**
 * 渲染工具运行状态图标。
 *
 * @param props - 状态图标属性。
 * @param props.stage - 工具日志阶段。
 * @returns 可区分运行中、已运行和失败的状态图标。
 */
export const ProjectToolRunStatusIcon = ({ stage }: { stage: ProjectToolLogEntry['stage'] }) => {
  const meta = getProjectToolRunLogStatusMeta(stage)

  if (meta.icon === 'running') {
    return (
      <span
        aria-hidden="true"
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[color:var(--color-chat-status-running)] bg-[color:var(--color-chat-inline-bg)]"
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-[color:var(--color-chat-status-running)]" />
      </span>
    )
  }

  if (meta.icon === 'error') {
    return (
      <span
        aria-hidden="true"
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[color:var(--color-chat-error-border)] bg-[color:var(--color-chat-error-bg)] text-caption leading-none font-semibold text-[color:var(--color-chat-error-text)]"
      >
        !
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[color:var(--color-chat-status-success)] bg-[color:var(--color-chat-inline-bg)] text-caption leading-none font-semibold text-[color:var(--color-chat-status-success)]"
    >
      ✓
    </span>
  )
}

/**
 * 渲染单行工具运行日志。
 *
 * @param props - 工具日志行属性。
 * @param props.compact - 是否用于折叠摘要行。
 * @param props.log - 工具日志条目。
 * @returns 工具运行状态和动作文本。
 */
export const ProjectToolRunLogRow = ({
  compact = false,
  log,
}: {
  compact?: boolean
  log: ProjectToolLogEntry
}) => {
  const meta = getProjectToolRunLogStatusMeta(log.stage)

  return (
    <span
      className="flex min-w-0 items-center gap-2.5 text-label"
      data-project-tool-run-log-row={compact ? 'summary' : log.id}
    >
      <ProjectToolRunStatusIcon stage={log.stage} />
      <span className={cn('shrink-0 text-caption font-semibold', meta.textClassName)}>
        {meta.label}
      </span>
      <span className="min-w-0 truncate text-[color:var(--color-chat-secondary-text)]">
        {formatProjectToolRunLogText(log)}
      </span>
    </span>
  )
}

/**
 * 渲染消息气泡之间的轻量工具运行日志。
 *
 * @param props - 工具运行日志属性。
 * @param props.logs - 当前 timeline 段工具日志列表。
 * @param props.renderToolDetails - 可选的逐工具详情渲染器；正式聊天不传。
 * @returns 默认一行、点击后展开多行的工具运行日志组件。
 */
export const ProjectTimelineToolRunLog = ({
  logs,
  renderToolDetails,
}: {
  logs: ProjectToolLogEntry[]
  renderToolDetails?: ProjectToolLogDetailsRenderer
}) => {
  const currentLog = latestProjectToolRunLog(logs)

  if (!currentLog) {
    return null
  }

  const orderedLogs = orderedProjectToolRunLogs(logs)

  return (
    <details
      aria-label={`工具调用：${formatProjectToolRunLogText(currentLog)}`}
      className="group max-w-[92%] min-w-0 overflow-hidden border-y border-[color:var(--color-chat-inline-border)] bg-transparent"
      data-project-tool-run-log="true"
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-2 py-2.5 transition-colors hover:bg-[color:var(--color-chat-inline-bg)] focus-visible:bg-[color:var(--color-chat-inline-bg)] [&::-webkit-details-marker]:hidden"
        data-project-tool-run-log-summary="true"
      >
        <ProjectToolRunLogRow compact log={currentLog} />
        <span className="ml-auto shrink-0 text-label text-[color:var(--color-chat-muted-text)] transition-transform duration-200 group-open:rotate-180">
          ⌄
        </span>
      </summary>

      <div className="pb-2 pl-7">
        <div
          className={cn(
            'space-y-2 border-l border-[color:var(--color-chat-inline-border)] pr-1 pl-3',
            !renderToolDetails && 'thin-scrollbar max-h-40 overflow-y-auto',
          )}
          data-scrollable={renderToolDetails ? undefined : true}
        >
          {orderedLogs.map((log) => {
            const details = renderToolDetails?.(log.toolCallId)

            if (!details) {
              return <ProjectToolRunLogRow key={log.id} log={log} />
            }

            return (
              <div className="space-y-2" key={log.id}>
                <ProjectToolRunLogRow log={log} />
                {details}
              </div>
            )
          })}
        </div>
      </div>
    </details>
  )
}

/**
 * 渲染单段普通工具运行日志。
 *
 * @param props - 工具日志段属性。
 * @param props.item - timeline 中的工具日志段。
 * @param props.renderToolDetails - 可选的逐工具详情渲染器。
 * @returns 有可见日志时返回折叠工具日志组件。
 */
export const ProjectToolLogTimelineSegment = ({
  item,
  renderToolDetails,
}: {
  item: ProjectToolLogSegmentTimelineItem
  renderToolDetails?: ProjectToolLogDetailsRenderer
}) => {
  if (item.logs.length === 0) {
    return null
  }

  return (
    <div className="flex justify-start pr-1" data-project-timeline-tool-module="true">
      <div className="flex w-full min-w-0 flex-col items-start gap-2">
        <ProjectTimelineToolRunLog logs={item.logs} renderToolDetails={renderToolDetails} />
      </div>
    </div>
  )
}
