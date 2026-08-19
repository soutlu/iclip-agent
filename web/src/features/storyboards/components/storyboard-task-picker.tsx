import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { VideoTask, VideoTaskAsset, VideoTaskStatus } from '@/features/tasks'
import StoryboardIcon from '@/features/storyboards/components/storyboard-icon'

const TASK_STATUS_LABELS: Record<VideoTaskStatus, string> = {
  confirmed: '已确认',
  draft: '待确认',
  published: '已发布',
  withdrawn: '已撤回',
}

/** published 与 confirmed 均可作为创作来源（与后端 ensure_available 一致）。 */
const isTaskAvailable = (task: VideoTask) =>
  task.status === 'published' || task.status === 'confirmed'

type StoryboardTaskPickerProps = {
  addedTaskIds: ReadonlySet<string>
  assetsById: Record<string, VideoTaskAsset>
  error: null | string
  loading: boolean
  onClose: () => void
  onConfirm: (taskIds: string[]) => void
  open: boolean
  tasks: VideoTask[]
}

const getTaskPreviewUrl = (task: VideoTask, assetsById: Record<string, VideoTaskAsset>) => {
  if (task.style.previewImageUrl) return task.style.previewImageUrl

  const asset = assetsById[task.brief.referenceImages[0] ?? '']
  return asset?.assetType === 'image' ? asset.url : null
}

/**
 * 按参考实现渲染已有 Task 的搜索、多选和“添加到任务栏”确认流程。
 *
 * @param props - Task 列表、已加入集合和用户操作。
 * @returns 居中的已有任务选择弹窗。
 */
export default function StoryboardTaskPicker({
  addedTaskIds,
  assetsById,
  error,
  loading,
  onClose,
  onConfirm,
  open,
  tasks,
}: StoryboardTaskPickerProps) {
  const [query, setQuery] = useState('')
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set())
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return

    setQuery('')
    setSelectedTaskIds(new Set())
    searchInputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, open])

  const filteredTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return tasks

    return tasks.filter((task) =>
      `${task.title} ${task.style.styleNo}`.toLocaleLowerCase().includes(normalizedQuery),
    )
  }, [query, tasks])

  if (!open) return null

  const toggleTask = (task: VideoTask) => {
    if (addedTaskIds.has(task.id) || !isTaskAvailable(task)) return

    setSelectedTaskIds((current) => {
      const next = new Set(current)
      if (next.has(task.id)) {
        next.delete(task.id)
      } else {
        next.add(task.id)
      }
      return next
    })
  }

  const selectedCount = selectedTaskIds.size

  return (
    <div
      className="storyboards-task-picker-overlay"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <section
        className="storyboards-task-picker"
        role="dialog"
        aria-label="添加创作任务"
        aria-modal="true"
      >
        <header className="storyboards-task-picker-heading">
          <h2>添加创作任务</h2>
          <span>从任务列表中选择</span>
          <button type="button" aria-label="关闭任务选择器" onClick={onClose}>
            <StoryboardIcon name="close" size={14} title="关闭" />
          </button>
        </header>

        <label className="storyboards-task-picker-search">
          <Search aria-hidden="true" size={15} strokeWidth={2.2} />
          <input
            ref={searchInputRef}
            value={query}
            placeholder="搜索任务名称 / 款号 / 品牌…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <div className="storyboards-task-picker-list">
          {loading ? <p className="storyboards-task-picker-state">正在加载任务…</p> : null}
          {error ? (
            <p className="storyboards-task-picker-state" role="alert">
              {error}
            </p>
          ) : null}
          {!loading && !error && filteredTasks.length === 0 ? (
            <p className="storyboards-task-picker-state">没有匹配的任务</p>
          ) : null}
          {!loading && !error
            ? filteredTasks.map((task, index) => {
                const alreadyAdded = addedTaskIds.has(task.id)
                const unavailable = !isTaskAvailable(task)
                const disabled = alreadyAdded || unavailable
                const selected = selectedTaskIds.has(task.id)
                const previewUrl = getTaskPreviewUrl(task, assetsById)

                return (
                  <button
                    key={task.id}
                    type="button"
                    className="storyboards-task-picker-row"
                    aria-pressed={selected}
                    data-disabled={disabled || undefined}
                    data-selected={selected || undefined}
                    disabled={disabled}
                    onClick={() => toggleTask(task)}
                  >
                    <span className="storyboards-task-picker-thumbnail" data-tone={index % 6}>
                      {previewUrl ? (
                        <img className="media-natural-ratio" src={previewUrl} alt="" />
                      ) : (
                        task.title.slice(0, 1)
                      )}
                    </span>
                    <span className="storyboards-task-picker-copy">
                      <strong>{task.title}</strong>
                      <small>
                        款号 {task.style.styleNo} · {TASK_STATUS_LABELS[task.status]}
                      </small>
                    </span>
                    {alreadyAdded ? (
                      <span className="storyboards-task-picker-status">已在任务栏</span>
                    ) : unavailable ? (
                      <span className="storyboards-task-picker-status">
                        {task.status === 'draft' ? '待发布' : '已撤回'}
                      </span>
                    ) : (
                      <>
                        <span className="storyboards-task-picker-status" data-available>
                          可添加
                        </span>
                        <span className="storyboards-task-picker-check" aria-hidden="true">
                          <StoryboardIcon name="check" size={10} title="已选择" />
                        </span>
                      </>
                    )}
                  </button>
                )
              })
            : null}
        </div>

        <footer className="storyboards-task-picker-footer">
          <span>{selectedCount > 0 ? `已选 ${selectedCount} 个任务` : '未选择任务'}</span>
          <div>
            <button type="button" data-variant="ghost" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              data-variant="primary"
              disabled={selectedCount === 0}
              onClick={() => onConfirm(Array.from(selectedTaskIds))}
            >
              {selectedCount > 0 ? `添加 ${selectedCount} 个任务` : '添加到任务栏'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
