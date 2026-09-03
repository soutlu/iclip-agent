const pad = (value: number) => String(value).padStart(2, '0')

/**
 * 把 ISO 时刻渲染成本地时区的 `YYYY-MM-DD HH:mm`。
 *
 * 生成记录是一串同一天里挨着发出的任务，「3 分钟前」这种粗粒度分不出先后，所以这里给绝对时刻。
 *
 * @param iso - ISO 8601 时刻。
 * @returns 格式化后的时刻；解析不出来时是空串。
 */
export const formatDateTime = (iso: string): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}
