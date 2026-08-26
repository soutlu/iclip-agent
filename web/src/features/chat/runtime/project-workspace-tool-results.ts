import type { ThreadAssistantMessagePart, ThreadMessage } from '@assistant-ui/react'
import type {
  ProjectGenericToolPart,
  ProjectMemberSegment,
  ProjectMemberSegmentPart,
} from '@/features/chat/contracts'
import { isRecord, nonEmptyString } from '@/shared/lib/guards'

const WORKSPACE_WRITE_TOOL_NAMES = new Set([
  'edit_file',
  'image_parser',
  'video_parser',
  'write_file',
  'write_video_shots',
])

export interface WorkspaceWriteToolResult {
  message: string
  path: string
}

/**
 * 读取成功写入单个 Workspace 文件的工具结果。
 *
 * 结果只充当重新读取 Workspace 的失效提示；文件正文仍只来自 Workspace API。
 *
 * 后端两种回法都要认：写文件那几件回一句完成文案（纯字符串），交付镜头组的回
 * `{ message, path }`。认不出来的形状返回 null 走通用文案——这个函数在渲染工具
 * 日志的路径上被调用，抛错会连整页一起打掉。
 */
export const workspaceWriteToolResult = ({
  output,
  rawToolName,
}: {
  output: unknown
  rawToolName: string
}): WorkspaceWriteToolResult | null => {
  if (!WORKSPACE_WRITE_TOOL_NAMES.has(rawToolName)) {
    return null
  }

  if (typeof output === 'string') {
    const message = nonEmptyString(output)
    // path 只进失效提示的去重键，而 scopeId + toolCallId 已经唯一。
    return message ? { message, path: '' } : null
  }

  if (!isRecord(output)) {
    return null
  }

  const message = nonEmptyString(output.message)
  const path = nonEmptyString(output.path)

  return message && path ? { message, path } : null
}

const assistantToolResult = (
  part: ThreadAssistantMessagePart,
  messageId: string,
): { path: string; scopeId: string; toolCallId: string } | null => {
  if (
    part.type !== 'tool-call' ||
    part.isError ||
    !('result' in part) ||
    part.result === undefined
  ) {
    return null
  }

  const result = workspaceWriteToolResult({
    output: part.result,
    rawToolName: part.toolName,
  })

  return result
    ? { path: result.path, scopeId: `leader:${messageId}`, toolCallId: part.toolCallId }
    : null
}

const memberToolResult = (
  part: ProjectGenericToolPart,
  memberRunId: string,
): { path: string; scopeId: string; toolCallId: string } | null => {
  if (part.state !== 'output-available') {
    return null
  }

  const result = workspaceWriteToolResult({
    output: part.output,
    rawToolName: part.type.slice('tool-'.length),
  })

  return result
    ? { path: result.path, scopeId: `member:${memberRunId}`, toolCallId: part.toolCallId }
    : null
}

const isMemberToolPart = (part: ProjectMemberSegmentPart): part is ProjectGenericToolPart =>
  part.type.startsWith('tool-')

/**
 * 生成当前已完成 Workspace 写入结果的稳定 revision。
 *
 * toolCallId 区分对同一路径的多次编辑；path 只触发重新读取，不作为正文来源。
 */
export const workspaceWriteResultsRevision = ({
  memberSegments,
  messages,
}: {
  memberSegments: readonly ProjectMemberSegment[]
  messages: readonly ThreadMessage[]
}) => {
  const entries: string[] = []
  const seen = new Set<string>()
  const append = (result: { path: string; scopeId: string; toolCallId: string } | null) => {
    if (!result) {
      return
    }

    const key = JSON.stringify([result.scopeId, result.toolCallId, result.path])
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
      append(assistantToolResult(part, message.id))
    }
  }

  for (const segment of memberSegments) {
    for (const part of segment.parts) {
      if (isMemberToolPart(part)) {
        append(memberToolResult(part, segment.memberRunId))
      }
    }
  }

  return JSON.stringify(entries)
}
