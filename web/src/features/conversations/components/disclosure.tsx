/**
 * 会话页三处折叠（思考块、工具行、活动组）共用的开合两件套。
 *
 * 高度过渡走 grid-rows 0fr→1fr（照 kimi 网页版），不是 max-height：内容多高都能平滑到位，
 * 不用猜一个够大的上限。外层 `grid` 与内层 `min-h-0 overflow-hidden` 少一个都会让内容在
 * 收起状态下溢出来。
 */

import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

/**
 * 折叠区的内容。收起时高度为 0，展开时长到自然高度。
 *
 * @param props - 组件属性。
 * @param props.open - 是否展开。
 * @param props.children - 折叠区内容。
 * @returns 折叠区。
 */
export function DisclosureBody({ children, open }: { children: ReactNode; open: boolean }) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-(--dur-s) ease-(--ease)',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

/**
 * 折叠区标题行末尾那个箭头：展开时转 180°。颜色与是否 shrink-0 由调用方给。
 *
 * @param props - 组件属性。
 * @param props.open - 是否展开。
 * @param props.className - 附加类名。
 * @returns 箭头图标。
 */
export function DisclosureChevron({ className, open }: { className?: string; open: boolean }) {
  return (
    <Icon
      className={cn('transition-transform duration-(--dur-s)', open && 'rotate-180', className)}
      decorative
      name="expand"
      size="sm"
    />
  )
}
