import { generateText, getSchema, type JSONContent, type TextSerializer } from '@tiptap/core'
import type {
  ComposerFileAttachment,
  ComposerMediaType,
  MediaComposerMessage,
  MediaComposerMessagePart,
} from '@/shared/composer/composer.types'
import {
  COMPOSER_MEDIA_LIMIT_ERROR_MESSAGE,
  type ComposerMediaNameSeed,
  isComposerMediaWithinLimits,
  normalizeComposerAttachmentNamesByOrder,
} from '@/shared/composer/composer-attachment.utils'
import { reorderComposerAttachments } from '@/shared/composer/composer-media-stack.utils'
import {
  MEDIA_COMPOSER_SCHEMA_EXTENSIONS,
  MEDIA_REFERENCE_NODE_NAME,
} from '@/shared/composer/media-composer-schema'
import {
  createEditorMediaReference,
  createEditorReferenceMap,
  hasEditorText,
  parseStrictEditorDocument,
  removeEditorReferencesFromDocument,
  type EditorMediaReference,
} from '@/shared/editor'

const ATTACHMENT_REFERENCE_PREFIX = 'attachment:'
const PROJECT_REFERENCE_PREFIX = 'project:'
const MEDIA_COMPOSER_SCHEMA = getSchema(MEDIA_COMPOSER_SCHEMA_EXTENSIONS)

export type MediaComposerDocument = JSONContent

export interface MediaComposerDraft {
  attachments: ComposerFileAttachment[]
  document: MediaComposerDocument
}

export interface MediaComposerLibraryMedia {
  assetId: string
  displayName: string
  kind: ComposerMediaType
  previewUrl?: string
  promptKey: string
  url: string
}

export interface MediaComposerReference extends EditorMediaReference {
  attachmentId?: string
}

export type MediaComposerReferenceMap = ReadonlyMap<string, MediaComposerReference>

export interface MediaComposerSubmission {
  attachments: ComposerFileAttachment[]
  prompt: string
}

interface CreateMediaComposerSubmissionOptions {
  draft: MediaComposerDraft
  libraryMedia: MediaComposerLibraryMedia[]
}

interface CreateMediaComposerReferenceMapOptions {
  attachments: ComposerFileAttachment[]
  libraryMedia: MediaComposerLibraryMedia[]
}

/**
 * 判断 Tiptap JSON 是否包含可提交的非空白文字。
 *
 * @param content - 当前文档或子节点。
 * @returns 存在非空白 text node 时返回 true。
 */
export const hasMediaComposerText = hasEditorText

/**
 * 为草稿附件创建不会随排序变化的引用标识。
 *
 * @param attachmentId - Composer 附件稳定 id。
 * @returns 带附件命名空间的引用标识。
 */
export const createComposerAttachmentReferenceId = (attachmentId: string) =>
  `${ATTACHMENT_REFERENCE_PREFIX}${attachmentId}`

/**
 * 为项目媒体创建不会随 prompt key 变化的引用标识。
 *
 * @param assetId - session fact 中的稳定 asset row id。
 * @returns 带项目媒体命名空间的引用标识。
 */
const createProjectReferenceId = (assetId: string) => `${PROJECT_REFERENCE_PREFIX}${assetId}`

/**
 * 创建符合 Media Composer schema 的空草稿。
 *
 * @returns 只含一个空段落且没有附件的草稿。
 */
export const createEmptyMediaComposerDraft = (): MediaComposerDraft => ({
  attachments: [],
  document: {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  },
})

/**
 * 把业务层纯文本转换为当前 Media Composer Tiptap 文档。
 *
 * @param text - Canvas 等外部业务入口提供的普通 prompt。
 * @returns 使用 hardBreak 保留换行的当前版本文档。
 */
