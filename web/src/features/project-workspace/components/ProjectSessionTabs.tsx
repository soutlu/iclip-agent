import type { MouseEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AgentOSSessionStatus } from '@/features/chat'
import {
  createProducerProjectSession,
  deleteUnnamedProducerProjectSession,
  isUnnamedProducerProjectSessionTitle,
  type ProducerProjectSession,
  renameProducerProjectSession,
} from '@/features/projects'
import { cn } from '@/shared/lib/utils'
import HippoIcon from '@/shared/ui/icons/HippoIcon'
import PopupContent from '@/shared/ui/popup/PopupContent'

export type ProjectSessionTabIndicator = AgentOSSessionStatus | 'UNREAD'

interface ProjectSessionTabsProps {
  projectId: string
  sessionId: string
  sessionIndicators?: Partial<Record<string, ProjectSessionTabIndicator>>
  sessions: ProducerProjectSession[]
  onSessionsChange: (updatedSessions: ProducerProjectSession[]) => void
  onSessionSelect: (sessionId: string) => void
}

/**
 * 渲染极简胶囊风格的项目会话标签页栏（Option C）。
 *
 * @param props - 项目会话标签页属性。
 * @param props.onSessionsChange - session 列表变化回调。
 * @param props.projectId - 当前项目文件夹 id。
 * @param props.sessionId - 当前激活的 session id。
 * @param props.sessionIndicators - 每个 session 在顶部栏展示的状态符号。
 * @param props.onSessionSelect - 激活 session 变化回调。
 * @param props.sessions - 当前项目文件夹下的 session 列表。
 * @returns 项目页顶部 session 标签页。
 * 与项目左侧汉堡按钮设计系统融合，支持双击重命名和新建。
 */
