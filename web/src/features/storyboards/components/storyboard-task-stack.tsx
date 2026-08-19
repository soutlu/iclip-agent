import { Link } from '@tanstack/react-router'
import { Circle } from 'lucide-react'
import taskBookmarkShellUrl from '@/features/storyboards/assets/generated/task-bookmark-shell-v2.svg?url&no-inline'
import type { Storyboard } from '@/features/storyboards/model/storyboard-workspace'
import StoryboardIcon from '@/features/storyboards/components/storyboard-icon'
import { STORYBOARD_STATUS_LABELS } from '@/features/storyboards/components/storyboard-status'

type StoryboardTaskStackItem = Pick<
  Storyboard,
  'creativeInput' | 'sessionId' | 'status' | 'title'
> & {
  shots: Array<{ id: string }>
}

type StoryboardTaskStackProps<T extends StoryboardTaskStackItem> = {
  activeId: string
  items: T[]
  onAdd: () => void
  onSelect: (storyboard: T) => void
  /** 有进行中 Agent 运行的 session 集合，书签显示运行徽标。 */
  runningSessionIds?: ReadonlySet<string>
}

/**
 * 渲染由任务状态与款号驱动的 Storyboard 书签任务栈。
 *
 * @param props - 任务集合、当前任务与用户操作。
 * @returns 品牌、可访问的任务书签列表与新建入口。
 */
export default function StoryboardTaskStack<T extends StoryboardTaskStackItem>({
  activeId,
  items,
  onAdd,
  onSelect,
  runningSessionIds,
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
          const taskNumber = String(index + 1).padStart(2, '0')
          const running = runningSessionIds?.has(storyboard.sessionId) ?? false

          return (
            <button
              key={storyboard.sessionId}
              type="button"
              aria-label={`查看故事板项目 ${storyboard.title}`}
              aria-description={`款号：${styleNo}；状态：${STORYBOARD_STATUS_LABELS[storyboard.status]}${running ? '；Agent 运行中' : ''}`}
              aria-pressed={storyboard.sessionId === activeId}
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
                <Circle
                  className="storyboards-task-bookmark-mark-status"
                  fill="currentColor"
                  size={5}
                  strokeWidth={0}
                />
                <span>{taskNumber}</span>
              </span>
              <span className="storyboards-task-bookmark-copy">
                <span className="storyboards-task-bookmark-style" title={styleNo}>
                  {styleNo}
                </span>
                <span className="storyboards-task-bookmark-status">
                  <Circle
                    aria-hidden="true"
                    className="storyboards-task-bookmark-status-dot"
                    fill="currentColor"
                    size={7}
                    strokeWidth={0}
                  />
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
        aria-label="添加任务"
        onClick={onAdd}
      >
        <StoryboardIcon name="plus" size={15} title="添加任务" />
        <span>新任务</span>
      </button>
    </nav>
  )
}
