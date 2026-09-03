import { useRef, useState } from 'react'
import { useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { ComposerHandle, ComposerSubmission } from '@/shared/ui/composer'
import { Composer } from '@/shared/ui/composer'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'

/** 能挑哪个 agent。名字与后端 `server/agents/agents.yaml` 的键一致。 */
const AGENTS = [
  { id: 'storyboard', label: '分镜 Agent' },
  { id: 'assistant', label: '通用助手' },
] as const

type HomeComposerProps = {
  /** 发送时做什么；未给就是还没接上（按钮照常按状态显示，但不产生动作）。 */
  onSend?:
    | ((input: {
        agentId: string
        text: string
        media: ComposerSubmission['media']
        parts: ComposerSubmission['parts']
      }) => void)
    | undefined
  /** 正在新建对话：发送钮转圈。 */
  sending?: boolean | undefined
}

/**
 * 首页输入卡：卡壳是 `shared/ui/composer`，这里只挂首页那几个控件与卡下沿的合集条。
 *
 * 「逐条确认」暂不接后端：对应的 `permission_mode` 合同里还没有这个字段。
 * 附件入口只在有 assets:write 权限时给（kimi：上传不可用就不出这个入口）。
 *
 * @param props - 组件属性。
 * @param props.onSend - 发送动作。
 * @param props.sending - 是否正在新建对话。
 * @returns 首页输入卡与合集条。
 */
export function HomeComposer({ onSend, sending = false }: HomeComposerProps) {
  const composerRef = useRef<ComposerHandle>(null)
  const [agent, setAgent] = useState<(typeof AGENTS)[number]>(AGENTS[0])
  const { data: user } = useUser()

  const send = (submission: ComposerSubmission) => {
    if (onSend === undefined) return
    composerRef.current?.clear()
    onSend({
      agentId: agent.id,
      media: submission.media,
      parts: submission.parts,
      text: submission.text,
    })
  }

  return (
    <div>
      <Composer
        attachmentsEnabled={user?.permissions.includes('assets:write') ?? false}
        leading={
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
        }
        onSubmit={send}
        ref={composerRef}
        sending={sending}
        trailing={
          <MenuRoot>
            <MenuTrigger
              className={cn(
                'inline-flex h-(--control-height-md) ui-state cursor-pointer items-center gap-1 rounded-full px-2 ui-focus',
                'text-body font-medium text-on-surface',
              )}
            >
              {agent.label}
              <Icon className="text-on-surface-variant" decorative name="expand" size="sm" />
            </MenuTrigger>
            <MenuSurface align="end">
              {AGENTS.map((option) => (
                <MenuItem key={option.id} onSelect={() => setAgent(option)}>
                  {option.label}
                </MenuItem>
              ))}
            </MenuSurface>
          </MenuRoot>
        }
      />
      <div className="mx-3 -mt-3 flex items-center gap-1.5 rounded-b-xl bg-surface-container-low px-3 pt-4 pb-2 text-body-sm text-on-surface-variant">
        <Icon decorative name="folder" size="sm" />
        未关联合集
        <Icon decorative name="expand" size="sm" />
      </div>
    </div>
  )
}
