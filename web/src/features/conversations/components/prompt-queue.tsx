/**
 * 排队队列（照 kimi 网页版）：消息流末尾右对齐的一叠队列行——头部一行「队列 · N 个任务
 * 等待发送」，每条是压暗的队列行：第一条约左侧有「立即发送到当前回合」圆钮 + 「下一条」
 * 胶囊，行尾 × 撤回 hover 才浮出。
 *
 * 队列本身由服务端 prompts 表管，这里只是那张表的呈现与两个入口（追加 / 撤回）。
 * kimi 队列行的拖拽排序与点击编回输入框不做：服务端队列没有重排接口，编辑等价于撤回后重发。
 */

import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useClampable } from './use-clampable'

type QueueItem = {
  promptId: string
  text: string
}

type PromptQueueProps = {
  prompts: readonly QueueItem[]
  /** 有在跑的轮次时才给「立即发送」入口。 */
  canSteer: boolean
  onSteer: (promptId: string) => void
  onDiscard: (promptId: string) => void
}

/**
 * 渲染排队队列。
 *
 * @param props - 组件属性。
 * @param props.prompts - 排着的消息。
 * @param props.canSteer - 是否有在跑的轮次。
 * @param props.onSteer - 追加到当前轮。
 * @param props.onDiscard - 撤回。
 * @returns 队列区；没有排队的就不渲染。
 */
export function PromptQueue({ canSteer, onDiscard, onSteer, prompts }: PromptQueueProps) {
  if (prompts.length === 0) return null

  return (
    <section aria-label="排队队列" className="flex w-full flex-col items-end gap-2">
      <p className="flex items-center gap-1 px-1.5 text-body-sm text-chat-muted-text">
        <Icon decorative name="mail" size="xs" />
        队列 · <strong className="font-medium">{prompts.length} 个任务等待发送</strong>
      </p>
      {prompts.map((prompt, index) => (
        <QueueRow
          canSteer={canSteer}
          first={index === 0}
          key={prompt.promptId}
          onDiscard={onDiscard}
          onSteer={onSteer}
          prompt={prompt}
        />
      ))}
    </section>
  )
}

type QueueRowProps = {
  prompt: QueueItem
  first: boolean
  canSteer: boolean
  onSteer: (promptId: string) => void
  onDiscard: (promptId: string) => void
}

/**
 * 一条队列行：压暗的文字（超 3 行折叠成渐隐），hover 提亮并浮出撤回钮。
 *
 * @param props - 组件属性。
 * @param props.prompt - 这条消息。
 * @param props.first - 是不是队首（队首有立即发送与「下一条」）。
 * @param props.canSteer - 是否有在跑的轮次。
 * @param props.onSteer - 追加到当前轮。
 * @param props.onDiscard - 撤回。
 * @returns 队列行。
 */
function QueueRow({ canSteer, first, onDiscard, onSteer, prompt }: QueueRowProps) {
  const { clampable, ref } = useClampable(3, prompt.text)

  return (
    <div className="flex items-center justify-end gap-2">
      {first && canSteer ? (
        <button
          aria-label="立即发送到当前回合"
          className="grid size-(--control-height-xs) shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-on-primary shadow-[var(--shadow-xs)] ui-focus transition-[background-color,transform] ui-motion-s hover:bg-primary-hover active:scale-90"
          onClick={() => onSteer(prompt.promptId)}
          type="button"
        >
          <Icon decorative name="send" size="sm" />
        </button>
      ) : null}
      <div className="group flex max-w-[min(88%,100vw-52px)] ui-state items-center gap-2 rounded-md bg-chat-user-bg py-1.5 pr-1.5 pl-2.5">
        <span
          ref={ref}
          className={cn(
            'min-w-0 text-body-sm whitespace-pre-wrap text-chat-message-text opacity-80 group-hover:opacity-100',
            clampable && 'chat-q-clamp',
          )}
        >
          {prompt.text}
        </span>
        {first ? (
          <span className="shrink-0 rounded-full bg-primary-container px-1.5 py-0.5 text-caption text-on-primary-container">
            下一条
          </span>
        ) : null}
        <button
          aria-label="撤回"
          className="grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-xs text-chat-muted-text opacity-0 ui-focus transition-[opacity,color,background-color] ui-motion-s group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-danger-bg hover:text-danger-text"
          onClick={() => onDiscard(prompt.promptId)}
          type="button"
        >
          <Icon decorative name="close" size="xs" />
        </button>
      </div>
    </div>
  )
}
