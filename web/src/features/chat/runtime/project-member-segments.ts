import type { Message } from '@ag-ui/client'
import type { ThreadAssistantMessagePart } from '@assistant-ui/react'
import type { ProjectMemberSegment, ProjectMemberSegmentPart } from '@/features/chat/contracts'
import { isRecord } from '@/shared/lib/guards'
import {
  assistantMessagesFromAguiMessages,
  parseStructuredValue,
  stringValue,
} from './project-agui-messages'

export const AGUI_MEMBER_EVENT_NAME = 'agui.member_event'

/**
 * 后端 ``agui.member_event`` CUSTOM 事件的 value 载荷。
 */
export interface ProjectMemberEventValue {
  event: Record<string, unknown>
  memberId: string
  memberRunId: string
  parentToolCallId: string | null
  seq: number
}

/**
 * restore payload ``members`` 数组的单个成员 run。
 */
export interface ProjectRestoreMemberRun {
  memberId: string
  memberRunId: string
  messages: Message[]
  parentToolCallId: string | null
  status: string
}

interface MemberTextPartState {
  buffer: string
  touched: boolean
}

interface MemberToolCallState {
  argsText: string
  result?: unknown
  toolCallId: string
  toolCallName: string
}

type MemberPartOrderEntry =
  | { key: string; kind: 'reasoning' }
  | { key: string; kind: 'text' }
  | { kind: 'tool-call'; toolCallId: string }

interface MemberSegmentBuffer {
  fromRestore: boolean
  lastSeq: number
  memberId: string
  memberRunId: string
  parentToolCallId: string | null
  partOrder: MemberPartOrderEntry[]
  reasoningParts: Map<string, string>
  restoreParts: ProjectMemberSegmentPart[]
  textParts: Map<string, MemberTextPartState>
  toolCalls: Map<string, MemberToolCallState>
}

export interface ProjectMemberSegmentsState {
  segments: Map<string, MemberSegmentBuffer>
}

/**
 * 创建空的成员段状态。
 *
 * @returns 按成员 run id 索引、保持插入顺序的可变状态。
 */
export const createProjectMemberSegmentsState = (): ProjectMemberSegmentsState => ({
  segments: new Map(),
})

/**
 * 创建单个成员 run 的内部累积缓冲。
 *
 * @param input - 成员身份、父工具调用与来源类型。
 * @returns 尚未接收任何事件或 restore part 的缓冲。
 */
const createSegmentBuffer = ({
  fromRestore,
  memberId,
  memberRunId,
  parentToolCallId,
}: {
  fromRestore: boolean
  memberId: string
  memberRunId: string
  parentToolCallId: string | null
}): MemberSegmentBuffer => ({
  fromRestore,
  lastSeq: -1,
  memberId,
  memberRunId,
  parentToolCallId,
  partOrder: [],
  reasoningParts: new Map(),
  restoreParts: [],
  textParts: new Map(),
  toolCalls: new Map(),
})

/**
 * 从未知 CUSTOM 事件 value 中收窄成员事件载荷。
 *
 * @param value - AG-UI CUSTOM 事件 value。
 * @returns 收窄后的成员事件载荷；形状非法时返回 null。
 */
export const parseProjectMemberEventValue = (value: unknown): ProjectMemberEventValue | null => {
  if (!isRecord(value) || !isRecord(value.event)) {
    return null
  }

  const memberId = stringValue(value.memberId)
  const memberRunId = stringValue(value.memberRunId)
  const seq = value.seq

  if (
    memberId === '' ||
    memberRunId === '' ||
    typeof seq !== 'number' ||
    !Number.isInteger(seq) ||
    seq < 0
  ) {
    return null
  }

  return {
    event: value.event,
    memberId,
    memberRunId,
    parentToolCallId: stringValue(value.parentToolCallId) || null,
    seq,
  }
}

/**
 * 读取或创建成员文本事件的累积状态。
 *
 * @param segment - 当前成员 run 缓冲。
 * @param messageId - 成员文本消息 id。
 * @returns 对应消息的文本累积状态。
 */
const ensureTextPart = (segment: MemberSegmentBuffer, messageId: string) => {
  const existing = segment.textParts.get(messageId)
  if (existing) {
    return existing
  }

  const created = { buffer: '', touched: false }
  segment.textParts.set(messageId, created)
  segment.partOrder.push({ key: messageId, kind: 'text' })
  return created
}

