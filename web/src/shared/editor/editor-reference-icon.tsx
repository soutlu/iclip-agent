import { useId, type SVGProps } from 'react'
// <use> 的片段引用必须指向真实资源 URL；Chromium 无法从 data URL 解析 symbol。
import editorReferenceIconSpriteUrl from '@/shared/editor/editor-reference-icons.svg?url&no-inline'
import type { EditorReferenceKind } from '@/shared/editor/editor-reference'

export type EditorReferenceIconProps = Omit<
  SVGProps<SVGSVGElement>,
  'children' | 'height' | 'viewBox' | 'width'
> & {
  kind: EditorReferenceKind
  size?: number | string
  title: string
}

/**
 * 从共享 SVG sprite 渲染引用类型图标。
 *
 * @param props - 引用类型、尺寸、可访问名称与标准 SVG 属性。
 * @returns 所有输入框和候选菜单复用的 SVG 图标。
 */
export function EditorReferenceIcon({
  'aria-hidden': ariaHidden = true,
  'aria-labelledby': ariaLabelledBy,
  className,
  focusable = false,
  kind,
  role,
  size = 12,
  title,
  ...svgProps
}: EditorReferenceIconProps) {
  const titleId = useId()
  const isDecorative = ariaHidden === true || ariaHidden === 'true'

  return (
    <svg
      {...svgProps}
      aria-hidden={ariaHidden}
      aria-labelledby={isDecorative ? undefined : (ariaLabelledBy ?? titleId)}
      className={className}
      focusable={focusable}
      height={size}
      role={isDecorative ? undefined : (role ?? 'img')}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title id={titleId}>{title}</title>
      <use href={`${editorReferenceIconSpriteUrl}#reference-${kind}`} />
    </svg>
  )
}
