/**
 * 媒体地址上的几件小事：取文件名、给 OSS 地址挂缩略参数。
 *
 * 处理参数只挂得上 OSS 自家域名，而且地址上不能已经有 query——再拼一个参数上去只会得到一个
 * 废地址。其他来源的地址给不出缩略图。
 */

const OSS_PLAIN_URL = /^https?:\/\/[^/?#]*\.aliyuncs\.com\/[^?#]*$/

/** 地址最后一段当文件名：去掉 query 与 hash，解开百分号编码。data: 地址没有文件名，给空串。 */
export const fileNameOfUrl = (url: string): string => {
  if (url.startsWith('data:')) return ''
  const path = url.split(/[?#]/, 1)[0] ?? url
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
}

/** 图片的小缩略图（长边 64）；不是 OSS 地址就原图。 */
export const imageThumbnailUrl = (url: string): string =>
  OSS_PLAIN_URL.test(url) ? `${url}?x-oss-process=image/resize,l_64` : url

/** 视频首帧的小截图（宽 128，高按比例）；不是 OSS 地址就没有。 */
export const videoSnapshotUrl = (url: string): string | undefined =>
  OSS_PLAIN_URL.test(url)
    ? `${url}?x-oss-process=video/snapshot,t_0,f_jpg,w_128,h_0,m_fast`
    : undefined
