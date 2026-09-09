/** OSS 缩略参数仅适用于无 query / hash 的 aliyuncs.com 地址，其他来源不追加处理参数。 */

const OSS_PLAIN_URL = /^https?:\/\/[^/?#]*\.aliyuncs\.com\/[^?#]*$/

/** 从路径末段解码文件名，忽略 query 与 hash；data: 返回空串。 */
export const fileNameOfUrl = (url: string): string => {
  if (url.startsWith('data:')) return ''
  const path = url.split(/[?#]/, 1)[0] ?? url
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
}

/** 图片的小缩略图（长边 64）；不是 OSS 地址就原图。 */
export const imageThumbnailUrl = (url: string): string =>
  OSS_PLAIN_URL.test(url) ? `${url}?x-oss-process=image/resize,l_64` : url

/** 仅 OSS 支持视频首帧；poster 调用方需按显示尺寸指定宽度，避免放大模糊。 */
export const videoSnapshotUrl = (url: string, width = 128): string | undefined =>
  OSS_PLAIN_URL.test(url)
    ? `${url}?x-oss-process=video/snapshot,t_0,f_jpg,w_${width},h_0,m_fast`
    : undefined
