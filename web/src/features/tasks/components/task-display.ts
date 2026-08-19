import type { KeyboardEvent } from 'react'

/** 旧数据存的是英文枚举值，映射回展示文案；新数据直接存展示值。 */
const LEGACY_VALUE_LABELS: Record<string, string> = {
  'brand-film': '品牌片',
  brand: '品牌部',
  ecommerce: '电商部',
  instagram: 'Instagram',
  marketing: '市场部',
  'product-film': '产品片',
  sales: '销售部',
  'short-video': '短视频',
  tiktok: 'TikTok',
  tvc: 'TVC',
  unboxing: '开箱测评',
  youtube: 'YouTube',
}

/**
 * 把 brief 展示值翻译为用户文案（兼容旧枚举值）。
 *
 * @param value - brief 字段原始值。
 * @returns 展示文案。
 */
export const briefDisplayValue = (value: string): string => LEGACY_VALUE_LABELS[value] ?? value

/**
 * 素材 URL 末段作为预览标题；中文等 percent-encoding 文件名解码后展示，
 * 取不到有意义的文件名时回退到调用方给的序号命名。
 *
 * @param url - 素材地址。
 * @param fallback - 兜底展示名。
 * @returns 预览弹层标题用的文件名。
 */
export const assetPreviewFileName = (url: string, fallback: string): string => {
  const segment = url.split(/[?#]/)[0]?.split('/').pop()
  if (!segment) {
    return fallback
  }
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * 素材预览触发器的键盘等价操作：Enter / Space 打开预览，且不冒泡触发容器行为
 * （如任务行展开）。
 *
 * @param event - 键盘事件。
 * @param openPreview - 打开预览的回调。
 */
export const handlePreviewKeyDown = (
  event: KeyboardEvent<HTMLElement>,
  openPreview: () => void,
): void => {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  openPreview()
}

/** 需求描述中的一行「标题: 内容」。 */
type RequirementLine = {
  label: string
  text: string
}

const REQUIREMENT_LINE_PATTERN = /^([^:：\n]{1,40})[:：]\s*(.*)$/u

/**
 * 把需求描述纯文本解析为「标题：内容」结构化行。
 *
 * 需求描述由编辑器预置七行 `标题：内容`；全部非空行都符合该形态时返回结构化行，
 * 供详情页做对齐排版。任一行不符合时返回 null，回退纯文本渲染。
 *
 * @param text - 按行保存的需求描述纯文本。
 * @returns 结构化行；文本不是纯行清单时为 null。
 */
export const parseRequirementLines = (text: string): null | RequirementLine[] => {
  const sourceLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (sourceLines.length === 0) {
    return null
  }

  const lines: RequirementLine[] = []
  for (const sourceLine of sourceLines) {
    const match = REQUIREMENT_LINE_PATTERN.exec(sourceLine)
    const label = match?.[1]
    if (!match || label === undefined) {
      return null
    }
    lines.push({ label: label.trim(), text: (match[2] ?? '').trim() })
  }
  return lines.length > 0 ? lines : null
}
