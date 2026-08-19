import { useState } from 'react'
import { cn } from '@/shared/lib/utils'
import TaskConfirmView from './task-confirm-view'
import TaskDispatchView from './task-dispatch-view'

type TasksPanelMode = 'confirm' | 'dispatch'

const MODE_TABS: ReadonlyArray<{ id: TasksPanelMode; label: string }> = [
  { id: 'dispatch', label: '下发 Task' },
  { id: 'confirm', label: '确认 Task' },
]

/**
 * 首页 Task 面板：需求方「下发 Task」与策划师「确认 Task」两种视角，
 * 子类别切换复用 Inspiration 的 filter chip 设计。
 *
 * @returns 可切换视角的完整任务面板。
 */
export default function HomeTasksPanel() {
  const [mode, setMode] = useState<TasksPanelMode>('dispatch')

  return (
    <div className="home-tasks-panel" data-testid="home-tasks-panel">
      <div aria-label="任务视角" className="home-filter-chips mb-5 flex flex-wrap" role="group">
        {MODE_TABS.map((tab) => (
          <button
            aria-pressed={mode === tab.id}
            className={cn(
              'home-filter-chip transition-all duration-200 hover:-translate-y-px active:translate-y-0',
              mode === tab.id ? 'home-filter-chip--active' : '',
            )}
            key={tab.id}
            type="button"
            onClick={() => setMode(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mode === 'dispatch' ? <TaskDispatchView /> : <TaskConfirmView />}
    </div>
  )
}
