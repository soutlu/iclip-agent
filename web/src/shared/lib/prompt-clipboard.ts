/** 消息在剪贴板里的形态就是发消息接口的 content 数组，复制与粘贴共用这份读写。 */

import { z } from 'zod'
import { zImageContent, zTextContent, zVideoContent } from '@/shared/api/generated/zod.gen'
import type { PromptContentPart } from '@/shared/transcript/vendor'

const contentPartSchema = z.union([zTextContent, zImageContent, zVideoContent])

/** 复制成缩进 JSON，可直接当 prompts 接口的 content 重放。 */
export const serializePromptContent = (content: readonly PromptContentPart[]): string =>
  JSON.stringify(content, null, 2)

/**
 * 认出一段文本是不是一条消息的 content，不是就返回 null，由调用方按普通文字处理。
 *
 * 生成 schema 允许省略 `type`、允许 file / session_media 来源和空地址，这些形态输入框还原不出附件，
 * 所以额外要求每项显式写明 `type`，媒体项必须带非空的 url 来源。
 */
export const parsePromptContent = (text: string): PromptContentPart[] | null => {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(payload) || payload.length === 0) return null
  const parts: PromptContentPart[] = []
  for (const item of payload) {
    const part = contentPart(item)
    if (part === null) return null
    parts.push(part)
  }
  return parts
}

const contentPart = (raw: unknown): PromptContentPart | null => {
  // 生成 schema 会替缺失的 type 填默认值，所以先看原始对象自己写了没有。
  if (typeof raw !== 'object' || raw === null || !('type' in raw)) return null
  const parsed = contentPartSchema.safeParse(raw)
  if (!parsed.success) return null
  const part = parsed.data
  if (part.type === 'text') return { text: part.text, type: 'text' }
  const { kind, url } = part.source
  if (kind !== 'url' || typeof url !== 'string' || url === '') return null
  return { source: { kind: 'url', url }, type: part.type }
}
