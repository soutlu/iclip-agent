import { getCurrentGeneratedVideoStatusByPromptIndex } from '@/features/artifacts/lib/generated-video-display.utils'
import { createVideoBatchKey } from '@/features/artifacts/renderers/video-batch-prompt.utils'
import type {
  GeneratedVideoOutput,
  GeneratedVideoStatus,
} from '@/features/artifacts/types/generated-video.types'
import type {
  VideoPromptBatch,
  VideoPromptOutput,
  VideoPromptPreviewImage,
} from '@/features/artifacts/types/video-prompt.types'
import type { MediaPreviewItem } from '@/shared/ui/media'

export interface VideoPromptCanvasCardProps {
  generatedVideo?: GeneratedVideoOutput
  isVideoGenerationDisabled?: boolean
  onSavePrompt: (input: VideoPromptSaveInput) => Promise<unknown>
  onSubmitVideoGenerations?: (inputs: VideoPromptGenerationInput[]) => Promise<unknown>
  onSubmitVideoGeneration?: (input: VideoPromptGenerationInput) => Promise<unknown>
  videoPrompt: VideoPromptOutput
}

export interface VideoPromptGenerationInput {
  aspectRatio: string
  prompt: string
  referenceAudios: string[]
  referenceImages: string[]
  referenceVideos: string[]
  seconds: number
  shotIndex: number
}

export interface VideoPromptGenerationSubmissionItem {
  batch: VideoPromptBatch
  batchKey: string
  input: VideoPromptGenerationInput
}

export interface VideoPromptSaveCandidate {
  originalPrompt: string
  prompt: string
  shotIndex: number
}

export interface VideoPromptSaveInput {
  prompt: string
  shotIndex: number
}

export interface VideoPromptReadingSegment {
  body: string
  label: string
  variant: 'setup' | 'timed'
}

export const ICON_ACTION_BUTTON_CLASS =
  'nodrag nopan inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-control-bg p-0 text-on-surface-variant transition-all hover:border-border-hover hover:bg-hover hover:text-on-background'

export const PROMPT_EDIT_BUTTON_CLASS =
  'nodrag nopan inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-control-bg px-3 text-title font-medium text-on-surface-variant transition-all hover:border-border-hover hover:bg-hover hover:text-on-background'

export const VIDEO_PROMPT_PRIMARY_BUTTON_BASE_CLASS =
  'nodrag nopan inline-flex h-11 items-center justify-center rounded-lg px-5 text-canvas-label font-semibold transition-all'

export const VIDEO_PROMPT_SECONDARY_BUTTON_BASE_CLASS =
  'nodrag nopan inline-flex h-11 items-center justify-center rounded-lg px-4 text-title font-medium transition-all'

export const VIDEO_PROMPT_PRIMARY_BUTTON_ENABLED_CLASS =
  'bg-chat-agent-rail text-background shadow-[var(--shadow-2)] active:scale-[0.98]'

export const VIDEO_PROMPT_SECONDARY_BUTTON_ENABLED_CLASS =
  'border border-border bg-control-bg text-on-background hover:border-border-hover hover:bg-hover active:scale-[0.98]'

export const VIDEO_PROMPT_DISABLED_BUTTON_CLASS =
  'cursor-not-allowed bg-control-bg text-disabled-text'

export const VIDEO_PROMPT_REFERENCE_TAG_PATTERN_SOURCE = '(@(?:Image|image)\\d+)'
export const VIDEO_PROMPT_REFERENCE_TAG_PATTERN = new RegExp(
  VIDEO_PROMPT_REFERENCE_TAG_PATTERN_SOURCE,
  'g',
)
export const VIDEO_PROMPT_REFERENCE_TAG_EXACT_PATTERN = new RegExp(
  `^${VIDEO_PROMPT_REFERENCE_TAG_PATTERN_SOURCE}$`,
)
export const VIDEO_PROMPT_TIME_RANGE_PATTERN_SOURCE =
  '(\\d+(?:\\.\\d+)?\\s*-\\s*\\d+(?:\\.\\d+)?s)\\s*[：:]?'