/**
 * 确保成员 reasoning 消息已进入稳定 part 顺序。
 *
 * @param segment - 当前成员 run 缓冲。
 * @param messageId - reasoning 消息 id。
 */
const ensureReasoningPart = (segment: MemberSegmentBuffer, messageId: string) => {
  if (!segment.reasoningParts.has(messageId)) {
    segment.reasoningParts.set(messageId, '')
    segment.partOrder.push({ key: messageId, kind: 'reasoning' })
  }
}

/**
 * 读取或创建成员工具调用的累积状态。
 *
 * @param segment - 当前成员 run 缓冲。
 * @param toolCallId - AG-UI 工具调用 id。
 * @param toolName - 最新工具名（事件可能晚于 start 到达）。
 * @returns 对应工具调用的累积状态。
 */
const ensureToolCall = (segment: MemberSegmentBuffer, toolCallId: string, toolName?: string) => {
  const existing = segment.toolCalls.get(toolCallId)

  if (existing) {
    if (toolName) {
      existing.toolCallName = toolName
    }

    return existing
  }

  const created: MemberToolCallState = {
    argsText: '',
    toolCallId,
    toolCallName: toolName ?? 'tool',
  }
  segment.toolCalls.set(toolCallId, created)
  segment.partOrder.push({ kind: 'tool-call', toolCallId })

  return created
}

/**
 * 把一条成员子事件应用到成员段状态。
 *
 * 幂等约定：attach 从头重放时按后端决定论 seq 重建，
 * `seq <= lastSeq` 的事件直接跳过；restore 构建的段是权威版本。
 *
 * @param state - 成员段状态。
 * @param value - ``agui.member_event`` 的 value 载荷。
 * @returns 状态发生变化时返回 true。
 */
export const applyProjectMemberEvent = (
  state: ProjectMemberSegmentsState,
  value: ProjectMemberEventValue,
): boolean => {
  let segment = state.segments.get(value.memberRunId)

  if (segment?.fromRestore) {
    return false
  }

  if (!segment) {
    segment = createSegmentBuffer({
      fromRestore: false,
      memberId: value.memberId,
      memberRunId: value.memberRunId,
      parentToolCallId: value.parentToolCallId,
    })
    state.segments.set(value.memberRunId, segment)
  }

  if (value.seq <= segment.lastSeq) {
    return false
  }

  segment.lastSeq = value.seq

  if (value.parentToolCallId) {
    segment.parentToolCallId = value.parentToolCallId
  }

  const event = value.event
  const eventType = stringValue(event.type)
  const messageId = stringValue(event.messageId)
  const toolCallId = stringValue(event.toolCallId)
  const delta = typeof event.delta === 'string' ? event.delta : ''

  switch (eventType) {
    case 'TEXT_MESSAGE_START':
      if (messageId) {
        ensureTextPart(segment, messageId)
      }
      return true
    case 'TEXT_MESSAGE_CONTENT': {
      if (!messageId || delta === '') {
        return true
      }

      const textPart = ensureTextPart(segment, messageId)
      textPart.buffer += delta
      textPart.touched = true
      return true
    }
    case 'REASONING_MESSAGE_START':
      if (messageId) {
        ensureReasoningPart(segment, messageId)
      }
      return true
    case 'REASONING_MESSAGE_CONTENT': {
      if (!messageId || delta === '') {
        return true
      }

      ensureReasoningPart(segment, messageId)
      segment.reasoningParts.set(messageId, (segment.reasoningParts.get(messageId) ?? '') + delta)
      return true
    }
    case 'TOOL_CALL_START':
      if (toolCallId) {
        ensureToolCall(segment, toolCallId, stringValue(event.toolCallName) || undefined)
      }
      return true
    case 'TOOL_CALL_ARGS': {
      if (!toolCallId || delta === '') {
        return true
      }

      ensureToolCall(segment, toolCallId).argsText += delta
      return true
    }
    case 'TOOL_CALL_RESULT': {
      if (!toolCallId) {
        return true
      }

      const toolCall = ensureToolCall(segment, toolCallId)
      const content = typeof event.content === 'string' ? event.content : ''
      toolCall.result = parseStructuredValue(content) ?? null
      return true
    }
    default:
      // TEXT_MESSAGE_END / TOOL_CALL_END / REASONING_* 收尾与未知子事件：
      // seq 已推进，无内容可写。
      return true
  }
}