export const createMediaComposerDocumentFromText = (text: string): MediaComposerDocument => {
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const paragraphContent = lines.flatMap<JSONContent>((line, index) => {
    const nodes: JSONContent[] = []

    if (index > 0) {
      nodes.push({ type: 'hardBreak' })
    }

    if (line.length > 0) {
      nodes.push({ type: 'text', text: line })
    }

    return nodes
  })

  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        ...(paragraphContent.length > 0 ? { content: paragraphContent } : {}),
      },
    ],
  }
}

/**
 * 在持久化或外部输入边界解析当前版本的 Media Composer 文档。
 *
 * @param value - 未知的 Tiptap JSON 文档值。
 * @returns 经过当前 schema 严格校验的 Tiptap JSON 文档。
 * @throws 当 JSON 结构、schema 或节点属性不受支持时抛出错误。
 */
export const parseMediaComposerDocument = (value: unknown): MediaComposerDocument => {
  return parseStrictEditorDocument(value, MEDIA_COMPOSER_SCHEMA, 'Media Composer 文档')
}

/**
 * 合并草稿附件和项目媒体，生成编辑器唯一引用目录。
 *
 * @param options - 当前有序附件与项目媒体。
 * @returns 以稳定 id 索引、保留当前目录顺序的引用表。
 * @throws 当引用 id 重复时抛出错误。
 */
export const createMediaComposerReferenceMap = ({
  attachments,
  libraryMedia,
}: CreateMediaComposerReferenceMapOptions): MediaComposerReferenceMap => {
  const references: MediaComposerReference[] = [
    ...attachments.map((attachment) => ({
      ...createEditorMediaReference({
        id: createComposerAttachmentReferenceId(attachment.id),
        kind: attachment.kind,
        label: attachment.name,
        ...(attachment.thumbnailUrl ? { previewUrl: attachment.thumbnailUrl } : {}),
        sourceDisplayName: attachment.name,
        url: attachment.url,
      }),
      attachmentId: attachment.id,
    })),
    ...libraryMedia.map((media) => ({
      ...createEditorMediaReference({
        id: createProjectReferenceId(media.assetId),
        kind: media.kind,
        label: media.promptKey,
        ...(media.previewUrl ? { previewUrl: media.previewUrl } : {}),
        sourceDisplayName: media.displayName,
        url: media.url,
      }),
    })),
  ]

  return createEditorReferenceMap(references)
}

/**
 * 收集文档中被引用的草稿附件 id（不含项目媒体引用）。
 *
 * 供暂存区区分「已插入正文 / 未引用」两态：聊天提交只发送被引用的媒体。
 *
 * @param document - 当前 Tiptap 文档（允许编辑中的草稿，宽松遍历）。
 * @returns 被 mediaReference 节点引用的附件 id 集合。
 */
export const collectReferencedComposerAttachmentIds = (
  document: MediaComposerDocument,
): ReadonlySet<string> => {
  const ids = new Set<string>()

  const visit = (node: JSONContent) => {
    if (node.type === MEDIA_REFERENCE_NODE_NAME && typeof node.attrs?.id === 'string') {
      const referenceId = node.attrs.id
      if (referenceId.startsWith(ATTACHMENT_REFERENCE_PREFIX)) {
        ids.add(referenceId.slice(ATTACHMENT_REFERENCE_PREFIX.length))
      }
    }
    for (const child of node.content ?? []) {
      visit(child)
    }
  }

  visit(document)
  return ids
}

/**
 * 从草稿移除一个附件及其全部结构化引用。
 *
 * @param draft - 当前 Media Composer 草稿。
 * @param attachmentId - 需要移除的稳定附件 id。
 * @returns 附件别名重新归一化、且不含悬空引用的新草稿。
 */
export const removeMediaComposerAttachment = (
  draft: MediaComposerDraft,
  attachmentId: string,
  mediaNameSeeds: ComposerMediaNameSeed[] = [],
): MediaComposerDraft => ({
  attachments: normalizeComposerAttachmentNamesByOrder(
    draft.attachments.filter((attachment) => attachment.id !== attachmentId),
    mediaNameSeeds,
  ),
  document: removeEditorReferencesFromDocument(
    draft.document,
    MEDIA_REFERENCE_NODE_NAME,
    new Set([createComposerAttachmentReferenceId(attachmentId)]),
  ),
})