export const videoPromptPreviewImageToPreviewItem = (
  image: VideoPromptPreviewImage,
): MediaPreviewItem => ({
  altText: image.key,
  fileName: image.key,
  mediaType: 'image',
  url: image.url,
})

/**
 * 按镜头 key 创建提示词编辑草稿。
 *
 * @param batches - 后端返回的视频提示词镜头列表。
 * @returns 以镜头 key 为索引的提示词草稿。
 */
export const createVideoPromptDrafts = (batches: VideoPromptBatch[]) =>
  Object.fromEntries(batches.map((batch) => [createVideoBatchKey(batch), batch.prompt])) as Record<
    string,
    string
  >

/**
 * 读取当前镜头可提交给视频生成接口的参考图 URL。
 *
 * @param batch - 当前选中的视频提示词镜头。
 * @returns 镜头预览图中的 HTTP URL 列表；没有预览图时返回空数组。
 */
export const getVideoPromptReferenceImageUrls = (batch: VideoPromptBatch) =>
  batch.previewImages?.map((image) => image.url) ?? []

/**
 * 判断指定视频生成状态是否仍在执行中。
 *
 * @param status - 后端返回的单条视频生成状态。
 * @returns 状态仍在排队或生成时返回 true。
 */
export const isPendingGeneratedVideoStatus = (status: GeneratedVideoStatus) =>
  status === 'queued' || status === 'processing' || status === 'running'

/**
 * 清理视频提示词段落边界，避免按时间段拆分后残留标点。
 *
 * @param value - 待清理的提示词片段。
 * @returns 去掉首尾多余标点和连续空白后的片段。
 */
export const trimVideoPromptSegment = (value: string) =>
  value
    .replace(/^[\s,，。；;、]+/, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * 将单段长视频提示词拆为更适合阅读的结构化段落。
 *
 * @param prompt - 当前镜头的视频提示词。
 * @returns 包含整体设定和分时段描述的阅读段落。
 */
export const formatVideoPromptReadingSegments = (prompt: string): VideoPromptReadingSegment[] => {
  const normalizedPrompt = prompt.trim()

  if (normalizedPrompt.length === 0) {
    return []
  }

  const timeRangePattern = new RegExp(VIDEO_PROMPT_TIME_RANGE_PATTERN_SOURCE, 'g')
  const matches = Array.from(normalizedPrompt.matchAll(timeRangePattern))

  if (matches.length === 0) {
    return [
      {
        body: normalizedPrompt,
        label: '提示词',
        variant: 'setup',
      },
    ]
  }

  const firstTimeRangeMatch = matches[0]

  if (!firstTimeRangeMatch || typeof firstTimeRangeMatch.index !== 'number') {
    return [
      {
        body: normalizedPrompt,
        label: '提示词',
        variant: 'setup',
      },
    ]
  }

  const segments: VideoPromptReadingSegment[] = []
  const setupBody = trimVideoPromptSegment(normalizedPrompt.slice(0, firstTimeRangeMatch.index))

  if (setupBody.length > 0) {
    segments.push({
      body: setupBody,
      label: '整体设定',
      variant: 'setup',
    })
  }

  matches.forEach((match, index) => {
    const matchedText = match[0]
    const label = match[1]
    const matchIndex = match.index

    if (!matchedText || !label || typeof matchIndex !== 'number') {
      return
    }

    const nextMatch = matches[index + 1]
    const bodyStart = matchIndex + matchedText.length
    const bodyEnd = typeof nextMatch?.index === 'number' ? nextMatch.index : normalizedPrompt.length
    const body = trimVideoPromptSegment(normalizedPrompt.slice(bodyStart, bodyEnd))

    if (body.length === 0) {
      return
    }

    segments.push({
      body,
      label: label.replace(/\s+/g, ''),
      variant: 'timed',
    })
  })

  return segments
}

/**
 * 按视频提示词镜头序号归并当前应该展示的视频生成状态。
 *
 * @param generatedVideo - 当前视频提示词节点关联的生成视频聚合输出。
 * @returns 以 promptIndex 为 key 的当前状态映射。
 */
export const createVideoGenerationStatusByPromptIndex = (generatedVideo?: GeneratedVideoOutput) =>
  getCurrentGeneratedVideoStatusByPromptIndex(generatedVideo?.videos ?? [])

/**
 * 解析单个视频生成状态阻断重复提交时的提示文案。
 *
 * @param status - 后端返回的单条视频生成状态。
 * @returns 可展示给用户的阻断原因。
 */
export const getVideoGenerationStatusBlocker = (status: GeneratedVideoStatus) => {
  switch (status) {
    case 'queued':
      return '视频任务已提交，正在排队，不能重复提交。'
    case 'processing':
    case 'running':
      return '视频正在生成中，不能重复提交。'
    default:
      return null
  }
}

/**
 * 解析视频提示词节点顶部展示的当前生成状态。
 *
 * @param status - 当前镜头对应的视频生成状态。
 * @returns 用户可读的短状态标签。
 */
export const getVideoGenerationStatusDisplayLabel = (status: GeneratedVideoStatus | null) => {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'processing':
    case 'running':
      return '生成中'
    case 'succeeded':
      return '已生成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return '可生成'
  }
}

