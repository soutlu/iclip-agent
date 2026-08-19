/**
 * 文件预签名上传与素材库登记工具。
 *
 * 通过后端 presign 接口获取上传地址，将文件 PUT 到 OSS；「上传即登记」
 * 场景在 PUT 成功后调 `registerUploadedAsset` 由素材库签发身份。
 */

import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'

/** 后端 `/presign` 响应（只声明前端消费的字段）。 */
const presignResponseSchema = z.object({
  content_type: z.string(),
  public_url: z.string(),
  upload_url: z.string(),
})

/** 后端 `POST /assets` 登记响应（只声明前端消费的字段）。 */
const registerAssetResponseSchema = z.object({
  asset: z.object({ id: z.string() }),
})

interface RegisterUploadedAssetOptions {
  assetType: 'image' | 'video' | 'audio' | 'file'
  filename?: string
  mimeType: string
  sessionId?: string
  sizeBytes?: number
  url: string
}

/**
 * 把已上传 OSS 的媒体登记进素材库（get-or-create，同 URL 幂等命中同一身份）。
 *
 * 「上传即登记」：身份在发送前由素材库显式签发，消息发送后后端按 URL 命中
 * 同一行。`sessionId` 只作登记地点（provenance），不构成授权，也不写
 * session 账本——入账只发生在消息真正进入对话时。
 *
 * @param options 已上传媒体的登记信息。
 * @returns 素材身份（既有或新建行）。
 */
export const registerUploadedAsset = async (options: RegisterUploadedAssetOptions) =>
  (
    await apiFetch('/assets', registerAssetResponseSchema, {
      body: {
        assetType: options.assetType,
        ...(options.filename ? { metadata: { filename: options.filename } } : {}),
        mimeType: options.mimeType,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.sizeBytes ? { sizeBytes: options.sizeBytes } : {}),
        source: 'upload',
        url: options.url,
      },
      fallbackErrorMessage: '登记素材失败',
      method: 'POST',
    })
  ).asset

interface PresignUploadResult {
  contentType: string
  publicUrl: string
}

interface PresignUploadOptions {
  dir?: string
}

const getFileExtension = (filename: string): string => {
  const segments = filename.split('.')
  const ext = segments.at(-1)?.trim().toLowerCase()

  if (!ext || ext === filename) {
    throw new Error(`无法从文件名中提取扩展名：${filename}`)
  }

  return ext
}

/**
 * 预签名上传文件到 OSS。
 *
 * @param file 待上传的 File 对象
 * @returns publicUrl（CDN 访问地址）和 contentType
 */
export const presignAndUpload = async (
  file: File,
  options: PresignUploadOptions = {},
): Promise<PresignUploadResult> => {
  const ext = getFileExtension(file.name)

  const presign = await apiFetch('/presign', presignResponseSchema, {
    body: {
      dir: options.dir,
      ext,
    },
    fallbackErrorMessage: '预签名请求失败',
    method: 'POST',
  })

  // OSS 直传 PUT 不是后端 REST 接口，保持裸 fetch；其 403 与会话权限无关，不上报全局处理器。
  const uploadResponse = await fetch(presign.upload_url, {
    body: file,
    headers: { 'Content-Type': presign.content_type },
    method: 'PUT',
  })

  if (!uploadResponse.ok) {
    throw new Error(`文件上传失败（${uploadResponse.status}）：${uploadResponse.statusText}`)
  }

  return {
    contentType: presign.content_type,
    publicUrl: presign.public_url,
  }
}
