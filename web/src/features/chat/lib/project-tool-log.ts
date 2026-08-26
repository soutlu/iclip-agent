import { isRecord } from '@/shared/lib/guards'
import type {
  ProjectMessageMetadata,
  ProjectMessagePart,
  ProjectToolLogActorLabel,
  ProjectToolLogEntry,
  ProjectToolLogStage,
} from '../contracts'

const PROJECT_TOOL_LOG_START_STATES = new Set(['input-available', 'input-streaming'])
const PROJECT_TOOL_LOG_COMPLETED_STATES = new Set(['output-available'])
const PROJECT_TOOL_LOG_FAILED_STATES = new Set(['input-error', 'output-error'])
const PROJECT_TOOL_LOG_STAGE_PRIORITY = {
  completed: 1,
  failed: 1,
  started: 0,
} as const satisfies Record<ProjectToolLogStage, number>
const PROJECT_TOOL_LOG_RULES = {
  get_skill_instructions: {
    messages: {
      completed: '制片人加载技能',
      failed: '制片人加载技能失败',
      started: '制片人加载技能',
    },
    toolName: '加载技能',
  },
  get_skill_reference: {
    messages: {
      completed: '制片人加载创作参考',
      failed: '制片人加载创作参考失败',
      started: '制片人加载创作参考',
    },
    toolName: '加载创作参考',
  },
  edit_file: {
    messages: {
      completed: '制片人编辑文件',
      failed: '制片人编辑文件失败',
      started: '制片人编辑文件',
    },
    toolName: '编辑文件',
  },
  image_parser: {
    messages: {
      completed: '制片人分析图片',
      failed: '制片人分析图片失败',
      started: '制片人分析图片',
    },
    toolName: '分析图片',
  },
  list_files: {
    messages: {
      completed: '制片人列出文件',
      failed: '制片人列出文件失败',
      started: '制片人列出文件',
    },
    toolName: '列出文件',
  },
  read_file: {
    messages: {
      completed: '制片人读取文件',
      failed: '制片人读取文件失败',
      started: '制片人读取文件',
    },
    toolName: '读取文件',
  },
  search_content: {
    messages: {
      completed: '制片人搜索内容',
      failed: '制片人搜索内容失败',
      started: '制片人搜索内容',
    },
    toolName: '搜索内容',
  },
  video_parser: {
    messages: {
      completed: '制片人分析视频',
      failed: '制片人分析视频失败',
      started: '制片人分析视频',
    },
    toolName: '分析视频',
  },
  write_file: {
    messages: {
      completed: '制片人写入文件',
      failed: '制片人写入文件失败',
      started: '制片人写入文件',
    },
    toolName: '写入文件',
  },
  write_video_shots: {
    messages: {
      completed: '制片人写入视频镜头',
      failed: '制片人写入视频镜头失败',
      started: '制片人写入视频镜头',
    },
    toolName: '写入视频镜头',
  },
} as const satisfies Record<
  string,
  {
    messages: Record<ProjectToolLogStage, string>
    toolName: string
  }
>

type ProjectToolLogRuleName = keyof typeof PROJECT_TOOL_LOG_RULES

/**
 * 读取规整后的文本值。
 *
 * @param value - 需要规整的未知值。
 * @returns 字符串值去除空白后的结果；非字符串返回空字符串。
 */
const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/**
 * 按字段候选从工具输入中读取文本标签。
 *
 * @param input - 工具调用输入。
 * @param keys - 可读取的字段名列表。
 * @returns 第一个非空文本字段；缺失时返回空字符串。
 */
const textFieldFromToolInput = (input: unknown, keys: string[]) => {
  if (!isRecord(input)) {
    return ''
  }

  for (const key of keys) {
    const value = normalizeText(input[key])

    if (value) {
      return value
    }
  }

  return ''
}

/**
 * 从工具输入提取对用户有意义的目标标签。
 *
 * @param params - 工具输入解析参数。
 * @param params.input - 工具调用输入。
 * @param params.rawToolName - 原始工具名。
 * @returns image_1/video_1 等目标标签；不需要展示目标时返回 undefined。
 */
const targetLabelFromToolInput = ({
  input,
  rawToolName,
}: {
  input?: unknown
  rawToolName: string
}): string | undefined => {
  switch (rawToolName) {
    case 'image_parser':
      return textFieldFromToolInput(input, ['image_id', 'imageId']) || undefined
    case 'video_parser':
      return textFieldFromToolInput(input, ['video_id', 'videoId']) || undefined
    default:
      return undefined
  }
}

