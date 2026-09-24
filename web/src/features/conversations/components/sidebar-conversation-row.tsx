import { useDraggable } from '@dnd-kit/core'
import { useParams } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { formatRelativeTime } from '@/shared/lib/relative-time'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSeparator, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { StatusBadge } from '@/shared/ui/status-badge'
import { toast } from '@/shared/ui/toast'
import { conversationStatus, needsAttention } from '../conversation-status'
import {
  useDeleteConversation,
  useRenameConversation,
  useSetConversationCompletion,
  type Conversation,
} from '../conversations.api'
import { useSeenRun } from '../conversations.unread'

// 状态层作用于整行及尾部按钮；内部标题按钮只负责焦点环。
export const SIDEBAR_ROW_CLASS =
  'group flex ui-state cursor-pointer items-center gap-2 rounded-sm px-3 py-1.5 text-body text-on-surface'

export const SIDEBAR_ROW_TITLE_CLASS = 'flex min-w-0 flex-1 items-center gap-2 rounded-xs ui-focus'

// 时间与操作按钮共用尾部槽位，hover、键盘聚焦或菜单展开时切换。
const ROW_TRAILING_HIDDEN =
  'group-hover:hidden group-focus-within:hidden group-has-data-[state=open]:hidden'
export const SIDEBAR_ROW_TRAILING_SHOWN =
  'hidden group-hover:flex group-focus-within:flex group-has-data-[state=open]:flex'

/** 仅对本浏览器已查看过且 lastRunId 变化的完成对话显示未读；当前打开的对话不显示。 */
const useUnread = (conversation: Conversation, active: boolean): boolean => {
  const seenRun = useSeenRun(conversation.id)
  return !active && seenRun !== undefined && seenRun !== conversation.lastRunId
}

type SidebarConversationRowProps = {
  conversation: Conversation
  dragging: boolean
  onOpenMembership: () => void
}

/** 侧栏一行对话：打开、改名、归属、标记完成与删除；改对话要有 agent:run，改完各 mutation 自己刷新列表。 */
export function SidebarConversationRow({
  conversation,
  dragging,
  onOpenMembership,
}: SidebarConversationRowProps) {
  const canWrite = hasPermission(useUser().data, PERMISSION.agentRun)
  const { listeners, setNodeRef, transform } = useDraggable({
    disabled: !canWrite,
    data: { collectionId: conversation.collectionId },
    id: conversation.id,
  })
  const openedId = useParams({ select: (params) => params.conversationId, strict: false })
  const active = openedId === conversation.id
  const [editing, setEditing] = useState(false)
  const rename = useRenameConversation()
  const remove = useDeleteConversation()
  const completion = useSetConversationCompletion()
  const completed = conversation.completedAt !== null
  const unread = useUnread(conversation, active)
  const status = conversationStatus(conversation.activity)
  // 行尾只画还需要人看一眼的状态；跑完没看过的用小点，其余什么都不画。
  const showUnread = unread && status === 'completed'

  const commitRename = (value: string) => {
    setEditing(false)
    const title = value.trim()
    if (title && title !== conversation.title) {
      rename.mutate(
        { conversationId: conversation.id, title },
        { onError: (error) => toast.error(errorMessageOf(error, '重命名失败')) },
      )
    }
  }

  return (
    // 拖拽绑定整行，避免链接原生拖动吞掉指针事件；编辑标题时禁用拖拽以允许文字选择。
    <div
      className={cn(
        SIDEBAR_ROW_CLASS,
        dragging && 'opacity-50',
        active && 'bg-state-active font-medium',
      )}
      ref={setNodeRef}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      {...(editing || !canWrite ? {} : listeners)}
    >
      {editing ? (
        <input
          aria-label={`重命名 ${conversation.title}`}
          className="min-w-0 flex-1 rounded-xs bg-surface-container-lowest px-1 text-body text-on-surface ui-focus-inline"
          defaultValue={conversation.title}
          onBlur={(event) => commitRename(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.currentTarget.value = conversation.title
              event.currentTarget.blur()
            }
          }}
          ref={(element) => element?.focus()}
        />
      ) : (
        <Link
          aria-current={active ? 'page' : undefined}
          className={SIDEBAR_ROW_TITLE_CLASS}
          draggable={false}
          params={{ conversationId: conversation.id }}
          to="/c/$conversationId"
        >
          <span className="min-w-0 flex-1 truncate text-left">{conversation.title}</span>
        </Link>
      )}
      {/* 出片在跑与轮次在跑互不蕴含，两个角标可以同时出现；跑完与失败在分镜页看。 */}
      <StatusBadge
        detail="完成后分镜页会更新结果"
        kind="video"
        status={
          conversation.activity.videoGeneration === 'none'
            ? 'idle'
            : conversation.activity.videoGeneration
        }
      />
      {needsAttention(status) && <StatusBadge kind="conversation" status={status} />}
      {completed && (
        <Icon className="shrink-0 text-primary" label="已完成" name="success" size="sm" />
      )}
      {showUnread && (
        <span aria-label="未读" className="size-1.5 shrink-0 rounded-full bg-primary" role="img" />
      )}
      {!editing && (
        <span
          aria-hidden
          className={cn('shrink-0 text-caption text-on-surface-faint', ROW_TRAILING_HIDDEN)}
        >
          {formatRelativeTime(conversation.createdAt)}
        </span>
      )}
      {!editing && canWrite && (
        <div className={cn(SIDEBAR_ROW_TRAILING_SHOWN, 'shrink-0 items-center')}>
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton label={`${conversation.title} 的更多操作`} name="more" size="xs" />
            </MenuTrigger>
            <MenuSurface align="start">
              <MenuItem icon="edit" onSelect={() => setEditing(true)}>
                重命名
              </MenuItem>
              <MenuItem icon="folder" onSelect={onOpenMembership}>
                归属
              </MenuItem>
              <MenuItem
                icon="check"
                onSelect={() =>
                  completion.mutate(
                    { completed: !completed, conversationId: conversation.id },
                    { onError: (error) => toast.error(errorMessageOf(error, '标记完成失败')) },
                  )
                }
              >
                {completed ? '取消完成' : '标记完成'}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                destructive
                icon="delete"
                onSelect={() =>
                  remove.mutate(conversation.id, {
                    onError: (error) => toast.error(errorMessageOf(error, '删除失败')),
                  })
                }
              >
                删除
              </MenuItem>
            </MenuSurface>
          </MenuRoot>
        </div>
      )}
    </div>
  )
}