/**
 * 调整草稿附件顺序并重新派生 prompt key，不触碰 Tiptap document。
 *
 * @param draft - 当前 Media Composer 草稿。
 * @param activeId - 被拖拽附件 id。
 * @param overId - 目标附件 id。
 * @returns 文档引用不变、附件别名按新顺序归一化的新草稿。
 */
export const reorderMediaComposerAttachments = (
  draft: MediaComposerDraft,
  activeId: string,
  overId: string,
  mediaNameSeeds: ComposerMediaNameSeed[] = [],
): MediaComposerDraft => ({
  attachments: normalizeComposerAttachmentNamesByOrder(
    reorderComposerAttachments(draft.attachments, activeId, overId),
    mediaNameSeeds,
  ),
  document: draft.document,
})

/**
 * 把 Media Composer 草稿投影为业务提交对象。
 *
 * @param options - 当前草稿和可引用的项目媒体。
 * @returns 不含 Tiptap JSON 或内部 HTML 的提交对象。
 * @throws 当文字为空、引用目录有歧义、文档存在悬空引用或 JSON schema 无效时抛出错误。
 */
export const createMediaComposerSubmission = ({
  draft,
  libraryMedia,
}: CreateMediaComposerSubmissionOptions): MediaComposerSubmission => {
  const document = parseMediaComposerDocument(draft.document)

  if (!hasMediaComposerText(document)) {
    throw new Error('请输入文字描述。')
  }

  if (!isComposerMediaWithinLimits(draft.attachments)) {
    throw new Error(COMPOSER_MEDIA_LIMIT_ERROR_MESSAGE)
  }

  const references = createMediaComposerReferenceMap({
    attachments: draft.attachments,
    libraryMedia,
  })
  const referencedProjectAttachments = new Map<string, ComposerFileAttachment>()
  const mediaReferenceSerializer: TextSerializer = ({ node }) => {
    const referenceId = typeof node.attrs.id === 'string' ? node.attrs.id : ''
    const reference = references.get(referenceId)

    if (!reference) {
      throw new Error(`Media Composer 引用不存在：${referenceId || 'unknown'}`)
    }

    if (reference.attachmentId === undefined) {
      referencedProjectAttachments.set(reference.id, {
        delivery: 'remote',
        id: reference.id,
        kind: reference.kind,
        mediaType: `${reference.kind}/*`,
        name: reference.label,
        url: reference.source.url,
      })
    }

    return `@${reference.label}`
  }

  const prompt = generateText(document, MEDIA_COMPOSER_SCHEMA_EXTENSIONS, {
    blockSeparator: '\n',
    textSerializers: {
      [MEDIA_REFERENCE_NODE_NAME]: mediaReferenceSerializer,
    },
  }).trim()
  const attachments = [...draft.attachments, ...referencedProjectAttachments.values()]

  if (!isComposerMediaWithinLimits(attachments)) {
    throw new Error(COMPOSER_MEDIA_LIMIT_ERROR_MESSAGE)
  }

  return {
    attachments,
    prompt,
  }
}

/**
 * 从解析后的引用节点解析出可发送的附件快照。
 *
 * @param reference - 引用目录命中的引用项。
 * @param attachmentsById - 草稿附件索引。
 * @returns 草稿附件本体，或项目媒体合成的远端附件。
 * @throws 当引用指向的草稿附件已不存在时抛出错误。
 */
const attachmentFromReference = (
  reference: MediaComposerReference,
  attachmentsById: ReadonlyMap<string, ComposerFileAttachment>,
): ComposerFileAttachment => {
  if (reference.attachmentId === undefined) {
    return {
      delivery: 'remote',
      id: reference.id,
      kind: reference.kind,
      mediaType: `${reference.kind}/*`,
      name: reference.label,
      url: reference.source.url,
    }
  }

  const attachment = attachmentsById.get(reference.attachmentId)

  if (!attachment) {
    throw new Error(`Media Composer 引用不存在：${reference.id}`)
  }

  return attachment
}