/**
 * 从工具结果里取一句给用户看的完成文案。
 *
 * 只认 `message` 字段：工具交付了什么，写在这个字段里的那句话说得比通用文案准。
 * 纯字符串结果一律不取——`read_file` 之类回的就是文件正文，整份灌进日志。
 *
 * @param output - 工具调用输出。
 * @returns 结果自带的完成文案；没有时返回空字符串。
 */
const toolResultMessage = (output: unknown) =>
  isRecord(output) ? normalizeText(output.message) : ''

/**
 * 判断工具名是否有当前启用的日志映射规则。
 *
 * @param value - 规整后的工具名。
 * @returns 工具名存在于中文展示映射中时返回 true。
 */
const isProjectToolLogRuleName = (value: string): value is ProjectToolLogRuleName =>
  value in PROJECT_TOOL_LOG_RULES

/**
 * 按原始工具名或中文动作名查找日志规则。
 *
 * @param value - 原始工具名或展示动作名。
 * @returns 命中的工具日志规则；未命中时返回 null。
 */
const projectToolLogRuleFromName = (
  value: string,
): (typeof PROJECT_TOOL_LOG_RULES)[ProjectToolLogRuleName] | null => {
  if (isProjectToolLogRuleName(value)) {
    return PROJECT_TOOL_LOG_RULES[value]
  }

  for (const rule of Object.values(PROJECT_TOOL_LOG_RULES)) {
    if (rule.toolName === value) {
      return rule
    }
  }

  return null
}

/**
 * 返回原始 agent 名称。
 *
 * @param value - 后端或调用方传入的 agent 名称。
 * @returns 规整后的原始名称。
 */
export const resolveProjectAgentDisplayName = (value: unknown) => normalizeText(value)

/**
 * 返回成员活动流中的工具动作标签。
 *
 * 未命中中文映射的工具一律降级为通用文案，绝不泄露原始工具名。
 *
 * @param rawToolName - 后端返回的原始工具名。
 * @returns 可展示的中文动作名。
 */
export const projectMemberToolActionLabel = (rawToolName: string) => {
  const rule = projectToolLogRuleFromName(normalizeText(rawToolName))

  return rule ? rule.toolName : '使用工具'
}

/**
 * 保留工具执行者标签接口，等待新的日志规则重新接入。
 *
 * @param params - 旧规则调用方保留的 actor 解析参数。
 * @returns 兼容旧类型的默认主 agent 标签。
 */
export const resolveProjectToolActorLabel = (params: {
  agentName?: string | null
  depth?: number | null
  providerMetadata?: Record<string, unknown>
  runPath?: string | string[] | null
}): ProjectToolLogActorLabel => {
  void params

  return '主agent'
}

/**
 * 从项目消息 part 中提取工具调用基础信息。
 *
 * @param part - 需要检查的项目消息 part。
 * @returns 工具 part 的原始工具名、输入、输出和元数据；非工具 part 返回 null。
 */
const projectToolNameFromMessagePart = (
  part: ProjectMessagePart,
): {
  input?: unknown
  output?: unknown
  providerMetadata?: Record<string, unknown>
  rawToolName: string
} | null => {
  if (part.type === 'dynamic-tool') {
    return {
      input: part.input,
      output: part.output,
      providerMetadata: part.providerMetadata,
      rawToolName: normalizeText(part.toolName),
    }
  }

  if (!part.type.startsWith('tool-')) {
    return null
  }

  return {
    input: 'input' in part ? part.input : undefined,
    output: 'output' in part ? part.output : undefined,
    providerMetadata: part.providerMetadata,
    rawToolName: part.type.slice('tool-'.length),
  }
}

/**
 * 将工具 part 状态转换为日志阶段。
 *
 * @param state - assistant-ui 或 Producer 工具 part 状态。
 * @returns 可展示的日志阶段；未知状态返回 null。
 */
const toolLogStageFromState = (state: string | undefined): ProjectToolLogStage | null => {
  const normalizedState = normalizeText(state)

  if (PROJECT_TOOL_LOG_START_STATES.has(normalizedState)) {
    return 'started'
  }
  if (PROJECT_TOOL_LOG_COMPLETED_STATES.has(normalizedState)) {
    return 'completed'
  }
  if (PROJECT_TOOL_LOG_FAILED_STATES.has(normalizedState)) {
    return 'failed'
  }

  return null
}

/**
 * 从消息元数据读取日志时间戳。
 *
 * @param metadata - Producer 消息元数据。
 * @param fallbackTimestamp - 元数据缺少时间时使用的时间戳。
 * @returns 可用于日志排序的毫秒时间戳。
 */
