import {
  createMediaComposerMessage,
  parseMediaComposerDocument,
  type ComposerFileAttachment,
  type MediaComposerDraft,
} from '@/shared/composer'
import { isRecord } from '@/shared/lib/guards'

const PROJECT_PENDING_DRAFT_STORAGE_PREFIX = 'producer.mediaComposer.pendingDraft.v1'

export type ProjectPendingDraft = MediaComposerDraft

/**
 * 生成当前版本的项目 session 一次性草稿 key。
 *
 * @param projectId - 项目文件夹 id。
 * @param sessionId - Agno session id。
 * @returns 与旧 storage 命名空间隔离的当前版本 key。
 */
const createProjectPendingDraftKey = (projectId: string, sessionId: string) =>
  `${PROJECT_PENDING_DRAFT_STORAGE_PREFIX}.${projectId}.${sessionId}`

/**
 * 从未知对象读取非空字符串字段。
 *
 * @param record - 待读取对象。
 * @param field - 字段名。
 * @returns 已校验的字符串值。
 * @throws 当字段缺失或为空时抛出错误。
 */
const readRequiredString = (record: Record<string, unknown>, field: string) => {
  const value = record[field]

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`待提交草稿缺少 ${field}`)
  }

  return value
}

/**
 * 解析可跨页恢复的远端附件。
 *
 * @param value - 未知附件值。
 * @returns 不含 File 或 blob URL 的远端附件。
 * @throws 当附件结构、delivery 或远端字段无效时抛出错误。
 */
const readPendingDraftAttachment = (value: unknown): ComposerFileAttachment => {
  const record = isRecord(value) ? value : null

  if (!record) {
    throw new Error('待提交草稿附件格式无效')
  }

  if (readRequiredString(record, 'delivery') !== 'remote') {
    throw new Error('待提交草稿只能保存远端附件')
  }

  if (Object.hasOwn(record, 'file')) {
    throw new Error('待提交草稿不能保存本地 File')
  }

  const url = readRequiredString(record, 'url')

  if (url.startsWith('blob:')) {
    throw new Error('待提交草稿附件必须使用远端 URL')
  }

  const thumbnailUrl =
    typeof record.thumbnailUrl === 'string' && record.thumbnailUrl.trim().length > 0
      ? record.thumbnailUrl
      : undefined

  if (thumbnailUrl?.startsWith('blob:')) {
    throw new Error('待提交草稿缩略图必须使用远端 URL')
  }

  const kind = record.kind

  if (kind !== 'audio' && kind !== 'image' && kind !== 'video') {
    throw new Error('待提交草稿附件类型无效')
  }

  return {
    delivery: 'remote',
    id: readRequiredString(record, 'id'),
    kind,
    mediaType: readRequiredString(record, 'mediaType'),
    name: readRequiredString(record, 'name'),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    url,
  }
}

/**
 * 解析并验证 sessionStorage 中的当前版本草稿。
 *
 * @param value - 待校验的未知草稿值。
 * @returns 引用闭包完整的草稿和已投影提交对象。
 * @throws 当附件、文档 schema、文字或引用闭包无效时抛出错误。
 */
const parseProjectPendingDraft = (value: unknown) => {
  const record = isRecord(value) ? value : null

  if (!record) {
    throw new Error('待提交草稿格式无效')
  }

  if (!Array.isArray(record.attachments)) {
    throw new Error('待提交草稿缺少 attachments')
  }

  const attachments = record.attachments.map(readPendingDraftAttachment)
  const attachmentIds = new Set<string>()

  for (const attachment of attachments) {
    if (attachmentIds.has(attachment.id)) {
      throw new Error(`待提交草稿附件 id 重复：${attachment.id}`)
    }

    attachmentIds.add(attachment.id)
  }

  const draft: MediaComposerDraft = {
    attachments,
    document: parseMediaComposerDocument(record.document),
  }

  return {
    draft,
    message: createMediaComposerMessage({ draft, libraryMedia: [] }),
  }
}

/**
 * 保存由项目页 Agent runtime 接管的一次性结构化草稿。
 *
 * @param projectId - 项目文件夹 id。
 * @param sessionId - Agno session id。
 * @param draft - 已上传为远端附件的当前版本草稿。
 * @throws 当草稿无法安全序列化或恢复时抛出错误。
 */
export const storeProjectPendingDraft = (
  projectId: string,
  sessionId: string,
  draft: ProjectPendingDraft,
) => {
  const { draft: validatedDraft } = parseProjectPendingDraft(draft)
  window.sessionStorage.setItem(
    createProjectPendingDraftKey(projectId, sessionId),
    JSON.stringify(validatedDraft),
  )
}

/**
 * 一次性消费项目 session 的结构化 pending draft。
 *
 * @param projectId - 项目文件夹 id。
 * @param sessionId - Agno session id。
 * @returns 不存在时返回 null；存在时返回已验证草稿和提交投影。
 * @throws 当存储内容无效时在删除原值后抛出错误。
 */
export const consumeProjectPendingDraft = (projectId: string, sessionId: string) => {
  const key = createProjectPendingDraftKey(projectId, sessionId)
  const rawDraft = window.sessionStorage.getItem(key)

  if (!rawDraft) {
    return null
  }

  window.sessionStorage.removeItem(key)
  return parseProjectPendingDraft(JSON.parse(rawDraft) as unknown)
}
