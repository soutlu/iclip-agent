import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useUser } from '@/shared/auth'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { listAllTasks, listMyTasks, tasksQueryKeys, type Task } from '../tasks.api'
import { RenameTaskDialog } from './rename-task-dialog'
import { TaskCard } from './task-card'
import { TaskDialog } from './task-dialog'
import { TaskHero } from './task-hero'

/** 路由负责登录守卫；我的需求单由 claimedBy=me 筛选，认领身份由服务端解析。 */
export function TasksRoute() {
  const { data: user } = useUser()
  const [keyword, setKeyword] = useState('')
  const [dialog, setDialog] = useState<{ open: boolean; taskId?: string }>({ open: false })
  const [rename, setRename] = useState<{ open: boolean; task?: Task }>({ open: false })

  const myTasks = useQuery({
    enabled: Boolean(user),
    queryFn: listMyTasks,
    queryKey: tasksQueryKeys.list('mine'),
  })
  const allTasks = useQuery({
    enabled: Boolean(user),
    queryFn: listAllTasks,
    queryKey: tasksQueryKeys.list('all'),
  })

  const filter = (items: Task[] | undefined): Task[] => {
    const list = items ?? []
    const kw = keyword.trim().toLowerCase()
    return kw ? list.filter((task) => task.title.toLowerCase().includes(kw)) : list
  }

  const mine = filter(myTasks.data)
  const all = filter(allTasks.data)

  // 重命名需要 tasks:write，且撤回后的需求单不可编辑。
  const canWrite = Boolean(user?.permissions.includes('tasks:write'))
  const renameProps = (task: Task) =>
    canWrite && task.status !== 'withdrawn'
      ? { onRename: () => setRename({ open: true, task }) }
      : {}

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* 页头预留侧栏展开按钮的覆盖空间。 */}
      <div className="flex w-full flex-col gap-15 px-6 pt-14 pb-10">
        <header className="flex items-center justify-between gap-6">
          <div className="flex flex-col gap-9">
            <div>
              <h1 className="text-headline font-semibold text-on-surface">需求单</h1>
              <p className="mt-3 text-body text-on-surface-variant">多人协同，打造超级团队</p>
            </div>
            <div>
              <Button
                leadingIcon="add"
                onClick={() => setDialog({ open: true })}
                size="md"
                variant="inverted"
              >
                新建需求单
              </Button>
            </div>
          </div>
          <TaskHero className="h-62 w-auto shrink-0 max-md:hidden" />
        </header>

        <div className="flex flex-col gap-20">
          <section aria-label="我的需求单" className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <h2 className="shrink-0 text-title-lg font-semibold text-on-surface">我的需求单</h2>
              <div className="w-56 shrink-0">
                <Input
                  aria-label="搜索需求单"
                  leadingIcon="search"
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索需求单"
                  value={keyword}
                  wrapperClassName="h-(--text-title-lg--line-height) rounded-sm border-border"
                />
              </div>
            </div>
            {mine.length > 0 && (
              <div className="grid-task-cards">
                {mine.map((task) => (
                  <TaskCard
                    key={task.id}
                    onClick={() => setDialog({ open: true, taskId: task.id })}
                    task={task}
                    {...renameProps(task)}
                  />
                ))}
              </div>
            )}
          </section>

          <section aria-label="全部需求单" className="flex flex-col gap-4">
            <h2 className="text-title-lg font-semibold text-on-surface">全部需求单</h2>
            {all.length > 0 && (
              <div className="grid-task-cards">
                {all.map((task) => (
                  <TaskCard
                    key={task.id}
                    onClick={() => setDialog({ open: true, taskId: task.id })}
                    task={task}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <TaskDialog
        onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))}
        open={dialog.open}
        taskId={dialog.taskId}
      />
      <RenameTaskDialog
        onOpenChange={(open) => setRename((prev) => ({ ...prev, open }))}
        open={rename.open}
        task={rename.task}
      />
    </main>
  )
}
