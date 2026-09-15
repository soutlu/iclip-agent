import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import {
  AnomaliesPanel,
  AuditScopeBar,
  ConversationsPanel,
  DEFAULT_AUDIT_SCOPE,
  OverviewPanel,
  type AuditScope,
} from '@/features/audit'
import { AuditRoute } from '@/features/conversations'
import { useTaskOptions } from '@/features/tasks'
import { ensureSessionUser, useUser, useUsersDirectory } from '@/shared/auth'
import type { PickerSource } from '@/shared/ui/search-picker'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'

const TABS = [
  { value: 'overview', label: '总览' },
  { value: 'conversations', label: '对话明细' },
  { value: 'anomalies', label: '异常' },
  { value: 'all', label: '全部对话' },
] as const

const AuditSearchSchema = z.object({
  tab: z.enum(['overview', 'conversations', 'anomalies', 'all']).optional().catch(undefined),
})

// 审计页是治理者的页：接口同时要 users:manage 与 agent:read（合同 §6、§12），没登录或权限不够都回首页。
export const Route = createFileRoute('/_shell/audit')({
  beforeLoad: async () => {
    const user = await ensureSessionUser()
    const permissions = user?.permissions ?? []
    if (!permissions.includes('users:manage') || !permissions.includes('agent:read')) {
      throw redirect({ to: '/' })
    }
  },
  component: AuditPage,
  validateSearch: AuditSearchSchema,
})

/** 路由层组合两个 feature：报表三块共用一份筛选；全部对话保留自己的筛选条。需求单候选在这里取，两个 feature 不互引。 */
function AuditPage() {
  const { tab = 'overview' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data: user } = useUser()
  const canReadTasks = Boolean(user?.permissions.includes('tasks:read'))
  const tasks = useTaskOptions(canReadTasks)
  const directory = useUsersDirectory(true)
  const [scope, setScope] = useState<AuditScope>(DEFAULT_AUDIT_SCOPE)

  const taskSource: PickerSource | null = canReadTasks
    ? {
        error: tasks.error?.message,
        isPending: tasks.isPending,
        onRetry: () => void tasks.refetch(),
        options: tasks.data ?? [],
      }
    : null
  // 报表按上游归属的用户名归人，候选的 id 用用户名；没有用户名的账号不会出现在报表里，也不列。
  const userSource: PickerSource = {
    error: directory.error,
    isPending: directory.isPending,
    onRetry: () => void directory.refetch(),
    options: directory.users.flatMap((item) =>
      item.username === null ? [] : [{ id: item.username, label: item.displayName }],
    ),
  }
  const displayNameByUsername = new Map(
    directory.users.flatMap((item) =>
      item.username === null ? [] : [[item.username, item.displayName] as const],
    ),
  )
  const taskTitles = new Map((tasks.data ?? []).map((task) => [task.id, task.label]))
  const nameOf = (userName: string) => displayNameByUsername.get(userName)
  const taskTitleOf = (taskId: string) => taskTitles.get(taskId)

  const selectTab = (value: string) => {
    const next = TABS.find((item) => item.value === value)?.value ?? 'overview'
    void navigate({ replace: true, search: next === 'overview' ? {} : { tab: next } })
  }

  return (
    <main
      aria-label="审计"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface-container-lowest"
    >
      {/* 预留应用壳中侧栏展开按钮的空间。 */}
      <div className="mx-auto flex w-full max-w-360 flex-col gap-5 px-4 pt-12 pb-10 sm:px-7">
        <TabsRoot className="flex flex-col gap-5" onValueChange={selectTab} value={tab}>
          <header className="flex flex-wrap items-end justify-between gap-3 border-b-[0.5px] border-border/70">
            <div className="flex flex-col gap-1 pb-3">
              <h1 className="text-title-lg font-semibold tracking-tight text-on-surface">审计</h1>
              <p className="text-body-sm text-on-surface-variant">
                产量、成功率、耗时与模型消耗，从全体一路看到人、需求单与每一镜。
              </p>
            </div>
            <TabsList aria-label="审计内容" className="h-11">
              {TABS.map((item) => (
                <TabsTrigger className="px-3" key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </header>

          {tab === 'all' ? null : (
            <AuditScopeBar
              onChange={setScope}
              scope={scope}
              tasks={taskSource}
              users={userSource}
            />
          )}

          <TabsContent className="flex flex-col ui-focus" value="overview">
            <OverviewPanel
              nameOf={nameOf}
              onOpenAnomalies={() => selectTab('anomalies')}
              scope={scope}
            />
          </TabsContent>
          <TabsContent className="flex flex-col ui-focus" value="conversations">
            <ConversationsPanel nameOf={nameOf} scope={scope} taskTitleOf={taskTitleOf} />
          </TabsContent>
          <TabsContent className="flex flex-col ui-focus" value="anomalies">
            <AnomaliesPanel nameOf={nameOf} scope={scope} taskTitleOf={taskTitleOf} />
          </TabsContent>
          <TabsContent className="flex flex-col ui-focus" value="all">
            <AuditRoute tasks={taskSource} />
          </TabsContent>
        </TabsRoot>
      </div>
    </main>
  )
}
