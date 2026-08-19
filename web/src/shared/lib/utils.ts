import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * globals.css @theme 定义的自定义字阶 utilities（text-*）。
 * 必须注册进 tailwind-merge 的 font-size 组，否则会被当作文字颜色类，
 * 与 text-[var(--color-*)] 互斥合并时被错误丢弃。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        'text-caption',
        'text-label',
        'text-body-sm',
        'text-body',
        'text-title',
        'text-title-lg',
        'text-headline',
        'text-headline-lg',
        'text-display-sm',
        'text-display',
        'text-canvas-label',
        'text-canvas-body',
        'text-canvas-body-lg',
        'text-canvas-title-sm',
        'text-canvas-title',
        'text-canvas-title-lg',
      ],
    },
  },
})

/**
 * 合并 className：支持条件值与数组，并消解 Tailwind 类冲突。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
