/**
 * 素材上传与转存。
 *
 * 上传三步走，中间那一步不经过后端：签名 → 浏览器直接 PUT 到对象存储 → 登记。名字
 * （assetId）在字节动之前就由后端发下来，所以连接断在响应到达之前时，那份已经传上去
 * 的东西仍然认领得回来。
 *
 * 图片的宽高要在签名那一步报上去：后端按短边 / 长边卡区间，不合格的压根不用先传。
 */

import { z } from 'zod'
import { apiFetch } from '@/shared/api/client'

/**
 * 后端收的类型，以及各自算哪一类。
 *
 * 不在这张表里的（音频、任意文件）在这里就拦掉。后端只收图和视频，让它跑到签名那一步
 * 再 422 只是把同一句话说得更晚。
 */
const ACCEPTED_CONTENT_TYPES: Record<string, 'image' | 'video'> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
}

const ACCEPTED_TYPES_HINT = '只能传 JPG / PNG / WebP 图片与 MP4 / MOV 视频'

const uploadTicketSchema = z.object({
  assetId: z.string().min(1),
  upload: z.object({
    expiresAt: z.string(),
    headers: z.record(z.string(), z.string()),
    method: z.literal('PUT'),
    url: z.string(),
  }),
})

const assetSchema = z.object({
  assetType: z.enum(['image', 'video']),
  contentType: z.string(),
  createdAt: z.string(),
  creatorUserId: z.string(),
  id: z.string().min(1),
  sizeBytes: z.number(),
  url: z.string(),
})

const assetEnvelopeSchema = z.object({ asset: assetSchema })

/** 素材库账本上的一行。`url` 是后端按对象 key 拼出来的投影，身份是 `id`。 */
export type RegisteredAsset = z.infer<typeof assetSchema>

/**
 * 读出一张图的像素尺寸。
 *
 * @param file - 图片文件。
 * @returns 宽高。
 * @throws 文件解不成图片时抛出。
 */
const readImageSize = async (file: File) => {
  let bitmap: ImageBitmap

  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`读不出 ${file.name} 的尺寸，这个文件可能不是图片或已损坏。`)
  }

  try {
    return { height: bitmap.height, width: bitmap.width }
  } finally {
    bitmap.close()
  }
}

/**
 * 上传一个本地文件并登记进素材库。
 *
 * @param file - 用户选的本地文件。
 * @returns 账本上那一行，含可直接使用的公网地址。
 * @throws 类型不收、图片尺寸不合格、上传或登记失败时抛出。
 */
export const uploadAndRegisterAsset = async (file: File): Promise<RegisteredAsset> => {
  const kind = ACCEPTED_CONTENT_TYPES[file.type]

  if (!kind) {
    throw new Error(`不支持 ${file.type || '未知'} 这个类型，${ACCEPTED_TYPES_HINT}。`)
  }

  const ticket = await apiFetch('/uploads/sign', uploadTicketSchema, {
    body: {
      contentType: file.type,
      ...(kind === 'image' ? await readImageSize(file) : {}),
    },
    fallbackErrorMessage: '获取上传地址失败',
    method: 'POST',
  })

  // 对象存储直传不是后端 REST 接口，保持裸 fetch；它的 403 与会话权限无关，不上报全局
  // 处理器。headers 必须原样带上：Content-Type 被签进了签名里，换一个值就验签不过。
  const uploaded = await fetch(ticket.upload.url, {
    body: file,
    headers: ticket.upload.headers,
    method: ticket.upload.method,
  })

  if (!uploaded.ok) {
    throw new Error(`文件上传失败（${uploaded.status}）：${uploaded.statusText}`)
  }

  // 登记没有请求体：真实 key、多大、什么类型全部由后端从桶里读回来。
  return (
    await apiFetch(`/assets/${ticket.assetId}`, assetEnvelopeSchema, {
      fallbackErrorMessage: '登记素材失败',
      method: 'POST',
    })
  ).asset
}

/**
 * 把一个外部地址上的东西转存进素材库。
 *
 * 产品图与爆款库的视频只有外链，上游一换就烂；转存之后拿到的是我们自己的地址。同一个
 * 源地址转存多少次都是同一行，重复调用不会多搬一份。
 *
 * @param url - 外部地址。
 * @returns 账本上那一行。
 * @throws 取不回来、类型不收、图片尺寸不合格时抛出。
 */
export const importAssetFromUrl = async (url: string): Promise<RegisteredAsset> =>
  (
    await apiFetch('/assets/import', assetEnvelopeSchema, {
      body: { url },
      fallbackErrorMessage: '转存素材失败',
      method: 'POST',
    })
  ).asset
