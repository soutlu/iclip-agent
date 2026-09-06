import { apiFetch } from './client'
import { zAssetEnvelope, zUploadTicketOut } from './generated/zod.gen'

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const VIDEO_TYPES = ['video/mp4', 'video/quicktime']
export const MEDIA_IMAGE_ACCEPT = IMAGE_TYPES.join(',')
export const MEDIA_VIDEO_ACCEPT = VIDEO_TYPES.join(',')

/** 文件选择与拖放共用校验；图片尺寸须解码后才能用于签名。 */
const mediaDimensions = async (file: File, kind: 'image' | 'video') => {
  if (kind === 'video') {
    if (!VIDEO_TYPES.includes(file.type)) throw new Error('请选择 MP4 或 MOV 视频')
    if (file.size > 512 * 1024 * 1024) throw new Error('视频不能超过 512 MiB')
    return { height: null, width: null }
  }
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('请选择 JPEG、PNG 或 WebP 图片')
  if (file.size > 16 * 1024 * 1024) throw new Error('图片不能超过 16 MiB')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch (cause) {
    throw new Error('无法读取图片，请选择有效的图片文件', { cause })
  }
  const { width, height } = bitmap
  bitmap.close()
  if (Math.min(width, height) < 300 || Math.max(width, height) > 6000) {
    throw new Error('图片短边至少 300 像素，长边不能超过 6000 像素')
  }
  return { height, width }
}

/** 签名、直传并登记素材；仅在登记成功后返回可持久化的素材 URL。 */
export const uploadMediaFile = async (file: File, kind: 'image' | 'video'): Promise<string> => {
  const dimensions = await mediaDimensions(file, kind)
  const ticket = await apiFetch('/uploads/sign', zUploadTicketOut, {
    body: { contentType: file.type, ...dimensions },
    fallbackErrorMessage: '上传失败',
    method: 'POST',
  })
  const response = await fetch(ticket.upload.url, {
    body: file,
    headers: ticket.upload.headers,
    method: ticket.upload.method,
  })
  if (!response.ok) throw new Error(`上传失败：${response.status}`)
  const envelope = await apiFetch(`/assets/${ticket.assetId}`, zAssetEnvelope, {
    fallbackErrorMessage: '上传失败',
    method: 'POST',
  })
  return envelope.asset.url
}
