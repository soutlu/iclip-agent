import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * globals.css 里自定义的字阶 utilities（text-*）。
 *
 * 字阶类和颜色类都长成 text-xxx，tailwind-merge 默认把它们归到同一组，
 * 于是 cn('text-body text-on-surface') 会静默丢掉一个。把字阶名字单列出来登记成
 * font-size 组，两者才各归各组；剩下的 text-* 仍按文字颜色处理（颜色之间照常互斥）。
 * 新增字阶时这里补一行——近似名要看清：text-canvas-label 是字阶，text-canvas-label-text 是颜色。
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
