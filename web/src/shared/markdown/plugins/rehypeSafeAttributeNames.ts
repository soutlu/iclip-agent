import type { Element, Root } from 'hast'
import type { Plugin } from 'unified'
import { visit } from 'unist-util-visit'

const SAFE_REACT_ATTRIBUTE_NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/

/**
 * 判断 HAST 属性名是否能安全传给 React DOM。
 *
 * @param name - rehype-raw 从原始 HTML 中解析出的属性名。
 * @returns 属性名符合 React DOM 可接受格式时返回 true。
 */
const isSafeReactAttributeName = (name: string): boolean =>
  SAFE_REACT_ATTRIBUTE_NAME_PATTERN.test(name)

/**
 * 删除元素上 React 无法接受的属性名。
 *
 * @param node - 当前 HAST 元素节点。
 */
const removeUnsafeAttributeNames = (node: Element) => {
  for (const propertyName of Object.keys(node.properties)) {
    if (isSafeReactAttributeName(propertyName)) {
      continue
    }

    delete node.properties[propertyName]
  }
}

/**
 * 清理 raw HTML 中因模型输出坏引号产生的非法属性名。
 *
 * @returns 遍历 HAST 并删除非法属性名的 rehype 插件。
 */
export const rehypeSafeAttributeNames: Plugin<[], Root> = () => {
  /**
   * 遍历 HAST 根节点，清理所有元素属性名。
   *
   * @param tree - 当前 Markdown 转换后的 HAST 根节点。
   */
  return function sanitizeUnsafeAttributeNames(tree: Root) {
    visit(tree, 'element', removeUnsafeAttributeNames)
  }
}
