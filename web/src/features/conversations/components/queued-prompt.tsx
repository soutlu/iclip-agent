/**
 * 排着队的那一条：气泡照常，底下多两个动作。
 *
 * 「追加」把它插进正在跑的那一轮（不必等跑完），「撤回」把它撤掉。排队本身由服务端管——这里
 * 只是那张表的两个入口。
 */

import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'

type QueuedPromptProps = {
  text: string
  /** 插进当前那一轮；没有在跑的轮次时不给这个入口。 */
  onSteer?: (() => void) | undefined
  onDiscard: () => void
}

const ACTION_CLASS = cn(
  'inline-flex ui-state cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 ui-focus',
  'text-body-sm text-chat-muted-text',
)

/**
 * 渲染一条排队中的消息。
 *
 * @param props - 组件属性。
 * @param props.text - 内容。
 * @param props.onSteer - 追加到当前轮。
 * @param props.onDiscard - 撤回。
 * @returns 排队气泡与两个动作。
 */
export function QueuedPrompt({ onDiscard, onSteer, text }: QueuedPromptProps) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[78%] rounded-md bg-chat-user-bg px-3 py-2.5 text-body whitespace-pre-wrap text-chat-message-text opacity-70">
        {text}
      </div>
      <div className="flex items-center gap-1">
        <span className="text-body-sm text-chat-muted-text">排队中</span>
        {onSteer === undefined ? null : (
          <button className={ACTION_CLASS} onClick={onSteer} type="button">
            <Icon decorative name="next" size="sm" />
            追加到这一轮
          </button>
        )}
        <button className={ACTION_CLASS} onClick={onDiscard} type="button">
          <Icon decorative name="close" size="sm" />
          撤回
        </button>
      </div>
    </div>
  )
}
