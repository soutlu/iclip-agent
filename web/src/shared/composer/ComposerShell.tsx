import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

interface ComposerShellProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  dropHint?: string
  isDropActive?: boolean
}

/**
 * 渲染共享输入框外框和拖拽提示层。
 *
 * @param props - 外框属性、视觉提示和 slot 内容。
 * @returns 不持有业务状态的 composer frame。
 */
export default function ComposerShell({
  children,
  className = '',
  dropHint = '拖拽文件到这里以上传',
  isDropActive = false,
  ...props
}: ComposerShellProps) {
  const mergedClassName = cn('composer-shell', 'glass-panel', 'relative', className)

  return (
    <div className={mergedClassName} {...props}>
      {children}
      {isDropActive ? (
        <div className="layer-panel pointer-events-none absolute inset-0 flex items-center justify-center rounded-[inherit] border border-dashed border-[var(--color-on-background)] bg-[color:color-mix(in_srgb,var(--color-scrim)_8%,transparent)] p-4 backdrop-blur-[1px]">
          <span className="rounded-full border border-[var(--color-border)] bg-[color:color-mix(in_srgb,var(--color-surface-container-lowest)_86%,transparent)] px-4 py-2 text-body font-medium text-[var(--color-on-background)] shadow-[var(--shadow-2)]">
            {dropHint}
          </span>
        </div>
      ) : null}
    </div>
  )
}
