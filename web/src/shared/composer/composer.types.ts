export type ComposerAttachmentDelivery = 'local' | 'remote'
export type ComposerMediaType = 'audio' | 'image' | 'video'

export interface ComposerFileAttachment {
  id: string
  delivery: ComposerAttachmentDelivery
  file?: File
  kind: ComposerMediaType
  mediaType: string
  name: string
  thumbnailUrl?: string
  url: string
}

export interface ComposerMediaReference {
  attachmentId: string
  fileName: string
  mediaType: ComposerMediaType
  thumbnailUrl?: string
  url: string
}

/**
 * 聊天提交的有序消息 part：文本与媒体按正文 chip 位置交错。
 * 同一附件被多个 chip 引用时会出现多个 media part（位置语义）。
 */
export type MediaComposerMessagePart =
  { type: 'text'; text: string } | { type: 'media'; attachment: ComposerFileAttachment }

export interface MediaComposerMessage {
  parts: MediaComposerMessagePart[]
}
