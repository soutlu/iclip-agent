import type { JSONContent } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { isRecord } from '@/shared/lib/guards'

// ProseMirror JSON 节点/mark 允许出现的键全集（Node.toJSON 的输出词汇表）。
const NODE_JSON_KEYS = new Set(['type', 'attrs', 'content', 'marks', 'text'])
const MARK_JSON_KEYS = new Set(['type', 'attrs'])

/**
 * 判断 Tiptap JSON 是否包含用户输入的非空白文字。
 *
 * @param content - 当前文档或子节点。
 * @returns 存在非空白 text node 时返回 true；Mention 不计为文字说明。
 */
export const hasEditorText = (content: JSONContent): boolean => {
  if (content.type === 'text' && typeof content.text === 'string') {
    return content.text.trim().length > 0
  }

  return content.content?.some(hasEditorText) ?? false
}

/**
 * 校验 attrs 记录只携带 schema 为该类型声明过的属性名。
 *
 * @param attrs - JSON 节点或 mark 的 attrs 值。
 * @param declaredAttrs - schema spec 中声明的属性表。
 * @param documentLabel - 用于错误消息的文档名称。
 * @throws 当出现未声明属性键时抛出错误。
 */
const assertDeclaredAttrs = (
  attrs: unknown,
  declaredAttrs: Record<string, unknown>,
  documentLabel: string,
): void => {
  if (attrs === undefined) return
  if (!isRecord(attrs)) throw new Error(`${documentLabel}格式无效。`)

  for (const key of Object.keys(attrs)) {
    if (!Object.hasOwn(declaredAttrs, key)) {
      throw new Error(`${documentLabel}包含不受支持的节点属性。`)
    }
  }
}

/**
 * 递归校验 JSON 节点树没有 ProseMirror 会静默丢弃的键。
 *
 * ProseMirror 的 JSON 反序列化只拷贝已声明属性、忽略未知键（`computeAttrs`
 * 的已知盲区），`check()` 因此永远看不到它们——这里显式补上这一层，未知的
 * 节点键、mark 键与未声明 attr 一律拒绝，而不是静默归一化后丢失。
 *
 * @param value - 待校验的 JSON 节点。
 * @param schema - 当前输入框唯一允许的 ProseMirror schema。
 * @param documentLabel - 用于错误消息的文档名称。
 * @throws 当出现未知键或未声明属性时抛出错误。
 */
const assertSupportedNodeJson = (value: unknown, schema: Schema, documentLabel: string): void => {
  if (!isRecord(value)) throw new Error(`${documentLabel}格式无效。`)

  for (const key of Object.keys(value)) {
    if (!NODE_JSON_KEYS.has(key)) {
      throw new Error(`${documentLabel}包含不受支持的节点属性。`)
    }
  }

  const nodeType = typeof value.type === 'string' ? schema.nodes[value.type] : undefined
  assertDeclaredAttrs(value.attrs, nodeType?.spec.attrs ?? {}, documentLabel)

  if (value.marks !== undefined) {
    if (!Array.isArray(value.marks)) throw new Error(`${documentLabel}格式无效。`)
    for (const mark of value.marks) {
      if (!isRecord(mark)) throw new Error(`${documentLabel}格式无效。`)
      for (const key of Object.keys(mark)) {
        if (!MARK_JSON_KEYS.has(key)) {
          throw new Error(`${documentLabel}包含不受支持的节点属性。`)
        }
      }
      const markType = typeof mark.type === 'string' ? schema.marks[mark.type] : undefined
      assertDeclaredAttrs(mark.attrs, markType?.spec.attrs ?? {}, documentLabel)
    }
  }

  if (value.content !== undefined) {
    if (!Array.isArray(value.content)) throw new Error(`${documentLabel}格式无效。`)
    for (const child of value.content) {
      assertSupportedNodeJson(child, schema, documentLabel)
    }
  }
}

/**
 * 用指定 schema 严格解析 Tiptap JSON，并拒绝 ProseMirror 会静默丢弃的未知属性。
 *
 * 结构与属性合法性交给 `nodeFromJSON` + `check()`（未知节点类型、非法内容
 * 模型、attr validate 失败都会抛错）；未知键由白名单遍历显式拒绝。带默认值
 * 的缺省 attr 在返回值中被归一化补全，不视为非法输入。
 *
 * @param value - 待校验的未知文档值。
 * @param schema - 当前输入框唯一允许的 ProseMirror schema。
 * @param documentLabel - 用于错误消息的文档名称。
 * @returns 经过 schema 校验并归一化的 Tiptap JSON。
 * @throws 当根值、节点结构或节点属性不符合当前合同时抛出错误。
 */
export const parseStrictEditorDocument = (
  value: unknown,
  schema: Schema,
  documentLabel: string,
): JSONContent => {
  if (!isRecord(value)) throw new Error(`${documentLabel}格式无效。`)

  const node = schema.nodeFromJSON(value)
  node.check()
  assertSupportedNodeJson(value, schema, documentLabel)

  return node.toJSON() as JSONContent
}
