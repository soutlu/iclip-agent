import type { Element, Properties, Root } from 'hast'
import type { Plugin } from 'unified'
import { visit } from 'unist-util-visit'

const NUMERIC_LENGTH_PATTERN = /^\d+(?:\.\d+)?$/

/**
 * 判断 HAST 元素是否为 SVG 节点。
 *
 * @param node - 当前遍历到的 HAST 元素。
 * @returns 元素标签名为 svg 时返回 true。
 */
const isSvgElement = (node: Element): boolean => {
  return node.tagName === 'svg'
}

/**
 * 将 HAST 属性值转换为字符串。
 *
 * @param value - HAST 属性中的原始值。
 * @returns 可写入 SVG 属性或 CSS 的字符串；无值返回 null。
 */
const stringifyPropertyValue = (value: Properties[string]): string | null => {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value)
  }

  return null
}

/**
 * 判断 SVG 长度是否为纯数字。
 *
 * @param value - 需要检查的 SVG 长度。
 * @returns 长度是纯数字字符串时返回 true。
 */
const isNumericLength = (value: string | null): value is string => {
  return value !== null && NUMERIC_LENGTH_PATTERN.test(value)
}

/**
 * 将 SVG width 属性转换为 CSS max-width 值。
 *
 * @param width - SVG width 属性值。
 * @returns 可用于 CSS max-width 的长度值。
 */
const createMaxWidthValue = (width: string): string => {
  if (isNumericLength(width)) {
    return `${width}px`
  }

  return width
}

/**
 * 在既有 style 字符串末尾追加一条样式声明。
 *
 * @param currentStyle - 当前 SVG style 属性。
 * @param declaration - 需要追加的 CSS 声明。
 * @returns 合并后的 style 字符串。
 */
const appendStyleDeclaration = (currentStyle: string | null, declaration: string): string => {
  if (currentStyle === null || currentStyle.trim().length === 0) {
    return declaration
  }

  return `${currentStyle.trim().replace(/;?$/, ';')} ${declaration}`
}

/**
 * 让内联 SVG 默认具备可缩放尺寸。
 *
 * @returns 遍历 HAST 并调整 SVG width、height、viewBox 的 rehype 插件。
 */
export const rehypeScalableSvg: Plugin<[], Root> = () => {
  /**
   * 遍历 HAST 根节点，修正 SVG 尺寸属性。
   *
   * @param tree - 当前 Markdown 转换后的 HAST 根节点。
   */
  return function scaleInlineSvg(tree: Root) {
    visit(tree, 'element', (node) => {
      if (!isSvgElement(node)) {
        return
      }

      const width = stringifyPropertyValue(node.properties.width)
      const height = stringifyPropertyValue(node.properties.height)
      const viewBox = stringifyPropertyValue(node.properties.viewBox ?? node.properties.viewbox)

      if (width !== null) {
        const currentStyle = stringifyPropertyValue(node.properties.style)
        node.properties.style = appendStyleDeclaration(
          currentStyle,
          `width: 100%; max-width: ${createMaxWidthValue(width)};`,
        )
      }

      if (viewBox !== null && viewBox.length > 0) {
        return
      }

      if (isNumericLength(width) && isNumericLength(height)) {
        node.properties.viewBox = `0 0 ${width} ${height}`
        node.properties.width = '100%'
        delete node.properties.height
        return
      }

      node.properties['data-needs-measurement'] = 'true'
    })
  }
}
