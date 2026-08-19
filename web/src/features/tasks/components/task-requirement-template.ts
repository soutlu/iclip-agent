import type { JSONContent } from '@tiptap/core'

/** 需求描述模板行：只预置 `标题：` 前缀，冒号后为灰字示例占位。 */
export type TaskRequirementSection = {
  /** 灰字示例占位：介绍该行填什么，落笔输入即消失。 */
  hint: string
  /** 中文行标题。 */
  title: string
}

export const TASK_REQUIREMENT_SECTIONS: readonly TaskRequirementSection[] = [
  { hint: 'similar to reference with city street', title: '场景' },
  { hint: 'same as reference', title: '服装' },
  { hint: 'same as reference', title: '道具' },
  { hint: 'Same as reference', title: '灯光' },
  { hint: 'Same as reference', title: '动作姿势' },
  { hint: 'Caucasian', title: '人物族裔' },
  { hint: 'Same as reference, no on-screen text', title: '制作备注' },
]

/**
 * 按行首「标题:」匹配对应模板行（大小写不敏感）。
 *
 * @param lineText - 编辑器中一行的纯文本。
 * @returns 命中的模板行；未命中返回 undefined。
 */
export const matchRequirementSection = (lineText: string): TaskRequirementSection | undefined => {
  const normalized = lineText.trimStart()
  return TASK_REQUIREMENT_SECTIONS.find((section) =>
    [`${section.title}：`, `${section.title}:`].some((prefix) => normalized.startsWith(prefix)),
  )
}

/**
 * 判断一行是否只有「标题:」前缀、尚未填写内容。
 *
 * @param lineText - 编辑器中一行的纯文本。
 * @param section - 该行命中的模板行。
 * @returns 冒号后为空返回 true。
 */
export const isRequirementLineEmpty = (
  lineText: string,
  section: TaskRequirementSection,
): boolean =>
  lineText
    .trimStart()
    .slice(section.title.length + 1)
    .trim() === ''

/** @returns 下发 Task 使用的七项中文纯文本模板。 */
export const createTaskRequirementText = (): string =>
  TASK_REQUIREMENT_SECTIONS.map((section) => `${section.title}：`).join('\n')

/** @returns 用户完全未填写需求描述时保存的七项默认内容。 */
export const createDefaultTaskRequirementText = (): string =>
  TASK_REQUIREMENT_SECTIONS.map((section) => `${section.title}：${section.hint}`).join('\n')

/**
 * 把未填写的空模板物化为默认内容；用户只要填过内容就原样保存。
 *
 * @param value - 编辑器当前纯文本。
 * @returns 可写入 Task Brief 的需求描述。
 */
export const resolveTaskRequirementText = (value: string): string => {
  const normalized = value.trim()
  return normalized && normalized !== createTaskRequirementText()
    ? normalized
    : createDefaultTaskRequirementText()
}

/**
 * 生成需求描述编辑器文档：下发时使用中文模板，确认时按现有纯文本逐行恢复。
 *
 * @param initialText - 已保存的纯文本；未传时生成下发模板。
 * @returns 可直接交给 Tiptap 的初始 JSON 文档。
 */
export const createTaskRequirementContent = (initialText?: string): JSONContent => {
  const lines =
    initialText === undefined ? createTaskRequirementText().split('\n') : initialText.split(/\r?\n/)

  return {
    type: 'doc',
    content: (lines.length > 0 ? lines : ['']).map((line) => ({
      ...(line ? { content: [{ text: line, type: 'text' }] } : {}),
      type: 'paragraph',
    })),
  }
}