/**
 * 判断当前镜头是否缺少提交视频生成所需字段。
 *
 * @param params - 视频生成提交前置条件。
 * @param params.aspectRatio - 当前 artifact 提供的视频比例。
 * @param params.prompt - 用户编辑后的当前提示词。
 * @param params.seconds - 当前镜头时长。
 * @returns 可以提交时返回 null；否则返回阻断原因。
 */
export const getVideoGenerationSubmitBlocker = ({
  aspectRatio,
  prompt,
  seconds,
}: {
  aspectRatio?: string
  prompt: string
  seconds?: number
}) => {
  if (prompt.trim().length === 0) {
    return '提示词不能为空。'
  }

  if (!aspectRatio || aspectRatio.trim().length === 0) {
    return '当前镜头缺少视频比例，无法提交。'
  }

  if (!seconds || seconds <= 0) {
    return '当前镜头缺少视频时长，无法提交。'
  }

  return null
}

/**
 * 尝试使用浏览器 Clipboard API 写入文本。
 *
 * @param text - 需要写入系统剪贴板的文本。
 * @returns 写入成功时返回 true；运行环境不支持或权限拒绝时返回 false。
 */
export const writeTextWithClipboardApi = async (text: string) => {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return false
  }

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * 使用隐藏 textarea 选择文本作为剪贴板写入兜底。
 *
 * @param text - 需要写入系统剪贴板的文本。
 * @returns 浏览器接受复制命令时返回 true。
 */
export const writeTextWithSelectionFallback = (text: string) => {
  if (typeof document === 'undefined' || !document.body) {
    return false
  }

  const previousActiveElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  const textArea = document.createElement('textarea')

  textArea.value = text
  textArea.setAttribute('readonly', '')
  textArea.style.left = '-9999px'
  textArea.style.opacity = '0'
  textArea.style.position = 'fixed'
  textArea.style.top = '0'
  document.body.append(textArea)
  textArea.focus()
  textArea.select()

  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textArea.remove()
    try {
      previousActiveElement?.focus({ preventScroll: true })
    } catch {
      // 焦点恢复失败可忽略（元素可能已卸载）。
    }
  }
}

/**
 * 写入文本到系统剪贴板，并在 Clipboard API 失效时自动降级。
 *
 * @param text - 需要复制的提示词文本。
 * @returns 任一复制路径成功时返回 true。
 */
export const writeTextToClipboard = async (text: string) => {
  const didWriteWithClipboardApi = await writeTextWithClipboardApi(text)

  if (didWriteWithClipboardApi) {
    return true
  }

  return writeTextWithSelectionFallback(text)
}

