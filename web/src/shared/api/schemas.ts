/**
 * 后端 wire 响应的通用 zod schema 构件。
 *
 * 与 apiFetch 配套使用：这里只提供跨接口复用的字段级校验原语，
 * 各端点的响应结构 schema 归属对应 API 模块。
 */

import { z } from 'zod'
import { isRecord } from '@/shared/lib/guards'

/**
 * 必填非空字符串字段。
 *
 * @param message - 缺失、非字符串或空白串时抛出的统一文案。
 * @returns 校验后的原始字符串（不做 trim 变换）。
 */
export const requiredStringSchema = (message: string) =>
  z.string({ error: message }).refine((value) => value.trim().length > 0, message)

/** 可选字符串字段：非空字符串保留原值，缺失/空串/非字符串容错归一为 null。 */
// zod v4 中 z.unknown().transform(...) 字段不允许键缺失，必须先 .optional() 再进 transform。
export const optionalStringSchema = z
  .unknown()
  .optional()
  .transform((value) => (typeof value === 'string' && value.trim().length > 0 ? value : null))

/**
 * 普通对象（非数组）字段，保持 Record<string, unknown> 原样透传。
 *
 * @param message - 值不是普通对象时抛出的文案。
 * @returns 透传原对象的 schema。
 */
export const wireRecordSchema = (message: string) =>
  z.custom<Record<string, unknown>>(isRecord, message)
