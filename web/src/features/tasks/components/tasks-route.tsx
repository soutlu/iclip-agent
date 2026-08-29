import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useUser } from '@/shared/auth'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { listAllTasks, listMyTasks, tasksQueryKeys, type Task } from '../tasks.api'
import { ProjectHero } from './project-hero'
import { RenameTaskDialog } from './rename-task-dialog'
import { TaskCard } from './task-card'
import { TaskDialog } from './task-dialog'

type TasksRouteProps = {
  /** 未登录时点「新建项目」做什么（路由层把它接到登录弹窗上） */
  onRequireLogin?: (() => void) | undefined
}

/**
 * 任务页：头部「新建项目」，「我的项目」（我认领的）+「全部项目」两个分区。
 *
 * 数据全部来自 /tasks：我的 = claimedBy=me（认领人在服务端按会话身份过滤），
 * 全部 = 整列。搜索框在前端按标题过滤两个分区。卡片点开与「新建项目」共用
 * 同一个弹窗——创建人与认领人都能在里面补充内容。
 */
export function TasksRoute({ onRequireLogin }: TasksRouteProps) {
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

  const openCreate = () => {
    if (!user) {
      onRequireLogin?.()
      return
    }
    setDialog({ open: true })
  }

  // 重命名走 PUT（整体覆盖），撤回是终态改不动；没有写权限就不给入口
  const canWrite = Boolean(user?.permissions.includes('tasks:write'))
  const renameProps = (task: Task) =>
    canWrite && task.status !== 'withdrawn'
      ? { onRename: () => setRename({ open: true, task }) }
      : {}

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* 侧栏收起后展开钮浮在 top-3 left-3（36px 见方），pt-14 让页头从它下面起排 */}
      <div className="flex w-full flex-col gap-15 px-6 pt-14 pb-10">
        <header className="flex items-center justify-between gap-6">
          <div className="flex flex-col gap-9">
            <div>
              <h1 className="text-headline font-semibold text-on-surface">项目</h1>
              <p className="mt-3 text-body text-on-surface-variant">多人协同，打造超级团队</p>
            </div>
            <div>
              <Button leadingIcon="add" onClick={openCreate} size="md" variant="inverted">
                新建项目
              </Button>
            </div>
          </div>
          <ProjectHero className="h-52 w-auto shrink-0 max-md:hidden" />
        </header>

        {/* 两个分区之间比页头到分区拉得更开，让「我的项目」和「全部项目」各成一段 */}
        <div className="flex flex-col gap-20">
          <section aria-label="我的项目" className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <h2 className="shrink-0 text-title-lg font-semibold text-on-surface">我的项目</h2>
              <div className="w-56 shrink-0">
                <Input
                  aria-label="搜索项目"
                  leadingIcon="search"
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索项目"
                  value={keyword}
                  wrapperClassName="h-(--control-height-sm) rounded-sm border-outline-variant"
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

          <section aria-label="全部项目" className="flex flex-col gap-4">
            <h2 className="text-title-lg font-semibold text-on-surface">全部项目</h2>
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