/**
 * 解析视频生成提交按钮文案。
 *
 * @param params - 当前提交按钮状态。
 * @param params.generationStatus - 当前镜头已经存在的视频生成状态。
 * @param params.isSubmitted - 当前镜头是否刚刚提交成功。
 * @param params.isSubmitting - 当前镜头是否正在提交。
 * @returns 展示给用户的按钮文案。
 */
export const getVideoGenerationButtonLabel = ({
  generationStatus,
  isSubmitted,
  isSubmitting,
}: {
  generationStatus: GeneratedVideoStatus | null
  isSubmitted: boolean
  isSubmitting: boolean
}) => {
  if (isSubmitting) {
    return '提交中'
  }

  if (generationStatus) {
    if (generationStatus === 'succeeded') {
      return '再次生成'
    }

    if (generationStatus === 'failed' || generationStatus === 'cancelled') {
      return '重新生成'
    }

    return getVideoGenerationStatusDisplayLabel(generationStatus)
  }

  if (isSubmitted) {
    return '已提交'
  }

  return '生成视频'
}

/**
 * 解析全部视频生成提交按钮文案。
 *
 * @param params - 全部提交按钮状态。
 * @param params.isSubmitted - 全部镜头是否刚刚提交成功。
 * @param params.isSubmitting - 全部镜头是否正在提交。
 * @returns 展示给用户的全部提交按钮文案。
 */
export const getVideoGenerationAllButtonLabel = ({
  isSubmitted,
  isSubmitting,
}: {
  isSubmitted: boolean
  isSubmitting: boolean
}) => {
  if (isSubmitting) {
    return '全部提交中'
  }

  if (isSubmitted) {
    return '全部已提交'
  }

  return '全部生成'
}

/**
 * 解析默认选中的视频提示词镜头 key。
 *
 * @param batches - 后端返回的视频提示词镜头列表。
 * @returns 第一镜头对应的稳定 key；没有镜头时返回 null。
 */
export const resolveInitialVideoBatchKey = (batches: VideoPromptBatch[]) => {
  const firstBatch = batches[0]

  return firstBatch ? createVideoBatchKey(firstBatch) : null
}

/**
 * 解析当前应展示的完整提示词镜头。
 *
 * @param batches - 后端返回的视频提示词镜头列表。
 * @param selectedBatchKey - 用户当前选中的镜头 key。
 * @returns 选中镜头；选中项不存在时回退到第一镜头。
 */
export const resolveSelectedVideoBatch = (
  batches: VideoPromptBatch[],
  selectedBatchKey: string | null,
) => {
  if (selectedBatchKey) {
    for (const batch of batches) {
      if (createVideoBatchKey(batch) === selectedBatchKey) {
        return batch
      }
    }
  }

  return batches[0] ?? null
}

/**
 * 格式化视频提示词镜头序号。
 *
 * @param batch - 当前视频提示词镜头。
 * @returns 两位数镜头序号。
 */
export const formatVideoBatchIndex = (batch: VideoPromptBatch) =>
  String(batch.index).padStart(2, '0')

/**
 * 读取指定镜头当前可提交的提示词草稿。
 *
 * @param batch - 当前视频提示词镜头。
 * @param promptDrafts - 组件内保存的本地提示词草稿。
 * @returns 用户编辑后的本地草稿；没有草稿时返回后端提示词。
 */
export const getVideoPromptDraft = (
  batch: VideoPromptBatch,
  promptDrafts: Record<string, string>,
) => promptDrafts[createVideoBatchKey(batch)] ?? batch.prompt

/**
 * 创建单个镜头的视频生成提交输入。
 *
 * @param params - 视频生成提交输入参数。
 * @param params.aspectRatio - 当前 video-prompt artifact 的视频比例。
 * @param params.batch - 当前视频提示词镜头。
 * @param params.prompt - 已 trim 的当前提示词。
 * @param params.seconds - 当前镜头时长。
 * @returns 可传给 agent session 视频生成提交接口的输入。
 */
