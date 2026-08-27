import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  ProjectAssistantBubbleTimelineItem,
  ProjectFilePart,
  ProjectMessagePart,
  ProjectReasoningPart,
  ProjectTextPart,
} from '@/features/chat/contracts'
import type { ComposerMediaReference } from '@/shared/composer'
import { createEditorMediaReference, EditorReferenceChip } from '@/shared/editor'
import { cn } from '@/shared/lib/utils'
import { createOssVideoSnapshotUrl } from '@/shared/ui/media'

export const MARKDOWN_REMARK_PLUGINS = [remarkGfm]

/**
 * 判断消息 part 是否是正文文本。
 *
 * @param part - 需要检查的项目消息 part。
 * @returns 文本 part 返回 true。
 */
export const isTextPart = (part: ProjectMessagePart): part is ProjectTextPart =>
  part.type === 'text'

/**
 * 判断消息 part 是否是推理文本。
 *
 * @param part - 需要检查的项目消息 part。
 * @returns reasoning part 返回 true。
 */
export const isReasoningPart = (part: ProjectMessagePart): part is ProjectReasoningPart =>
  part.type === 'reasoning'

/**
 * 判断消息 part 是否是文件附件。
 *
 * @param part - 需要检查的项目消息 part。
 * @returns file part 返回 true。
 */
export const isFilePart = (part: ProjectMessagePart): part is ProjectFilePart =>
  part.type === 'file'

/**
 * 判断消息 part 是否能产生真实可见内容。
 *
 * @param part - 需要检查的项目消息 part。
 * @returns 文本、推理或文件内容可见时返回 true。
 */
export const isRenderableMessagePart = (part: ProjectMessagePart) => {
  if (isTextPart(part) || isReasoningPart(part)) {
    return part.text.trim().length > 0
  }

  return isFilePart(part)
}

/**
 * 判断 assistant timeline item 是否应该渲染为回复节点。
 *
 * @param item - assistant-bubble timeline item。
 * @returns response shell 或至少一个真实 part 可见时返回 true。
 */
export const assistantTimelineItemHasRenderableContent = (
  item: ProjectAssistantBubbleTimelineItem,
) => item.isResponseShell === true || item.message.parts.some(isRenderableMessagePart)

/**
 * 根据文件 part 推导用户可读名称。
 *
 * @param file - 项目文件消息 part。
 * @param index - 文件在当前消息中的位置。
 * @returns 文件展示名。
 */
export const fileDisplayName = (file: ProjectFilePart, index: number) =>
  file.filename?.trim() ||
  (file.mediaType.startsWith('audio/')
    ? `audio_${index + 1}`
    : file.mediaType.startsWith('image/')
      ? `image_${index + 1}`
      : `video_${index + 1}`)

/**
 * 根据 file part 的媒体类型推导内联缩略图类型。
 *
 * @param file - 项目文件消息 part。
 * @returns 图片文件返回 image，其余文件返回 video。
 */
export const mediaReferenceTypeFromFile = (
  file: ProjectFilePart,
): ComposerMediaReference['mediaType'] =>
  file.mediaType.startsWith('audio/')
    ? 'audio'
    : file.mediaType.startsWith('image/')
      ? 'image'
      : 'video'

/**
 * 将消息 file part 转换为媒体 key 引用。
 *
 * @param file - 项目文件消息 part。
 * @param index - 文件在当前消息里的顺序。
 * @returns 可供聊天消息内联缩略图使用的媒体引用。
 */
export const mediaReferenceFromFilePart = (
  file: ProjectFilePart,
  index: number,
): ComposerMediaReference => {
  const mediaType = mediaReferenceTypeFromFile(file)
  const videoThumbnailUrl = mediaType === 'video' ? createOssVideoSnapshotUrl(file.url) : undefined

  return {
    attachmentId: file.id ?? file.filename ?? file.url,
    fileName: fileDisplayName(file, index),
    mediaType,
    thumbnailUrl: mediaType === 'image' ? file.url : videoThumbnailUrl,
    url: file.url,
  }
}

