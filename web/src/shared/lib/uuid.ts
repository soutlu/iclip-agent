const HEX_32 = /^[0-9a-f]{32}$/

const dashed = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

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
  return dashed(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''))
}

/**
 * 把 UUID 的各种写法收成规范写法（小写、带横线），不是 UUID 就返回 `null`。
 *
 * 收的范围与后端一致：无横线的 32 位十六进制、大写、横线位置不标准的写法都指向同一个 id。
 */
export const canonicalUuid = (raw: string): string | null => {
  const hex = raw.replaceAll('-', '').toLowerCase()
  return HEX_32.test(hex) ? dashed(hex) : null
}
