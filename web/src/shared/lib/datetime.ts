/**
 * 将时间输入格式化为 `yyyy-mm-dd hh:mm` 文案。
 *
 * @param input - Date、ISO 字符串或 epoch 秒（number 一律按秒解释）。
 * @returns 格式化文案；无法解析时返回 '—'。
 */
export function formatDateTime(input: Date | string | number): string {
  const date =
    input instanceof Date ? input : new Date(typeof input === 'number' ? input * 1000 : input)

  if (Number.isNaN(date.getTime())) {
    return '—'
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')

  return `${year}-${month}-${day} ${hours}:${minutes}`
}
