/** 把 ISO 时刻渲染成「3天前」这种粗粒度相对时间；未来时刻按「刚刚」处理。 */
export const formatRelativeTime = (iso: string): string => {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''

  const minutes = Math.floor((Date.now() - then) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`

  const days = Math.floor(hours / 24)
  if (days < 365) return `${days}天前`

  return `${Math.floor(days / 365)}年前`
}
