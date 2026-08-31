/**
 * 输入卡：32 大圆角卡，上输入行、下工具行。
 *
 * 形状对齐 kimi Code Web 的 composer：hover 边框加深，focus-within 边框再加深并抬升到
 * shadow-2（无焦点环，焦点指示由卡边框与阴影承担）；textarea 随内容增高，Enter 发送、
 * Shift+Enter 换行。深色下卡面用 top-layer（比主区亮一档；浅色都是白）。
 *
 * 工具行里放什么由调用方给：首页要 agent 选择与合集条，会话页只要发送。
 */

import type { ReactNode } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

type ComposerProps = {
  value: string
  onValueChange: (value: string) => void
  /** 按回车或点发送时调用。输入是空白时不会触发。 */
  onSubmit: () => void
  placeholder?: string
  /** 工具行左侧那几个控件。 */
  leading?: ReactNode
  /** 发送钮左边那几个控件。 */
  trailing?: ReactNode
  /** 正在提交这一条：发送钮转圈并禁用。 */
  sending?: boolean
  /**
   * 这段对话正在跑：发送钮换成停止钮。
   *
   * 换的是钮而不是禁用态——输入框空着时发送本来就是禁用的，那样就没法停了。
   */
  busy?: boolean
  onStop?: (() => void) | undefined
  className?: string
}

/**
 * 渲染输入卡。
 *
 * @param props - 组件属性。
 * @param props.value - 当前输入。
 * @param props.onValueChange - 输入变化。
 * @param props.onSubmit - 提交。
 * @param props.placeholder - 占位文案。
 * @param props.leading - 工具行左侧控件。
 * @param props.trailing - 发送钮左边的控件。
 * @param props.sending - 是否正在提交。
 * @param props.busy - 这段对话是否正在跑。
 * @param props.onStop - 点停止。
 * @param props.className - 外层附加类名。
 * @returns 输入卡。
 */
export function Composer({
  busy = false,
  className,
  leading,
  onStop,
  onSubmit,
  onValueChange,
  placeholder = '输入消息，开始创作…',
  sending = false,
  trailing,
  value,
}: ComposerProps) {
  const canSend = value.trim().length > 0 && !sending

  return (
    <div
      className={cn(
        'relative rounded-3xl border border-border bg-top-layer shadow-[var(--shadow-1)]',
        'transition-[border-color,box-shadow] ui-motion-s',
        'focus-within:border-border-hover focus-within:shadow-[var(--shadow-2)] hover:border-border-hover/60',
        className,
      )}
    >
      <textarea
        aria-label="输入消息"
        className={cn(
          'composer-textarea field-sizing-content max-h-48 min-h-[76px] w-full resize-none bg-transparent px-4 pt-4',
          'text-body text-on-surface caret-primary placeholder:text-on-surface-variant',
        )}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          // 中文输入法组字期间的 Enter 是选字，不触发发送
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (canSend) onSubmit()
          }
        }}
        placeholder={placeholder}
        rows={3}
        value={value}
      />
      <div className="flex items-center justify-between gap-2 px-3 pt-1 pb-3">
        <div className="flex items-center gap-1">{leading}</div>
        <div className="flex items-center gap-2">
          {trailing}
          {busy && onStop !== undefined ? (
            <button
              aria-label="停止"
              className={cn(
                'grid size-(--control-height-md) ui-state cursor-pointer place-items-center rounded-full ui-focus',
                'bg-surface-container-high text-error hover:bg-error hover:text-on-error active:scale-95',
              )}
              onClick={onStop}
              type="button"
            >
              <Icon decorative name="stopped" size="md" />
            </button>
          ) : (
            <button
              aria-label="发送"
              className={cn(
                'grid size-(--control-height-md) ui-state cursor-pointer place-items-center rounded-full ui-focus',
                // 禁用时 ui-state 把图标压成 disabled-text，灰底灰箭头对齐 kimi 的禁用发送钮
                canSend
                  ? 'bg-inverse-surface text-inverse-on-surface hover:scale-105 active:scale-95'
                  : 'bg-surface-container-high',
              )}
              disabled={!canSend}
              onClick={onSubmit}
              type="button"
            >
              <Icon
                className={cn(sending && 'animate-spin')}
                decorative
                name={sending ? 'loading' : 'send-up'}
                size="md"
              />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
