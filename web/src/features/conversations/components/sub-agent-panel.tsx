/** 子代理那条流的面板：顶部是名字、状态与耗时，正文复用轮渲染。数据按子代理 id 走共用读取器，关面板就退订它那一条。 */

import { useTranscript } from '@/shared/transcript/use-transcript'
import type { TranscriptTurn } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { Button } from '@/shared/ui/button'
import { Tag } from '@/shared/ui/tag'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { ConversationTurn } from './conversation-turn'
import { agentCallOf } from './tool-display'

const STATUS = {
  cancelled: { label: '已停止', variant: 'soft' },
  completed: { label: '完成', variant: 'success' },
  failed: { label: '失败', variant: 'error' },
  queued: { label: '排队中', variant: 'soft' },
  running: { label: '进行中', variant: 'running' },
} as const

/** 秒以下不显示；一分钟以上带分。 */
const duration = (ms: number | undefined): string | undefined => {
  if (ms === undefined) return undefined
  const seconds = Math.round(ms / 1000)
  if (seconds < 1) return undefined
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

export function SubAgentPanel({ artifact, conversationId }: ArtifactRendererProps) {
  const source = artifact.source.kind === 'frame' ? artifact.source : undefined
  const agentId = source?.agentRefs?.[0]?.agentId
  if (agentId === undefined) return <PanelNotice text="这张卡没有派出子代理" />
  return (
    <SubAgentStream
      agentId={agentId}
      agentName={agentCallOf(source?.display)?.agentName ?? '子代理'}
      conversationId={conversationId}
    />
  )
}

type SubAgentStreamProps = {
  agentId: string
  agentName: string
  conversationId: string
}

function SubAgentStream({ agentId, agentName, conversationId }: SubAgentStreamProps) {
  const { refresh, view } = useTranscript(conversationId, agentId)
  const turns = view.items.filter((item): item is TranscriptTurn => item.kind === 'turn')
  const latest = turns.at(-1)
  // 跑着的时候 meta 先于轮头说话；结束后以轮的终态为准。
  const state = view.activity === 'turn' ? 'running' : latest?.state
  const status = state === undefined ? undefined : STATUS[state]
  const elapsed = duration(latest?.durationMs)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b-[0.5px] border-chat-hairline px-4">
        <Icon className="shrink-0 text-chat-muted-text" decorative name="agent" size="sm" />
        <span className="truncate text-body font-medium text-on-surface">{agentName}</span>
        {status === undefined ? null : <Tag variant={status.variant}>{status.label}</Tag>}
        {elapsed === undefined ? null : (
          <span className="text-body-sm text-chat-muted-text">{elapsed}</span>
        )}
      </div>
      {view.status === 'loading' ? <PanelNotice text="正在读取子代理的过程…" /> : null}
      {view.status === 'error' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-body-sm text-on-surface-variant">{view.error}</p>
          <Button leadingIcon="refresh" onClick={refresh} size="md" variant="outlined">
            重新加载
          </Button>
        </div>
      ) : null}
      {view.status === 'ready' ? (
        <div className="chat-scroller min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 px-5 py-4">
            {turns.map((turn) => (
              <ConversationTurn key={turn.turnId} turn={turn} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PanelNotice({ text }: { text: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-6 text-center">
      <Icon className="text-on-surface-faint" decorative name="agent" size="sm" />
      <p className="text-body-sm text-on-surface-variant">{text}</p>
    </div>
  )
}
