/**
 * 判断值是否为非 null 的普通对象（排除数组）。
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 归一化字符串输入：返回 trim 后的非空字符串，否则返回 undefined。
 */
export const nonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

/**
 * 将 unknown 错误归一化为 Error 实例。
 */
export const errorFromUnknown = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error))
