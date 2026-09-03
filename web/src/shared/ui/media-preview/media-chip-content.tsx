/**
 * 芯片里那两样东西：14px 缩略图（推不出图就画种类图标）加名字。
 *
 * 输入框 pill 与用户气泡的外壳不同（一个是编辑器的 span，一个是按钮），里面这两样必须一样。
 */

import { Icon } from '@/shared/icons'
import { imageThumbnailUrl, videoSnapshotUrl } from '@/shared/lib/media-url'
import { ellipsizeAttachmentName } from './attachment-format'
import { MEDIA_KIND_ICON, type MediaDescriptor, mediaDisplayName } from './media-descriptor'

/**
 * 芯片上那颗小图的地址：图片挂缩略参数，视频取 OSS 首帧截图。
 * 本地 blob 的视频与非 OSS 地址推不出截图，那时画图标。
 *
 * @param media - 媒体描述。
 * @returns 缩略图地址；推不出就 undefined。
 */
export const mediaThumbnailUrl = (media: MediaDescriptor): string | undefined => {
  if (media.previewUrl === undefined || media.kind === 'file') return undefined
  return media.kind === 'image'
    ? imageThumbnailUrl(media.previewUrl)
    : videoSnapshotUrl(media.previewUrl)
}

/**
 * 渲染芯片内容。
 *
 * @param props - 组件属性。
 * @param props.media - 媒体描述。
 * @returns 缩略图与名字两个 span。
 */
export function MediaChipContent({ media }: { media: MediaDescriptor }) {
  const thumbnail = mediaThumbnailUrl(media)

  return (
    <>
      <span className="media-chip-icon">
        {thumbnail === undefined ? (
          <Icon decorative name={MEDIA_KIND_ICON[media.kind]} size="sm" />
        ) : (
          <img alt="" className="size-full rounded-xs object-cover" src={thumbnail} />
        )}
      </span>
      <span className="media-chip-name">{ellipsizeAttachmentName(mediaDisplayName(media))}</span>
    </>
  )
}