/**
 * 把 restore payload 的成员 run 装载为权威成员段。
 *
 * @param state - 成员段状态。
 * @param members - restore payload 的 ``members`` 数组。
 */
export const loadProjectMemberSegmentsFromRestore = (
  state: ProjectMemberSegmentsState,
  members: readonly ProjectRestoreMemberRun[],
) => {
  for (const member of members) {
    const segment = createSegmentBuffer({
      fromRestore: true,
      memberId: member.memberId,
      memberRunId: member.memberRunId,
      parentToolCallId: member.parentToolCallId,
    })
    segment.restoreParts = memberSegmentPartsFromAguiMessages(member.messages)
    state.segments.set(member.memberRunId, segment)
  }
}

/**
 * 把成员的 AG-UI 消息（assistant / tool）转换为成员段 parts。
 *
 * @param messages - restore payload 中单个成员 run 的 AG-UI 消息。
 * @returns 按消息顺序排列的文本与工具 parts。
 */
export const memberSegmentPartsFromAguiMessages = (
  messages: readonly Message[],
): ProjectMemberSegmentPart[] =>
  assistantMessagesFromAguiMessages(messages).flatMap((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return []
    }

    return (message.content as ThreadAssistantMessagePart[]).flatMap(
      (part): ProjectMemberSegmentPart[] => {
        if ((part.type === 'text' || part.type === 'reasoning') && part.text.trim().length > 0) {
          return [{ text: part.text, type: part.type }]
        }

        if (part.type !== 'tool-call') {
          return []
        }

        const hasResult = 'result' in part && part.result !== undefined
        return [
          {
            input: part.args ?? {},
            output: hasResult ? part.result : undefined,
            state: hasResult
              ? part.isError
                ? 'output-error'
                : 'output-available'
              : 'input-available',
            toolCallId: part.toolCallId,
            type: `tool-${part.toolName}`,
          },
        ]
      },
    )
  })

/**
 * 导出成员段的不可变渲染快照。
 *
 * @param state - 成员段状态。
 * @returns 按进入顺序排列的成员段列表（无内容的段被过滤）。
 */
export const projectMemberSegmentsSnapshot = (
  state: ProjectMemberSegmentsState,
): ProjectMemberSegment[] => {
  const segments: ProjectMemberSegment[] = []

  for (const buffer of state.segments.values()) {
    const parts = buffer.fromRestore ? buffer.restoreParts : livePartsFromBuffer(buffer)

    if (parts.length === 0) {
      continue
    }

    segments.push({
      memberId: buffer.memberId,
      memberRunId: buffer.memberRunId,
      parentToolCallId: buffer.parentToolCallId,
      parts,
    })
  }

  return segments
}

/**
 * 将 live 成员事件缓冲投影为不可变渲染 parts。
 *
 * @param buffer - 已按 seq 累积的成员 run 缓冲。
 * @returns 按原事件顺序排列的文本、reasoning 与工具 parts。
 */
const livePartsFromBuffer = (buffer: MemberSegmentBuffer): ProjectMemberSegmentPart[] => {
  const parts: ProjectMemberSegmentPart[] = []

  for (const entry of buffer.partOrder) {
    if (entry.kind === 'text') {
      const textPart = buffer.textParts.get(entry.key)

      if (textPart?.touched && textPart.buffer.trim().length > 0) {
        parts.push({ text: textPart.buffer, type: 'text' })
      }

      continue
    }

    if (entry.kind === 'reasoning') {
      const reasoning = buffer.reasoningParts.get(entry.key) ?? ''

      if (reasoning.trim().length > 0) {
        parts.push({ text: reasoning, type: 'reasoning' })
      }

      continue
    }

    const toolCall = buffer.toolCalls.get(entry.toolCallId)

    if (!toolCall) {
      continue
    }

    const parsedArgs = parseStructuredValue(toolCall.argsText)

    parts.push({
      input: isRecord(parsedArgs) ? parsedArgs : {},
      output: toolCall.result,
      state: toolCall.result !== undefined ? 'output-available' : 'input-available',
      toolCallId: toolCall.toolCallId,
      type: `tool-${toolCall.toolCallName}`,
    })
  }

  return parts
}
