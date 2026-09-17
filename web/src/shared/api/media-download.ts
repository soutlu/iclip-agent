/** 外链素材另存为本地文件：取回字节再交给浏览器，避免点击跳转到对象存储地址。
 *
 * 地址跨域，成败由对象存储的 CORS 决定；失败统一提示，不静默。 */

import { useRef, useState } from 'react'
import { fileNameOfUrl } from '@/shared/lib/media-url'
import { toast } from '@/shared/ui/toast'

const saveAs = async (url: string, fallbackName: string) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  const blob = await response.blob()
  if (blob.size === 0) throw new Error('Empty download')
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  try {
    anchor.href = objectUrl
    anchor.download = fileNameOfUrl(url) || fallbackName
    document.body.append(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    // 给浏览器接管下载留出时间，再释放大文件的临时 URL。
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
  }
}

/** 下载中不接第二次点击；多份地址（如原片与水印版）共用同一个忙碌态。 */
export const useMediaDownload = () => {
  const activeRef = useRef(false)
  const [downloading, setDownloading] = useState(false)

  const download = async (url: string, fallbackName: string) => {
    if (activeRef.current) return
    activeRef.current = true
    setDownloading(true)
    try {
      await saveAs(url, fallbackName)
    } catch {
      toast.error('视频下载失败，请重试')
    } finally {
      activeRef.current = false
      setDownloading(false)
    }
  }

  return { downloading, download }
}
