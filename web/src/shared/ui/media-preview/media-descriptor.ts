/**
 * 一份媒体的描述：芯片与悬停卡只认它，不认某一处的上传条目类型。
 *
 * 缩略图与视频首帧都由预览地址现推（见 shared/lib/media-url），所以描述里不带图形地址。
 */

import type { IconName } from '@/shared/icons'

/** 媒体种类：image / video 能预览，file 只有名字。 */
export type MediaKind = 'file' | 'image' | 'video'

/** 上传状态。只有输入框里的媒体带它——气泡里的已经在服务端了。 */
export type MediaUploadState =
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready' }
  | { readonly status: 'uploading'; readonly progress: number | undefined }

export type MediaDescriptor = {
  readonly kind: MediaKind
  /** 文件名；空串时按种类兜底成「图片」「视频」「附件」。 */
  readonly name: string
  /** 字节数；给不出就不显示大小。 */
  readonly size?: number | undefined
  /** 预览地址（本地 blob 或公网地址）；没有就既不预览也不能全屏。 */
  readonly previewUrl?: string | undefined
  readonly upload?: MediaUploadState | undefined
}

export const MEDIA_KIND_ICON: Record<MediaKind, IconName> = {
  file: 'file',
  image: 'image',
  video: 'video',
}

const MEDIA_KIND_NAME: Record<MediaKind, string> = {
  file: '附件',
  image: '图片',
  video: '视频',
}

/**
 * 拿这份媒体该显示的名字。
 *
 * @param media - 媒体描述。
 * @returns 文件名，没有文件名就按种类兜底。
 */
export const mediaDisplayName = (media: MediaDescriptor): string =>
  media.name === '' ? MEDIA_KIND_NAME[media.kind] : media.name