const timestampFromMetadata = (
  metadata: ProjectMessageMetadata | undefined,
  fallbackTimestamp: number,
) => {
  if (typeof metadata?.createdAt === 'number' && Number.isFinite(metadata.createdAt)) {
    return metadata.createdAt
  }

  if (typeof metadata?.createdAt === 'string') {
    const parsedTimestamp = Date.parse(metadata.createdAt)

    if (!Number.isNaN(parsedTimestamp)) {
      return parsedTimestamp
    }
  }

  return fallbackTimestamp
}

/**
 * 判断两个工具日志在用户可见字段上是否一致。
 *
 * @param left - 当前已有日志。
 * @param right - 准备写入的新日志。
 * @returns 除时间戳外的展示字段完全一致时返回 true。
 */
const sameProjectToolLogEntry = (left: ProjectToolLogEntry, right: ProjectToolLogEntry) =>
  left.actorLabel === right.actorLabel &&
  left.message === right.message &&
  left.rawToolName === right.rawToolName &&
  left.stage === right.stage &&
  left.targetLabel === right.targetLabel &&
  left.toolCallId === right.toolCallId &&
  left.toolName === right.toolName

/**
 * 返回启用规则下的工具展示名。
 *
 * @param params - 工具展示名参数。
 * @param params.rawToolName - 后端返回的原始工具名。
 * @returns 命中中文展示规则时返回中文动作名，否则返回原始工具名。
 */
export const resolveProjectToolDisplayName = ({
  rawToolName,
}: {
  input?: unknown
  output?: unknown
  rawToolName: string
}) => {
  const normalizedToolName = normalizeText(rawToolName)

  if (!isProjectToolLogRuleName(normalizedToolName)) {
    return normalizedToolName
  }

  return PROJECT_TOOL_LOG_RULES[normalizedToolName].toolName
}

/**
 * 格式化工具日志文案。
 *
 * @param params - 日志文案参数。
 * @param params.actorName - 可选 agent 展示名。
 * @param params.actorLabel - 兼容旧类型的 actor 标签。
 * @param params.stage - 工具阶段。
 * @param params.toolName - 工具展示名。
 * @returns 简单的兼容日志文案。
 */
export const formatProjectToolLogMessage = ({
  actorName,
  actorLabel,
  stage,
  toolName,
}: {
  actorName?: string
  actorLabel: ProjectToolLogActorLabel
  stage: ProjectToolLogStage
  toolName: string
}) => {
  void actorName
  void actorLabel

  const normalizedToolName = normalizeText(toolName)
  const rule = projectToolLogRuleFromName(normalizedToolName)

  if (rule) {
    return rule.messages[stage]
  }

  return normalizedToolName ? `制片人运行工具 ${normalizedToolName}` : ''
}

/**
 * 生成工具日志去重 key。
 *
 * @param params - 去重 key 参数。
 * @param params.toolCallId - 工具调用 id。
 * @returns 由工具调用 id 组成的规整 key。
 */
export const createProjectToolLogDedupeKey = ({ toolCallId }: { toolCallId: string }) =>
  `${normalizeText(toolCallId)}:tool`

/**
 * 获取工具日志阶段优先级。
 *
 * @param stage - 工具日志阶段。
 * @returns 阶段在同一工具调用内的合并优先级。
 */
const getProjectToolLogStagePriority = (stage: ProjectToolLogStage) =>
  PROJECT_TOOL_LOG_STAGE_PRIORITY[stage]

/**
 * 从工具调用参数创建项目工具日志。
 *
 * @param params - 日志创建参数。
 * @param params.actorLabel - 工具执行者标签，当前普通工具日志固定展示制片人文案。
 * @param params.rawToolName - 原始工具名。
 * @param params.stage - 工具调用阶段。
 * @param params.input - 工具调用输入。
 * @param params.output - 工具调用输出；结果自带 `message` 时用它当完成文案。
 * @param params.timestamp - 可选日志时间戳。
 * @param params.toolCallId - 工具调用 id。
 * @returns 工具调用 id 和工具名有效时返回工具日志；无效时返回 null。
 */
