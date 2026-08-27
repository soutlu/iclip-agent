import { Link } from '@tanstack/react-router'
import taskBookmarkShellUrl from '@/features/storyboards/assets/generated/task-bookmark-shell-v2.svg?url&no-inline'
import type { Storyboard } from '@/features/storyboards/model/storyboard-workspace'
import StoryboardIcon from '@/features/storyboards/components/storyboard-icon'
import { STORYBOARD_STATUS_LABELS } from '@/features/storyboards/components/storyboard-status'

type StoryboardTaskStackItem = Pick<
  Storyboard,
  'conversationId' | 'creativeInput' | 'status' | 'title'
> & {
  shots: Array<{ id: string }>
}

type StoryboardTaskStackProps<T extends StoryboardTaskStackItem> = {
  activeId: string
  items: T[]
  onAdd: () => void
  onSelect: (storyboard: T) => void
  /** 有 Agent 正在跑的对话，书签显示运行徽标。 */
  runningConversationIds?: ReadonlySet<string>
}

/**
 * 渲染这张需求单历次尝试的书签栈；书签上的编号就是第几次。
 *
 * @param props - 历次尝试、当前选中项与用户操作。
 * @returns 品牌、可访问的书签列表与「再跑一次」入口。
 */
export default function StoryboardTaskStack<T extends StoryboardTaskStackItem>({
  activeId,
  items,
  onAdd,
  onSelect,
  runningConversationIds,
}: StoryboardTaskStackProps<T>) {
  return (
    <nav className="storyboards-task-stack" aria-label="故事板任务">
      <Link to="/" className="storyboards-task-stack-brand" aria-label="返回 Producer 首页">
        <span className="storyboards-task-stack-logo" aria-hidden="true">
          <StoryboardIcon name="brand" size={16} title="Storyboard" />
        </span>
        <strong>storyboard</strong>
      </Link>

      <div className="storyboards-task-stack-items">
        {items.map((storyboard, index) => {
          const styleNo =
            storyboard.creativeInput.styleNo ?? storyboard.creativeInput.category ?? '未设置款号'
          const statusLabel = STORYBOARD_STATUS_LABELS[storyboard.status]
          const attemptNumber = String(index + 1).padStart(2, '0')
          const running = runningConversationIds?.has(storyboard.conversationId) ?? false

          return (
            <button
              key={storyboard.conversationId}
              type="button"
              aria-label={`查看第 ${index + 1} 次运行 ${storyboard.title}`}
              aria-description={`款号：${styleNo}；状态：${STORYBOARD_STATUS_LABELS[storyboard.status]}${running ? '；Agent 运行中' : ''}`}
              aria-pressed={storyboard.conversationId === activeId}
              className="storyboards-task-bookmark"
              data-running={running || undefined}
              data-status={storyboard.status}
              onClick={() => onSelect(storyboard)}
            >
              <span className="storyboards-task-bookmark-mark" aria-hidden="true">
                <img
                  alt=""
                  className="storyboards-task-bookmark-mark-icon"
                  src={taskBookmarkShellUrl}
                />
                <span className="storyboards-task-bookmark-mark-status" />
                <span>{attemptNumber}</span>
              </span>
              <span className="storyboards-task-bookmark-copy">
                <span className="storyboards-task-bookmark-style" title={styleNo}>
                  {styleNo}
                </span>
                <span className="storyboards-task-bookmark-status">
                  <span aria-hidden="true" className="storyboards-task-bookmark-status-dot" />
                  <span>{statusLabel}</span>
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <button
        type="button"
        className="storyboards-task-stack-add"
        aria-label="再跑一次"
        onClick={onAdd}
      >
        <StoryboardIcon name="plus" size={15} title="再跑一次" />
        <span>再跑一次</span>
      </button>
    </nav>
  )
}