/**
 * 渲染聊天消息里的内联媒体缩略图。
 *
 * @param props - 内联媒体缩略图属性。
 * @param props.onOpenPreview - 打开当前媒体预览。
 * @param props.reference - 已按媒体 key 命中的媒体引用。
 * @returns 视觉上替代 image_1/video_1 的缩略图 chip。
 */
export const ProjectInlineMediaReferenceChip = ({
  onOpenPreview,
  reference,
}: {
  onOpenPreview: (reference: ComposerMediaReference) => void
  reference: ComposerMediaReference
}) => {
  const previewUrl =
    reference.mediaType === 'image'
      ? (reference.thumbnailUrl ?? reference.url)
      : reference.mediaType === 'video'
        ? (reference.thumbnailUrl ?? createOssVideoSnapshotUrl(reference.url))
        : reference.thumbnailUrl
  const editorReference = createEditorMediaReference({
    id: `message:${reference.attachmentId}`,
    kind: reference.mediaType,
    label: reference.fileName,
    ...(previewUrl ? { previewUrl } : {}),
    sourceDisplayName: reference.fileName,
    url: reference.url,
  })

  return (
    <span
      className="mx-1 my-0.5 inline-flex align-middle"
      data-project-inline-media-chip={reference.fileName}
    >
      <EditorReferenceChip
        onActivate={() => onOpenPreview(reference)}
        reference={editorReference}
      />
    </span>
  )
}

/**
 * 渲染 markdown 文本块。
 *
 * @param props - markdown 渲染属性。
 * @param props.className - 追加到 markdown 根容器上的类名。
 * @param props.text - 需要渲染的 markdown 文本。
 * @returns markdown 内容元素。
 */
export const ProjectMarkdownBlock = ({
  className = '',
  text,
}: {
  className?: string
  text: string
}) => {
  return (
    <div
      className={cn(
        'project-chat-markdown max-w-full overflow-x-auto text-body-sm leading-[1.62] [overflow-wrap:anywhere] text-chat-message-text [&_a]:text-chat-link-text [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-chat-link-border [&_blockquote]:pl-3 [&_code]:rounded-xs [&_code]:bg-chat-code-bg [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-label [&_li]:my-1 [&_ol]:my-2 [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-chat-code-border [&_pre]:bg-chat-code-block-bg [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-chat-code-border [&_td]:p-2 [&_th]:border [&_th]:border-chat-code-border [&_th]:p-2 [&_ul]:my-2 [&_ul]:pl-5',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{text}</ReactMarkdown>
    </div>
  )
}

/**
 * 渲染用户消息中的附件 chips。
 *
 * @param props - 附件渲染属性。
 * @param props.align - chips 在当前气泡中的对齐方向。
 * @param props.files - 当前消息携带的文件 part。
 * @returns 附件 chip 列表。
 */
export const ProjectMessageFileChips = ({
  align = 'end',
  files,
}: {
  align?: 'end' | 'start'
  files: ProjectFilePart[]
}) => {
  if (files.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'mt-2 flex flex-wrap gap-1.5',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
    >
      {files.map((file, index) => {
        const displayName = fileDisplayName(file, index)

        return (
          <span
            key={`${file.url}:${file.mediaType}:${index.toString(36)}`}
            className="max-w-[180px] truncate rounded-full border border-chat-chip-border bg-chat-chip-bg px-2.5 py-1 text-caption text-chat-muted-text"
            data-project-file-chip={displayName}
            title={displayName}
          >
            {displayName}
          </span>
        )
      })}
    </div>
  )
}

/**
 * 渲染单个推理折叠块。
 *
 * @param props - 推理块属性。
 * @param props.part - 推理消息 part。
 * @param props.running - 当前 timeline 段是否运行中。
 * @returns 推理折叠块元素。
 */
export const ProjectReasoningBlock = ({
  part,
  running,
}: {
  part: ProjectReasoningPart
  running: boolean
}) => (
  <details
    className="rounded-md border border-chat-inline-border bg-chat-inline-bg px-3 py-2"
    open={running}
  >
    <summary className="cursor-pointer text-label text-chat-muted-text select-none">
      推理过程
    </summary>
    <div className="mt-2 text-label leading-5 whitespace-pre-wrap text-chat-secondary-text">
      {part.text}
    </div>
  </details>
)