/**
 * 去掉首尾空白 part 并修剪边界文本，保持消息内部的换行不变。
 *
 * @param parts - 按文档顺序产出的原始 parts。
 * @returns 首文本 part 去左空白、尾文本 part 去右空白后的 parts。
 */
const trimMessagePartBoundaries = (
  parts: MediaComposerMessagePart[],
): MediaComposerMessagePart[] => {
  const trimmed = [...parts]
  const first = trimmed[0]

  if (first?.type === 'text') {
    const text = first.text.replace(/^\s+/u, '')
    if (text.length === 0) trimmed.shift()
    else trimmed[0] = { type: 'text', text }
  }

  const last = trimmed.at(-1)

  if (last?.type === 'text') {
    const text = last.text.replace(/\s+$/u, '')
    if (text.length === 0) trimmed.pop()
    else trimmed[trimmed.length - 1] = { type: 'text', text }
  }

  return trimmed
}

/**
 * 把 Media Composer 草稿投影为按 chip 位置交错的聊天消息（AG-UI 提交形态）。
 *
 * 只有被正文引用的媒体才会进入消息；未引用的草稿附件不发送。同一素材出现
 * 多个 chip 就产出多个 media part（位置语义），提交上限按被引用的不同素材
 * 数计。视频生成等平铺协议入口继续使用 `createMediaComposerSubmission`。
 *
 * @param options - 当前草稿和可引用的项目媒体。
 * @returns 文本与媒体交错的有序消息。
 * @throws 当文字为空、引用悬空、JSON schema 无效或引用素材超限时抛出错误。
 */
export const createMediaComposerMessage = ({
  draft,
  libraryMedia,
}: CreateMediaComposerSubmissionOptions): MediaComposerMessage => {
  const document = parseMediaComposerDocument(draft.document)

  if (!hasMediaComposerText(document)) {
    throw new Error('请输入文字描述。')
  }

  if (!isComposerMediaWithinLimits(draft.attachments)) {
    throw new Error(COMPOSER_MEDIA_LIMIT_ERROR_MESSAGE)
  }

  const references = createMediaComposerReferenceMap({
    attachments: draft.attachments,
    libraryMedia,
  })
  const attachmentsById = new Map(
    draft.attachments.map((attachment) => [attachment.id, attachment]),
  )
  const referencedAttachments = new Map<string, ComposerFileAttachment>()
  const parts: MediaComposerMessagePart[] = []
  let textBuffer = ''

  const flushText = () => {
    if (textBuffer.length > 0) {
      parts.push({ type: 'text', text: textBuffer })
      textBuffer = ''
    }
  }

  const visitInlineNode = (node: JSONContent) => {
    if (node.type === 'text' && typeof node.text === 'string') {
      textBuffer += node.text
      return
    }

    if (node.type === 'hardBreak') {
      textBuffer += '\n'
      return
    }

    if (node.type === MEDIA_REFERENCE_NODE_NAME) {
      const referenceId = typeof node.attrs?.id === 'string' ? node.attrs.id : ''
      const reference = references.get(referenceId)

      if (!reference) {
        throw new Error(`Media Composer 引用不存在：${referenceId || 'unknown'}`)
      }

      const attachment = attachmentFromReference(reference, attachmentsById)
      referencedAttachments.set(attachment.id, attachment)
      flushText()
      parts.push({ attachment, type: 'media' })
    }
  }

  const paragraphs = document.content ?? []
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) {
      textBuffer += '\n'
    }
    for (const child of paragraph.content ?? []) {
      visitInlineNode(child)
    }
  })
  flushText()

  if (!isComposerMediaWithinLimits([...referencedAttachments.values()])) {
    throw new Error(COMPOSER_MEDIA_LIMIT_ERROR_MESSAGE)
  }

  return { parts: trimMessagePartBoundaries(parts) }
}
