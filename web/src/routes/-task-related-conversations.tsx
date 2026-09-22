import { Link } from '@tanstack/react-router'
import { useRef } from 'react'
import {
  conversationStatus,
  useTaskConversations,
  type Conversation,
} from '@/features/conversations'
import { ConversationVideos } from '@/features/storyboard'
import { useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { StatusBadge } from '@/shared/ui/status-badge'

/** 需求单、对话与出片的组合放在路由层，各 feature 保持自己的查询与展示边界。 */
export function TaskRelatedConversations({ taskId }: { taskId: string }) {
  const { data: user } = useUser()
  if (!user) return null
  if (!user.permissions.includes('agent:read')) {
    return (
      <p className="py-6 text-body-sm text-on-surface-variant">当前账号没有查看关联对话的权限</p>
    )
  }
  return (
    <RelatedConversations
      key={`${user.id}:${taskId}`}
      taskId={taskId}
      canAudit={user.permissions.includes('users:manage')}
      canReadVideos={user.permissions.includes('generation:read')}
    />
  )
}

function RelatedConversations({
  taskId,
  canAudit,
  canReadVideos,
}: {
  taskId: string
  canAudit: boolean
  canReadVideos: boolean
}) {
  const query = useTaskConversations(taskId, canAudit)
  const playingVideoRef = useRef<HTMLVideoElement | null>(null)
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 py-3 text-caption text-on-surface-muted">
        <span>{query.data ? `${query.data.length} 个对话` : '关联对话'}</span>
        {!canAudit && <span>仅我的对话</span>}
      </div>
      {query.isPending && (
        <p className="py-4 text-body-sm text-on-surface-variant" role="status">
          正在加载关联对话…
        </p>
      )}
      {query.isError && (
        <InlineAlert
          action={{ label: '重试', onClick: () => void query.refetch() }}
          className="py-3"
          message={query.data ? '关联对话刷新失败' : '关联对话加载失败'}
        />
      )}
      {!query.isError && query.data?.length === 0 && (
        <p className="py-6 text-body-sm text-on-surface-variant">
          {canAudit ? '暂无关联对话' : '你还没有关联到这张需求单的对话'}
        </p>
      )}
      <div
        className="divide-y divide-border/60"
        onPlayCapture={(event) => {
          if (!(event.target instanceof HTMLVideoElement)) return
          if (playingVideoRef.current !== event.target) playingVideoRef.current?.pause()
          playingVideoRef.current = event.target
        }}
      >
        {query.data?.map((conversation) => (
          <RelatedConversation
            key={conversation.id}
            conversation={conversation}
            canReadVideos={canReadVideos}
            onBeforePreview={() => playingVideoRef.current?.pause()}
          />
        ))}
      </div>
    </>
  )
}

function RelatedConversation({
  conversation,
  canReadVideos,
  onBeforePreview,
}: {
  conversation: Conversation
  canReadVideos: boolean
  onBeforePreview: () => void
}) {
  const status = conversationStatus(conversation.activity)
  const videoStatus = conversation.activity.videoGeneration
  return (
    <section aria-label={conversation.title} className="min-w-0 py-5 first:pt-2">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h3 className="min-w-0 text-body font-semibold wrap-anywhere">{conversation.title}</h3>
          <StatusBadge kind="conversation" status={status} appearance="label" />
          {videoStatus !== 'none' && (
            <StatusBadge kind="video" status={videoStatus} appearance="label" />
          )}
        </div>
        <Link
          className="inline-flex shrink-0 items-center gap-1 rounded-xs py-1 text-body-sm text-primary ui-focus"
          to="/c/$conversationId"
          params={{ conversationId: conversation.id }}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`打开对话：${conversation.title}（新标签页）`}
        >
          打开对话
          <Icon decorative name="external" size="sm" />
        </Link>
      </div>
      {canReadVideos ? (
        <ConversationVideos conversationId={conversation.id} onBeforePreview={onBeforePreview} />
      ) : (
        <p className="text-body-sm text-on-surface-variant">当前账号没有查看视频的权限</p>
      )}
    </section>
  )
}
