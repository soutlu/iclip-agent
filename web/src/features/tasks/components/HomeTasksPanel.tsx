import { useState } from 'react'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
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
      <ChipGroup
        aria-label="任务视角"
        className="mb-5"
        type="single"
        value={mode}
        onValueChange={(nextMode) => {
          const nextTab = MODE_TABS.find((tab) => tab.id === nextMode)
          if (nextTab) {
            setMode(nextTab.id)
          }
        }}
      >
        {MODE_TABS.map((tab) => (
          <FilterChip key={tab.id} value={tab.id}>
            {tab.label}
          </FilterChip>
        ))}
      </ChipGroup>

      {mode === 'dispatch' ? <TaskDispatchView /> : <TaskConfirmView />}
    </div>
  )
}