export const createVideoGenerationInput = ({
  aspectRatio,
  batch,
  prompt,
  seconds,
}: {
  aspectRatio: string
  batch: VideoPromptBatch
  prompt: string
  seconds: number
}): VideoPromptGenerationInput => ({
  aspectRatio,
  prompt,
  referenceAudios: [],
  referenceImages: getVideoPromptReferenceImageUrls(batch),
  referenceVideos: [],
  seconds,
  shotIndex: batch.index,
})

/**
 * 为全部镜头创建视频生成提交队列，并返回首个阻断原因。
 *
 * @param params - 全部提交队列参数。
 * @param params.aspectRatio - 当前 video-prompt artifact 的视频比例。
 * @param params.batches - 后端返回的视频提示词镜头列表。
 * @param params.generatedVideoStatusByPromptIndex - 按镜头序号归并的视频生成阻断状态。
 * @param params.promptDrafts - 组件内保存的本地提示词草稿。
 * @param params.submittedBatchKeys - 当前组件内刚刚提交成功、等待后端刷新状态的镜头 key。
 * @returns 可提交的镜头队列；存在无效镜头时返回阻断原因。
 */
export const createVideoGenerationSubmissionItems = ({
  aspectRatio,
  batches,
  generatedVideoStatusByPromptIndex,
  promptDrafts,
  submittedBatchKeys,
}: {
  aspectRatio?: string
  batches: VideoPromptBatch[]
  generatedVideoStatusByPromptIndex: ReadonlyMap<number, GeneratedVideoStatus>
  promptDrafts: Record<string, string>
  submittedBatchKeys: ReadonlySet<string>
}): { blocker: string | null; items: VideoPromptGenerationSubmissionItem[] } => {
  const normalizedAspectRatio = aspectRatio?.trim()
  const items: VideoPromptGenerationSubmissionItem[] = []

  for (const batch of batches) {
    const batchKey = createVideoBatchKey(batch)
    const submittedBlocker = submittedBatchKeys.has(batchKey)
      ? '当前镜头已提交，等待状态刷新。'
      : null
    const generatedVideoStatus = generatedVideoStatusByPromptIndex.get(batch.index)
    const generatedVideoStatusBlocker = generatedVideoStatus
      ? getVideoGenerationStatusBlocker(generatedVideoStatus)
      : null

    if (generatedVideoStatusBlocker ?? submittedBlocker) {
      return {
        blocker: `镜头 ${formatVideoBatchIndex(batch)}：${generatedVideoStatusBlocker ?? submittedBlocker}`,
        items: [],
      }
    }

    const promptDraft = getVideoPromptDraft(batch, promptDrafts)
    const blocker = getVideoGenerationSubmitBlocker({
      aspectRatio: normalizedAspectRatio,
      prompt: promptDraft,
      seconds: batch.second,
    })

    if (blocker) {
      return {
        blocker: `镜头 ${formatVideoBatchIndex(batch)}：${blocker}`,
        items: [],
      }
    }

    if (!normalizedAspectRatio || !batch.second) {
      return {
        blocker: `镜头 ${formatVideoBatchIndex(batch)}：当前镜头缺少生成参数，无法提交。`,
        items: [],
      }
    }

    items.push({
      batch,
      batchKey,
      input: createVideoGenerationInput({
        aspectRatio: normalizedAspectRatio,
        batch,
        prompt: promptDraft.trim(),
        seconds: batch.second,
      }),
    })
  }

  return {
    blocker: items.length > 0 ? null : '当前没有可提交的视频镜头。',
    items,
  }
}

/**
 * 阻止画布拖拽事件从提示词按钮继续冒泡。
 *
 * @param event - 需要截断冒泡的交互事件。
 */
export const stopActionPropagation = (event: { stopPropagation: () => void }) => {
  event.stopPropagation()
}
