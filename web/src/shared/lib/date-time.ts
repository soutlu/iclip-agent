const pad = (value: number) => String(value).padStart(2, '0')

/** 使用本地时区绝对时刻，便于区分同日生成记录；无效输入返回空串。 */
export const formatDateTime = (iso: string): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}
