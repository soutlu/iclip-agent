import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'

/**
 * 首页输入卡：对齐 Kimi Code Web 的 composer——32 大圆角白卡，focus-within 边框加深
 * （无焦点环，焦点指示由卡边框承担）；上输入行、下工具行，卡下沿挂项目条。
 *
 * 当前只做外观：输入框本地受控，添加 / agent 选择 / 项目选择 / 发送都不接后端。
 *
 * @returns 首页输入卡与项目条。
 */
export function HomeComposer() {
  const [value, setValue] = useState('')
  const canSend = value.trim().length > 0

  return (
    <div>
      <div
        className={cn(
          'relative rounded-3xl border border-border bg-surface-container-lowest',
          'shadow-[var(--shadow-1)] transition-colors focus-within:border-border-hover',
        )}
      >
        <textarea
          aria-label="输入消息"
          className={cn(
            'home-composer-textarea w-full resize-none bg-transparent px-4 pt-4 text-body text-on-surface',
            'placeholder:text-on-surface-variant',
          )}
          onChange={(event) => setValue(event.target.value)}
          placeholder="输入消息，开始创作…"
          rows={3}
          value={value}
        />
        <div className="flex items-center justify-between gap-2 px-3 pt-1 pb-3">
          <IconButton label="添加" name="add" size="md" />
          <div className="flex items-center gap-2">
            <span className="inline-flex h-(--control-height-md) items-center gap-1 rounded-full px-3 text-body-sm font-medium text-on-surface-variant">
              默认 Agent
              <Icon decorative name="expand" size="sm" />
            </span>
            <button
              aria-label="发送"
              className={cn(
                'grid size-(--control-height-md) ui-state cursor-pointer place-items-center rounded-full ui-focus',
                // 禁用时 ui-state 把图标压成 disabled-text，灰底灰箭头对齐 kimi 的禁用发送钮
                canSend
                  ? 'bg-inverse-surface text-inverse-on-surface'
                  : 'bg-surface-container-high',
              )}
              disabled={!canSend}
              type="button"
            >
              <Icon decorative name="send" size="md" />
            </button>
          </div>
        </div>
      </div>
      <div className="mx-3 -mt-3 flex items-center gap-1.5 rounded-b-xl bg-surface-container px-3 pt-4 pb-2 text-body-sm text-on-surface-variant">
        <Icon decorative name="folder" size="sm" />
        未关联项目
        <Icon decorative name="expand" size="sm" />
      </div>
    </div>
  )
}
