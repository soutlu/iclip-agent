import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/** 将自定义 text-* 字阶登记到 font-size 组，避免 tailwind-merge 与文字颜色互斥；新增字阶须同步登记。 */
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

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
