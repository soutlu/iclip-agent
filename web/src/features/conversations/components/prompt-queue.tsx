/** 队列状态来自服务端 prompts；仅提供追加和撤回，服务端没有重排接口。 */

import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useClampable } from './use-clampable'

type QueueItem = {
  promptId: string
  text: string
  media: readonly { kind: 'image' | 'video'; url: string }[]
}

type PromptQueueProps = {
  prompts: readonly QueueItem[]
  /** 仅运行中的轮次支持立即追加。 */
  canSteer: boolean
  onSteer: (promptId: string) => void
  onDiscard: (promptId: string) => void
}

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
        {prompt.text === '' && prompt.media.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-body-sm text-chat-muted-text">
            <Icon decorative name="file" size="sm" />
            附件 ×{prompt.media.length}
          </span>
        ) : (
          <span
            ref={ref}
            className={cn(
              'min-w-0 text-body-sm whitespace-pre-wrap text-chat-message-text opacity-80 group-hover:opacity-100',
              clampable && 'chat-q-clamp',
            )}
          >
            {prompt.text}
          </span>
        )}
        {prompt.media.length > 0 ? (
          <span className="flex shrink-0 gap-1">
            {prompt.media.map((media) =>
              media.kind === 'image' ? (
                <img
                  alt=""
                  className="size-7 rounded-xs border-[0.5px] border-chat-hairline object-cover"
                  key={media.url}
                  src={media.url}
                />
              ) : (
                <span
                  className="grid size-7 place-items-center rounded-xs border-[0.5px] border-chat-hairline text-chat-muted-text"
                  key={media.url}
                >
                  <Icon decorative name="video" size="sm" />
                </span>
              ),
            )}
          </span>
        ) : null}
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