export default function ProjectSessionTabs({
  projectId,
  sessionId,
  sessionIndicators = {},
  sessions,
  onSessionsChange,
  onSessionSelect,
}: ProjectSessionTabsProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [deleteConfirmationSessionId, setDeleteConfirmationSessionId] = useState<string | null>(
    null,
  )
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null)
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const isDense = sessions.length > 8
  const tabDensityClassName = isDense ? 'gap-1 px-2 text-caption' : 'gap-1.5 px-3 text-body'
  const createButtonLabel = isDense ? '新建' : '新建会话'
  const createButtonClassName = cn(
    'group flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full border border-border bg-header-btn-bg px-3 text-body font-semibold text-on-background backdrop-blur-md transition-all duration-[var(--dur-s)] select-none hover:border-border-hover hover:bg-hover active:scale-95',
    isDense ? 'w-[72px]' : 'w-[96px]',
  )
  const menuSession = sessions.find((session) => session.id === menuSessionId) ?? null
  const canDeleteMenuSession = menuSession
    ? isUnnamedProducerProjectSessionTitle(menuSession.title)
    : false

  /**
   * 双击编辑时自动聚焦并选中文字。
   */
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  /**
   * 创建下一个 session 并跳转到新 session 页面。
   *
   * @returns 无返回值。
   */
  const handleCreate = async () => {
    const session = await createProducerProjectSession(projectId)
    const updated = [...sessions, session]
    onSessionsChange(updated)
    onSessionSelect(session.id)
  }

  /**
   * 保存用户提交的 session 重命名。
   *
   * @param id - 需要重命名的 session id。
   * @returns 无返回值。
   */
  const handleRenameSubmit = async (id: string) => {
    const trimmed = editTitle.trim()
    setEditingId(null)
    if (!trimmed || trimmed === sessions.find((s) => s.id === id)?.title) {
      return
    }

    await renameProducerProjectSession(id, trimmed)
    const updated = sessions.map((s) => (s.id === id ? { ...s, title: trimmed } : s))
    onSessionsChange(updated)
  }

  /**
   * 打开指定 session 的轻量操作菜单。
   *
   * @param event - 菜单入口点击事件。
   * @param targetSessionId - 需要展示菜单的 session id。
   * @returns 无返回值。
   */
  const handleMenuOpen = (event: MouseEvent<HTMLElement>, targetSessionId: string) => {
    event.stopPropagation()
    setEditingId(null)
    setDeleteConfirmationSessionId(null)
    setMenuSessionId(targetSessionId)
    setMenuAnchorRect(event.currentTarget.getBoundingClientRect())
  }

  /**
   * 关闭当前 session 操作菜单。
   *
   * @returns 无返回值。
   */
  const handleMenuDismiss = () => {
    setDeleteConfirmationSessionId(null)
    setMenuSessionId(null)
    setMenuAnchorRect(null)
  }

  /**
   * 从操作菜单进入重命名状态。
   *
   * @returns 无返回值。
   */
  const handleMenuRename = () => {
    if (!menuSession) {
      handleMenuDismiss()
      return
    }

    setEditingId(menuSession.id)
    setEditTitle(menuSession.title)
    handleMenuDismiss()
  }

  /**
   * 删除仍未命名的 session；第一次点击只进入菜单内确认态。
   *
   * @returns 无返回值。
   */
  const handleMenuDelete = async () => {
    if (!menuSession || !canDeleteMenuSession) {
      handleMenuDismiss()
      return
    }

    if (deleteConfirmationSessionId !== menuSession.id) {
      setDeleteConfirmationSessionId(menuSession.id)
      return
    }

    await deleteUnnamedProducerProjectSession(menuSession.id)
    onSessionsChange(sessions.filter((session) => session.id !== menuSession.id))
    handleMenuDismiss()
  }

  /**
   * 取消当前内联重命名。
   *
   * @returns 无返回值。
   */
  const handleRenameCancel = () => {
    setEditingId(null)
    setEditTitle('')
  }

  return (
    <div className="flex min-w-0 flex-1 items-center">
      {/* 标签区可压缩，避免挤占新建按钮。 */}
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-1 pr-1">
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
          data-session-tab-list="true"
        >
          {sessions.map((session) => {
            const isActive = session.id === sessionId
            const isEditing = session.id === editingId
            const indicator = sessionIndicators[session.id] ?? 'COMPLETED'
            const tabClassName = cn(
              'group relative flex h-8 min-w-8 flex-[1_1_0] items-center rounded-full font-semibold backdrop-blur-md transition-all duration-[var(--dur-s)] select-none',
              tabDensityClassName,
              isActive
                ? 'border border-border bg-header-btn-bg text-on-background'
                : 'border border-transparent bg-transparent text-on-surface-variant opacity-70 hover:bg-hover hover:text-on-background hover:opacity-100',
            )

            if (isEditing) {
              return (
                <div key={session.id} className={tabClassName}>
                  <SessionStateIcon indicator={indicator} />
                  <input
                    ref={inputRef}
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={() => {
                      void handleRenameSubmit(session.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void handleRenameSubmit(session.id)
                      }
                    }}
                    className="min-w-0 flex-1 border-none bg-transparent p-0 text-body font-semibold text-on-background"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <button
                    type="button"
                    aria-label="保存会话名称"
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-hover hover:text-on-background"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      void handleRenameSubmit(session.id)
                    }}
                  >
                    <HippoIcon name="complete" size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label="取消重命名"
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-hover hover:text-on-background"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={handleRenameCancel}
                  >
                    <HippoIcon name="close" size={12} />
                  </button>
                </div>
              )
            }

            if (isActive) {
              return (
                <div key={session.id} className={tabClassName}>
                  <button
                    type="button"
                    aria-label={`当前会话 ${session.title}`}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-[inherit] pr-10 text-left"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      handleMenuDismiss()
                      setEditingId(session.id)
                      setEditTitle(session.title)
                    }}
                  >
                    <SessionStateIcon indicator={indicator} />
                    {/* 会话标题 */}
                    <span
                      className="min-w-0 overflow-hidden whitespace-nowrap"
                      title={session.title}
                    >
                      {session.title}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`打开 ${session.title} 的会话管理`}
                    aria-expanded={menuSessionId === session.id}
                    aria-haspopup="menu"
                    className="layer-local-1 absolute top-1/2 right-1 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-hover hover:text-on-background focus-visible:bg-hover focus-visible:text-on-background"
                    data-session-active-menu-affordance="true"
                    onClick={(event) => handleMenuOpen(event, session.id)}
                  >
                    <HippoIcon name="more" size={18} />
                  </button>
                </div>
              )
            }

            return (
              <div key={session.id} className={tabClassName}>
                <button
                  type="button"
                  aria-label={`切换到 ${session.title}`}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-[inherit] text-left"
                  onClick={() => onSessionSelect(session.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    handleMenuDismiss()
                    setEditingId(session.id)
                    setEditTitle(session.title)
                  }}
                >
                  <SessionStateIcon indicator={indicator} />
                  {/* 会话标题 */}
                  <span className="min-w-0 overflow-hidden whitespace-nowrap" title={session.title}>
                    {session.title}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`打开 ${session.title} 的会话操作菜单`}
                  aria-expanded={menuSessionId === session.id}
                  aria-haspopup="menu"
                  className={cn(
                    'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-on-surface-variant opacity-0 transition-all duration-[var(--dur-s)] group-hover:opacity-100 hover:bg-hover hover:text-on-background focus-visible:opacity-100',
                    menuSessionId === session.id ? 'opacity-100' : '',
                  )}
                  onClick={(event) => handleMenuOpen(event, session.id)}
                >
                  <HippoIcon name="more" size={13} />
                </button>
              </div>
            )
          })}
        </div>

        {/* 新建会话入口保持可见，避免和会话状态图标混淆。 */}
        <button
          type="button"
          aria-label="新建会话"
          data-session-create-button="true"
          title="新建会话"
          className={createButtonClassName}
          onClick={() => {
            void handleCreate()
          }}
        >
          <NewSessionIcon />
          <span className="leading-none">{createButtonLabel}</span>
        </button>
      </div>
      <PopupContent
        align="bottom-end"
        anchorRect={menuAnchorRect}
        aria-label="会话操作菜单"
        className="w-44 overflow-hidden border-outline-variant bg-popup-bg p-1 shadow-[var(--shadow-2)]"
        onDismiss={handleMenuDismiss}
        open={menuSessionId !== null}
        role="menu"
      >
        <button
          type="button"
          className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-body font-semibold text-on-background transition-colors hover:bg-hover"
          onClick={handleMenuRename}
          role="menuitem"
        >
          <HippoIcon name="edit-underline" size={13} />
          <span>修改</span>
        </button>
        {canDeleteMenuSession ? (
          <button
            type="button"
            className={cn(
              'mt-1 flex h-8 w-full items-center gap-2 rounded-sm border-t border-outline-variant px-2 text-left text-body font-semibold transition-colors',
              deleteConfirmationSessionId === menuSessionId
                ? 'bg-danger-bg text-danger-text hover:bg-danger-bg'
                : 'text-danger-text hover:bg-danger-bg',
            )}
            onClick={() => {
              void handleMenuDelete()
            }}
            role="menuitem"
          >
            <HippoIcon name="ashbin" size={13} />
            <span>{deleteConfirmationSessionId === menuSessionId ? '再次点击删除' : '删除'}</span>
          </button>
        ) : (
          <div className="mt-1 flex min-h-7 items-center gap-2 border-t border-outline-variant px-2 pt-1 text-caption leading-tight font-medium text-on-surface-variant">
            <HippoIcon name="prompt" size={11} />
            <span>有内容的 session 不能删除</span>
          </div>
        )}
      </PopupContent>
    </div>
  )
}

