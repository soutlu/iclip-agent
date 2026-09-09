/** 媒体描述独立于上传条目；缩略图由 previewUrl 派生，避免重复存储。 */

import type { IconName } from '@/shared/icons'

export type MediaKind = 'file' | 'image' | 'video'

export type MediaUploadState =
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready' }
  | { readonly status: 'uploading'; readonly progress: number | undefined }

export type MediaDescriptor = {
  readonly kind: MediaKind
  /** 名称为空时使用媒体种类文案。 */
  readonly name: string
  /** 字节数缺失时省略大小。 */
  readonly size?: number | undefined
  /** 缺少预览地址时禁用预览与全屏。 */
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

export const mediaDisplayName = (media: MediaDescriptor): string =>
  media.name === '' ? MEDIA_KIND_NAME[media.kind] : media.name
