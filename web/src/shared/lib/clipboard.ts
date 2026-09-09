/**
 * 把文字写进剪贴板；失败时抛错，由调用方决定怎么提示。
 *
 * `navigator.clipboard` 只在安全上下文（HTTPS、localhost）里存在，HTTP 下退回
 * 「选中隐藏文本框再 execCommand('copy')」这条老路。
 */
export const copyText = async (text: string): Promise<void> => {
  if (navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(text)
    return
  }
  const holder = document.createElement('textarea')
  holder.value = text
  holder.setAttribute('readonly', '')
  holder.style.position = 'fixed'
  holder.style.opacity = '0'
  document.body.append(holder)
  holder.select()
  try {
    if (!document.execCommand('copy')) throw new Error('浏览器拒绝了复制')
  } finally {
    holder.remove()
  }
}
