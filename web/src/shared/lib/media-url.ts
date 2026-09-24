/** OSS 缩略参数仅适用于无 query / hash 的 aliyuncs.com 地址，其他来源不追加处理参数。 */

const OSS_PLAIN_URL = /^https?:\/\/[^/?#]*\.aliyuncs\.com\/[^?#]*$/

/** 从路径末段解码文件名，忽略 query 与 hash；data: 返回空串。 */
export const fileNameOfUrl = (url: string): string => {
  if (url.startsWith('data:')) return ''
  const path = url.split(/[?#]/, 1)[0] ?? url
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
}

/** 图片缩略图；`process` 是 `image/` 之后的 OSS 处理串，默认长边 64。不是 OSS 地址就原图。 */
export const imageThumbnailUrl = (url: string, process = 'resize,l_64'): string =>
  OSS_PLAIN_URL.test(url) ? `${url}?x-oss-process=image/${process}` : url

/** 仅 OSS 支持视频截帧；调用方需按显示尺寸指定宽度，避免放大模糊，高度随原比例。
 *
 * 默认截首帧，用快速模式；指定 `atSeconds` 时精确截那一刻，因为快速模式会退到前一个关键帧，
 * 而生成视频的关键帧间隔常比一个镜头还长。 */
export const videoSnapshotUrl = (url: string, width = 128, atSeconds = 0): string | undefined => {
  if (!OSS_PLAIN_URL.test(url)) return undefined
  const at = Math.max(0, Math.round(atSeconds * 1000))
  return `${url}?x-oss-process=video/snapshot,t_${at},f_jpg,w_${width},h_0${at === 0 ? ',m_fast' : ''}`
}
