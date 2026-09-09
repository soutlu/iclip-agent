/**
 * 铸一个 v4 UUID。
 *
 * `crypto.randomUUID` 只在安全上下文（HTTPS、localhost）里存在，用公网 IP 走 HTTP 访问时是
 * undefined；`crypto.getRandomValues` 在任何上下文都有，按 RFC 4122 拼出同样格式。
 */
export const mintUuid = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  // 第 7 字节高四位写版本号 4，第 9 字节高两位写变体 10。
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
