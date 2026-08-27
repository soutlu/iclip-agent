/**
 * 判断值是否为非 null 的普通对象（排除数组）。
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
