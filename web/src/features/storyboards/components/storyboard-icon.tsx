import { useId, type SVGProps } from 'react'
import storyboardIconSpriteUrl from '@/features/storyboards/assets/storyboard-icons.svg?url'

export type StoryboardIconName =
  | 'annotation-arrow'
  | 'annotation-pen'
  | 'annotation-point'
  | 'annotation-rect'
  | 'brand'
  | 'check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'close'
  | 'compass'
  | 'compare-handle'
  | 'compare-split'
  | 'model-flux'
  | 'model-gpt-image'
  | 'model-midjourney'
  | 'model-nano-banana'
  | 'model-seedream'
  | 'plus'
  | 'reference-add'
  | 'reference-close'
  | 'redo'
  | 'trash'
  | 'undo'
  | 'width-medium'
  | 'width-thick'
  | 'width-thin'

export type StoryboardIconProps = Omit<
  SVGProps<SVGSVGElement>,
  'children' | 'height' | 'viewBox' | 'width'
> & {
  name: StoryboardIconName
  size?: number | string
  title: string
}

/**
 * 从 Storyboards feature sprite 渲染一个受控 UI 图标。
 *
 * @param props - 图标名称、标题、尺寸与标准 SVG 属性。
 * @returns 使用构建期同源 sprite 的 SVG 图标。
 */
export default function StoryboardIcon({
  'aria-hidden': ariaHidden = true,
  'aria-labelledby': ariaLabelledBy,
  className,
  focusable = false,
  name,
  role,
  size = 24,
  title,
  ...svgProps
}: StoryboardIconProps) {
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
      <use href={`${storyboardIconSpriteUrl}#${name}`} />
    </svg>
  )
}
