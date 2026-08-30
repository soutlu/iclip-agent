import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'

type HomeComposerProps = {
  /** 点发送时做什么；未给就是还没接上（按钮照常禁用/可点，但不产生动作） */
  onSend?: (() => void) | undefined
}

/**
 * 首页输入卡：对齐 Kimi Code Web 的 composer——32 大圆角白卡，hover 边框加深，
 * focus-within 边框再加深并抬升到 shadow-2（无焦点环，焦点指示由卡边框与阴影承担）；
 * 上输入行、下工具行，卡下沿挂合集条。textarea 随内容增高，Enter 发送、Shift+Enter 换行。
 *
 * 深色下卡面用 top-layer（比主区亮一档，与 kimi 一致；浅色都是白）。
 * 当前只做外观：输入框本地受控，添加 / 权限 / agent 选择 / 合集选择都不接后端。
 *
 * @returns 首页输入卡与合集条。
 */
export function HomeComposer({ onSend }: HomeComposerProps) {
  const [value, setValue] = useState('')
  const canSend = value.trim().length > 0

  return (
    <div>
      <div
        className={cn(
          'relative rounded-3xl border border-border bg-top-layer shadow-[var(--shadow-1)]',
          'transition-[border-color,box-shadow] ui-motion-s',
          'focus-within:border-border-hover focus-within:shadow-[var(--shadow-2)] hover:border-border-hover/60',
        )}
      >
        <textarea
          aria-label="输入消息"
          className={cn(
            'home-composer-textarea field-sizing-content max-h-48 min-h-[76px] w-full resize-none bg-transparent px-4 pt-4',
            'text-body text-on-surface caret-primary placeholder:text-on-surface-variant',
          )}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // 中文输入法组字期间的 Enter 是选字，不触发发送
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (canSend) {
                onSend?.()
              }
            }
          }}
          placeholder="输入消息，开始创作…"
          rows={3}
          value={value}
        />
        <div className="flex items-center justify-between gap-2 px-3 pt-1 pb-3">
          <div className="flex items-center gap-1">
            <IconButton label="添加" name="add" size="md" />
            <button
              className={cn(
                'inline-flex h-(--control-height-md) ui-state cursor-pointer items-center gap-1.5 rounded-full px-3 ui-focus',
                'text-body-sm text-on-surface-variant',
              )}
              type="button"
            >
              <Icon decorative name="confirm" size="sm" />
              逐条确认
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={cn(
                'inline-flex h-(--control-height-md) ui-state cursor-pointer items-center gap-1 rounded-full px-2 ui-focus',
                'text-body font-medium text-on-surface',
              )}
              type="button"
            >
              默认 Agent
              <Icon className="text-on-surface-variant" decorative name="expand" size="sm" />
            </button>
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
              onClick={onSend}
              type="button"
            >
              <Icon decorative name="send-up" size="md" />
            </button>
          </div>
        </div>
      </div>
      <div className="mx-3 -mt-3 flex items-center gap-1.5 rounded-b-xl bg-surface-container-low px-3 pt-4 pb-2 text-body-sm text-on-surface-variant">
        <Icon decorative name="folder" size="sm" />
        未关联合集
        <Icon decorative name="expand" size="sm" />
      </div>
    </div>
  )
}
