import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import PopupContent from '@/shared/ui/popup/PopupContent'

const SETTINGS_CHOICE_COLUMNS = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
} as const

type SettingsPopupContentProps = Omit<
  ComponentProps<typeof PopupContent>,
  'children' | 'className'
> & {
  children: ReactNode
  className?: string
}

export type SettingsChoiceOption<TValue extends string = string> = {
  label: string
  value: TValue
}

/**
 * 视频创作设置统一使用的浮层外壳。
 *
 * 保持生成设置面板的尺寸、圆角、层级与留白，业务入口只负责传入内部内容。
 */
export function SettingsPopupContent({
  children,
  className = '',
  ...popupProps
}: SettingsPopupContentProps) {
  return (
    <PopupContent
      className={cn(
        'w-[min(calc(100vw-24px),492px)] overflow-hidden rounded-md border-outline-variant bg-popup-bg p-4 shadow-[var(--shadow-3)]',
        className,
      )}
      {...popupProps}
    >
      <div className="flex flex-col gap-[18px] text-left text-on-background">{children}</div>
    </PopupContent>
  )
}

/**
 * 与视频画幅设置一致的分段选择组。
 */
export function SettingsChoiceGroup<TValue extends string>({
  columns = 2,
  label,
  onValueChange,
  options,
  value,
}: {
  columns?: keyof typeof SETTINGS_CHOICE_COLUMNS
  label: string
  onValueChange: (value: TValue) => void
  options: readonly SettingsChoiceOption<TValue>[]
  value: TValue
}) {
  return (
    <div
      aria-label={label}
      className={cn(
        'grid gap-1.5 rounded-xl bg-[color-mix(in_srgb,var(--color-on-surface-variant)_11%,transparent)] p-1.5',
        SETTINGS_CHOICE_COLUMNS[columns],
      )}
      role="listbox"
    >
      {options.map((option) => {
        const selected = option.value === value

        return (
          <button
            aria-selected={selected}
            className={cn(
              'flex min-h-14 min-w-0 items-center justify-center rounded-lg px-3 text-center text-body-sm font-semibold transition-all ui-motion-s',
              selected
                ? 'bg-top-layer text-on-background shadow-[var(--shadow-1)]'
                : 'text-on-surface-variant hover:bg-hover active:scale-[0.98]',
            )}
            key={option.value}
            role="option"
            type="button"
            onClick={() => onValueChange(option.value)}
          >
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
