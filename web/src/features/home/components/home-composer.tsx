import { useRef, useState } from 'react'
import { useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { ComposerHandle, ComposerSubmission } from '@/shared/ui/composer'
import { Composer } from '@/shared/ui/composer'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'

/** Agent ID 必须与 server/agents/agents.yaml 的键一致。 */
const AGENTS = [
  { id: 'storyboard', label: '分镜 Agent' },
  { id: 'assistant', label: '通用助手' },
] as const

type HomeComposerProps = {
  /** 未提供回调时不提交内容。 */
  onSend?: ((input: { agentId: string; parts: ComposerSubmission['parts'] }) => void) | undefined
  sending?: boolean | undefined
}

/** 附件入口由 assets:write 控制；逐条确认尚无后端 permission_mode 合同。 */
export function HomeComposer({ onSend, sending = false }: HomeComposerProps) {
  const composerRef = useRef<ComposerHandle>(null)
  const [agent, setAgent] = useState<(typeof AGENTS)[number]>(AGENTS[0])
  const { data: user } = useUser()

  const send = (submission: ComposerSubmission) => {
    if (onSend === undefined) return
    composerRef.current?.clear()
    onSend({ agentId: agent.id, parts: submission.parts })
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
