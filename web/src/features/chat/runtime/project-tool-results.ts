import type { ThreadAssistantMessagePart, ThreadMessage } from '@assistant-ui/react'
import type {
  ProjectGenericToolPart,
  ProjectMemberSegment,
  ProjectMemberSegmentPart,
} from '@/features/chat/contracts'

const isMemberToolPart = (part: ProjectMemberSegmentPart): part is ProjectGenericToolPart =>
  part.type.startsWith('tool-')

const isCompletedAssistantToolCall = (part: ThreadAssistantMessagePart) =>
  part.type === 'tool-call' && !part.isError && 'result' in part && part.result !== undefined

/**
 * 生成当前已完成工具结果的稳定 revision。
 *
 * 只作为重新读取 Workspace 的失效提示：工具结果正文不进 Workspace，文件内容仍
 * 只来自 Workspace API。不按工具名筛——往工作区写东西的不止 `write_file` 那几
 * 件，镜头素材工具也会顺手往里写，按名字筛就会漏掉它们。
 */
export const completedToolResultsRevision = ({
  memberSegments,
  messages,
}: {
  memberSegments: readonly ProjectMemberSegment[]
  messages: readonly ThreadMessage[]
}) => {
  const entries: string[] = []
  const seen = new Set<string>()
  const append = ({ scopeId, toolCallId }: { scopeId: string; toolCallId: string }) => {
    const key = JSON.stringify([scopeId, toolCallId])
    if (!seen.has(key)) {
      seen.add(key)
      entries.push(key)
    }
  }

  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue
    }

    for (const part of message.content) {
      if (isCompletedAssistantToolCall(part) && 'toolCallId' in part) {
        append({ scopeId: `leader:${message.id}`, toolCallId: part.toolCallId })
      }
    }
  }

  for (const segment of memberSegments) {
    for (const part of segment.parts) {
      if (isMemberToolPart(part) && part.state === 'output-available') {
        append({ scopeId: `member:${segment.memberRunId}`, toolCallId: part.toolCallId })
      }
    }
  }

  return JSON.stringify(entries)
}
