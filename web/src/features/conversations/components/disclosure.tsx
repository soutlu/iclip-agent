/** 参考 Kimi 折叠过渡：外层 grid-rows 0fr→1fr 配合内层 min-h-0 overflow-hidden，避免收起时溢出。 */

import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

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
