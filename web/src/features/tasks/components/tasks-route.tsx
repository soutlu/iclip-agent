import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useUser } from '@/shared/auth'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { listAllTasks, listMyTasks, tasksQueryKeys, type Task } from '../tasks.api'
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

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--layout-home-read-max) flex-col gap-8 px-6 py-10">
        <header className="flex flex-col gap-4">
          <div>
            <h1 className="text-display-sm font-semibold text-on-surface">项目</h1>
            <p className="mt-1 text-body text-on-surface-variant">多人协同，打造超级团队</p>
          </div>
          <div>
            <Button leadingIcon="add" onClick={openCreate} variant="inverted">
              新建项目
            </Button>
          </div>
        </header>

        <section aria-label="我的项目" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-title-lg font-semibold text-on-surface">我的项目</h2>
            <Input
              aria-label="搜索项目"
              className="max-w-64"
              leadingIcon="search"
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索项目"
              value={keyword}
            />
          </div>
          {mine.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {mine.map((task) => (
                <TaskCard
                  key={task.id}
                  onClick={() => setDialog({ open: true, taskId: task.id })}
                  task={task}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-border bg-surface-container-lowest p-4 text-body-sm text-on-surface-variant">
              {user ? '还没有认领过项目，去下面挑一个' : '登录后查看你认领的项目'}
            </p>
          )}
        </section>

        <section aria-label="全部项目" className="flex flex-col gap-3">
          <h2 className="text-title-lg font-semibold text-on-surface">全部项目</h2>
          {all.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {all.map((task) => (
                <TaskCard
                  key={task.id}
                  onClick={() => setDialog({ open: true, taskId: task.id })}
                  task={task}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-border bg-surface-container-lowest p-4 text-body-sm text-on-surface-variant">
              {allTasks.isLoading ? '加载中…' : '还没有项目'}
            </p>
          )}
        </section>
      </div>

      <TaskDialog
        onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))}
        open={dialog.open}
        taskId={dialog.taskId}
      />
    </main>
  )
}