export const createProjectToolLogEntry = ({
  actorLabel,
  input,
  output,
  rawToolName,
  stage,
  timestamp,
  toolCallId,
}: {
  actorName?: string
  actorLabel: ProjectToolLogActorLabel
  input?: unknown
  output?: unknown
  rawToolName: string
  stage: ProjectToolLogStage
  timestamp?: number
  toolCallId: string
}): ProjectToolLogEntry | null => {
  const normalizedToolCallId = normalizeText(toolCallId)
  const normalizedRawToolName = normalizeText(rawToolName)

  if (normalizedToolCallId === '' || normalizedRawToolName === '') {
    return null
  }

  const dedupeKey = createProjectToolLogDedupeKey({
    toolCallId: normalizedToolCallId,
  })
  const resolvedTimestamp =
    typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now()
  const toolName = resolveProjectToolDisplayName({ rawToolName: normalizedRawToolName })
  const targetLabel = targetLabelFromToolInput({
    input,
    rawToolName: normalizedRawToolName,
  })
  const resultMessage = stage === 'completed' ? toolResultMessage(output) : ''

  return {
    actorLabel,
    dedupeKey,
    id: dedupeKey,
    message:
      resultMessage ||
      formatProjectToolLogMessage({
        actorLabel,
        stage,
        toolName,
      }),
    rawToolName: normalizedRawToolName,
    stage,
    ...(targetLabel ? { targetLabel } : {}),
    timestamp: resolvedTimestamp,
    toolCallId: normalizedToolCallId,
    toolName,
  }
}

/**
 * 从项目消息 part 自动提取工具日志。
 *
 * @param params - part 提取参数。
 * @param params.fallbackTimestamp - 消息元数据缺少时间时使用的时间戳。
 * @param params.messageMetadata - 当前 assistant 消息元数据。
 * @param params.part - 需要检查的消息 part。
 * @returns 工具名、工具调用 id 和阶段有效时返回日志；否则返回 null。
 */
export const projectToolLogEntryFromMessagePart = ({
  fallbackTimestamp = Date.now(),
  messageMetadata,
  part,
}: {
  fallbackTimestamp?: number
  messageMetadata?: ProjectMessageMetadata
  part: ProjectMessagePart
}) => {
  const toolPart = projectToolNameFromMessagePart(part)

  if (!toolPart || !('toolCallId' in part)) {
    return null
  }

  const stage = toolLogStageFromState('state' in part ? part.state : undefined)
  if (!stage) {
    return null
  }

  return createProjectToolLogEntry({
    actorLabel: '主agent',
    input: toolPart.input,
    output: toolPart.output,
    rawToolName: toolPart.rawToolName,
    stage,
    timestamp: timestampFromMetadata(messageMetadata, fallbackTimestamp),
    toolCallId: part.toolCallId,
  })
}

/**
 * 将工具日志插入或合并到现有列表。
 *
 * @param params - 日志插入参数。
 * @param params.entry - 新的工具日志；为空时直接返回原列表。
 * @param params.logs - 当前 timeline 段已有工具日志。
 * @returns 同一 toolCallId 只保留一个最新阶段的工具日志列表。
 */
export const upsertProjectToolLogEntry = ({
  entry,
  logs,
}: {
  entry: ProjectToolLogEntry | null
  logs: ProjectToolLogEntry[]
}) => {
  if (!entry) {
    return logs
  }

  const existingIndex = logs.findIndex((log) => log.dedupeKey === entry.dedupeKey)

  if (existingIndex < 0) {
    return [...logs, entry]
  }

  // findIndex 命中保证下标有效。
  const existingEntry = logs[existingIndex]!
  const existingStagePriority = getProjectToolLogStagePriority(existingEntry.stage)
  const nextStagePriority = getProjectToolLogStagePriority(entry.stage)

  if (nextStagePriority < existingStagePriority) {
    return logs
  }

  const nextEntry = {
    ...entry,
    id: existingEntry.id,
    timestamp: Math.min(existingEntry.timestamp, entry.timestamp),
  }

  if (sameProjectToolLogEntry(existingEntry, nextEntry)) {
    return logs
  }

  return logs.map((log, index) => (index === existingIndex ? nextEntry : log))
}

/**
 * 合并持久与临时工具日志。
 *
 * @param persistedLogs - 已从消息或快照恢复的工具日志。
 * @param transientLogs - 当前浏览器运行期临时工具日志。
 * @returns 按时间排序后的工具日志列表。
 */
export const mergeTurnToolLogs = (
  persistedLogs: ProjectToolLogEntry[],
  transientLogs: ProjectToolLogEntry[],
) => {
  let mergedLogs: ProjectToolLogEntry[] = []

  for (const entry of persistedLogs) {
    mergedLogs = upsertProjectToolLogEntry({
      entry,
      logs: mergedLogs,
    })
  }

  for (const entry of transientLogs) {
    mergedLogs = upsertProjectToolLogEntry({
      entry,
      logs: mergedLogs,
    })
  }

  return [...mergedLogs].sort((left, right) => left.timestamp - right.timestamp)
}