/**
 * 渲染新建会话图标。
 *
 * @returns 对话气泡和加号组合图标。
 */
function NewSessionIcon() {
  return (
    <span
      className="relative inline-flex size-[15px] shrink-0 items-center justify-center"
      data-new-session-icon="true"
    >
      <HippoIcon name="comment" size={14} />
      <span className="absolute -top-1 -right-1 flex size-3 items-center justify-center rounded-full border border-header-btn-bg bg-on-background text-background ring-1 ring-border">
        <span className="absolute h-[1.5px] w-1.5 rounded-full bg-current" />
        <span className="absolute h-1.5 w-[1.5px] rounded-full bg-current" />
      </span>
    </span>
  )
}

/**
 * 渲染 session 在顶部栏中的状态符号。
 *
 * @param props - session 状态符号属性。
 * @param props.indicator - 当前 session 的交互状态。
 * @returns 对应状态的轻量 SVG/CSS 符号。
 */
function SessionStateIcon({ indicator }: { indicator: ProjectSessionTabIndicator }) {
  if (indicator === 'UNREAD') {
    return (
      <span
        aria-label="Agent 已完成，待查看"
        className="relative inline-flex size-[13px] shrink-0 items-center justify-center text-primary-container-solid"
        data-session-indicator="UNREAD"
        role="img"
      >
        <HippoIcon name="comment" size={13} />
        <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary-container-solid" />
      </span>
    )
  }

  if (indicator === 'RUNNING' || indicator === 'PENDING') {
    return (
      <span
        aria-label={indicator === 'PENDING' ? 'Agent 等待运行' : 'Agent 运行中'}
        className="inline-flex size-[13px] shrink-0 items-center justify-center text-chat-status-running"
        data-session-indicator={indicator}
        role="img"
      >
        <span className="size-[11px] animate-spin rounded-full border border-current/25 border-t-current" />
      </span>
    )
  }

  if (indicator === 'PAUSED') {
    return (
      <span
        aria-label="等待人工确认"
        className="inline-flex size-[13px] shrink-0 items-center justify-center text-warning"
        data-session-indicator="PAUSED"
        role="img"
      >
        <HippoIcon name="prompt" size={13} />
      </span>
    )
  }

  if (indicator === 'ERROR' || indicator === 'CANCELLED') {
    return (
      <span
        aria-label={indicator === 'ERROR' ? 'Agent 运行失败' : 'Agent 已取消'}
        className="inline-flex size-[13px] shrink-0 items-center justify-center text-danger-text"
        data-session-indicator={indicator}
        role="img"
      >
        <HippoIcon name="close" size={13} />
      </span>
    )
  }

  return (
    <span
      aria-label="已查看或初始状态"
      className="inline-flex size-[13px] shrink-0 items-center justify-center"
      data-session-indicator="COMPLETED"
      role="img"
    >
      <HippoIcon name="complete" size={13} />
    </span>
  )
}
