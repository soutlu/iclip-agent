import type { SVGProps } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ExtraProps } from 'react-markdown'
import { cn } from '@/shared/lib/utils'

type RichMarkdownSvgProps = SVGProps<SVGSVGElement> &
  ExtraProps & {
    'data-needs-measurement'?: boolean | string
  }

interface MeasuredSvgAttributes {
  height?: string
  viewBox?: string
  width?: string
}

/**
 * 判断 SVG 是否需要在浏览器中测量尺寸。
 *
 * @param value - rehype 插件写入的测量标记。
 * @returns 标记存在且不是 false 时返回 true。
 */
const needsMeasurement = (value: boolean | string | undefined): boolean => {
  return value === true || value === 'true'
}

/**
 * 读取 SVG bbox 并生成可缩放属性。
 *
 * @param svg - 已挂载的 SVG 元素。
 * @returns 可补充到 SVG 上的尺寸属性；无法测量时返回 null。
 */
const measureSvgAttributes = (svg: SVGSVGElement): MeasuredSvgAttributes | null => {
  if (typeof svg.getBBox !== 'function') {
    return null
  }

  const box = svg.getBBox()

  if (box.width <= 0 || box.height <= 0) {
    return null
  }

  return {
    height: undefined,
    viewBox: `${box.x} ${box.y} ${box.width} ${box.height}`,
    width: '100%',
  }
}

/**
 * 合并 SVG className。
 *
 * @param className - 模型输出或 ReactMarkdown 传入的 className。
 * @returns 包含 rich-markdown-svg 的 className。
 */
const createSvgClassName = (className: string | undefined): string => {
  return cn('rich-markdown-svg', className)
}

/**
 * 渲染可缩放的 rich markdown 内联 SVG。
 *
 * @param props - ReactMarkdown 传入的 SVG 属性。
 * @returns 保留原始结构并限制尺寸的 SVG 元素。
 */
export default function RichMarkdownSvg({
  className,
  node: _node,
  'data-needs-measurement': dataNeedsMeasurement,
  ...svgProps
}: RichMarkdownSvgProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [measuredAttributes, setMeasuredAttributes] = useState<MeasuredSvgAttributes | null>(null)

  useEffect(() => {
    if (
      !needsMeasurement(dataNeedsMeasurement) ||
      measuredAttributes !== null ||
      svgRef.current === null
    ) {
      return
    }

    setMeasuredAttributes(measureSvgAttributes(svgRef.current))
  }, [dataNeedsMeasurement, measuredAttributes])

  return (
    <svg
      {...svgProps}
      {...measuredAttributes}
      className={createSvgClassName(className)}
      data-needs-measurement={dataNeedsMeasurement}
      ref={svgRef}
    />
  )
}
