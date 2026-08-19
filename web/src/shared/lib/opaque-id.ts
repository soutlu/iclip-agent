/**
 * 创建不承载业务语义的 UUID v4 字符串。
 *
 * http（非安全上下文）访问时 `crypto.randomUUID` 不可用，退回 `getRandomValues` 手动构造。
 */
export const createOpaqueUuid = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('当前环境不支持生成安全随机 id。')
  }

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  // 16 字节定长数组，下标 6/8 恒有值。
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 创建适合拼接到业务前缀后的短随机后缀。
 *
 * @param length - 需要保留的 UUID 字符数量。
 * @returns 从 opaque UUID 中截取出的短随机后缀。
 */
export const createOpaqueIdSuffix = (length: number) =>
  createOpaqueUuid().replaceAll('-', '').slice(0, length)
