import type { Element, Root, RootContent } from 'hast'
import type { Plugin } from 'unified'
import { visit } from 'unist-util-visit'

interface RehypeHeadingIdsOptions {
  prefix: string
}

const HEADING_TAG_NAMES = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const ZERO_WIDTH_CHARACTERS_PATTERN = /[\u200B-\u200D\uFEFF]/g
const HEADING_PUNCTUATION_PATTERN = /["'`(){}[\]:;!?.,]/g
const SLUG_SEPARATOR_PATTERN = /[^a-z0-9\u3400-\u9fff\uf900-\ufaff]+/g
const EDGE_SEPARATOR_PATTERN = /^-+|-+$/g

/**
 * 判断 HAST 节点是否为标题元素。
 *
 * @param node - 需要检查的 HAST 节点。
 * @returns 节点是 h1 到 h6 时返回 true。
 */
const isHeadingElement = (node: RootContent): node is Element => {
  return node.type === 'element' && HEADING_TAG_NAMES.has(node.tagName)
}

/**
 * 递归提取标题节点中的纯文本。
 *
 * @param node - 标题子节点或标题元素。
 * @returns 拼接后的标题文本。
 */
const getHeadingText = (node: Element | RootContent): string => {
  if (node.type === 'text') {
    return node.value
  }

  if ('children' in node) {
    return node.children.map((child) => getHeadingText(child)).join('')
  }

  return ''
}

/**
 * 将标题文本转换为稳定 slug。
 *
 * @param value - 原始标题文本或 identity 前缀。
 * @returns 可用于 DOM id 的 slug；空值返回 section。
 */
const normalizeHeadingSlug = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replaceAll(ZERO_WIDTH_CHARACTERS_PATTERN, '')
    .replaceAll(HEADING_PUNCTUATION_PATTERN, '')
    .replaceAll(SLUG_SEPARATOR_PATTERN, '-')
    .replaceAll(EDGE_SEPARATOR_PATTERN, '')

  return slug || 'section'
}

/**
 * 创建带重复序号的标题 slug。
 *
 * @param slug - 当前标题的基础 slug。
 * @param slugCounts - 当前 Markdown 内已经使用过的 slug 计数。
 * @returns 当前标题唯一的 slug。
 */
const createUniqueHeadingSlug = (slug: string, slugCounts: Map<string, number>): string => {
  const currentCount = slugCounts.get(slug) ?? 0
  slugCounts.set(slug, currentCount + 1)

  if (currentCount === 0) {
    return slug
  }

  return `${slug}-${currentCount}`
}

/**
 * 为 Markdown 标题补充稳定 DOM id。
 *
 * @param options - 标题 id 生成配置。
 * @param options.prefix - 当前 Markdown 渲染实例的稳定前缀。
 * @returns 遍历 HAST 并写入标题 id 的 rehype 插件。
 */
export const rehypeHeadingIds: Plugin<[RehypeHeadingIdsOptions], Root> = (options) => {
  /**
   * 遍历 HAST 根节点，为缺少 id 的标题节点写入稳定 id。
   *
   * @param tree - 当前 Markdown 转换后的 HAST 根节点。
   */
  return function addHeadingIds(tree: Root) {
    const normalizedPrefix = normalizeHeadingSlug(options.prefix)
    const slugCounts = new Map<string, number>()

    visit(tree, 'element', (node) => {
      if (!isHeadingElement(node)) {
        return
      }

      if (typeof node.properties.id === 'string' && node.properties.id.length > 0) {
        return
      }

      const baseSlug = normalizeHeadingSlug(getHeadingText(node))
      const uniqueSlug = createUniqueHeadingSlug(baseSlug, slugCounts)
      node.properties.id = `${normalizedPrefix}--${uniqueSlug}`
    })
  }
}
