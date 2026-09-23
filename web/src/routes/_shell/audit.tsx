import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  AnomaliesPanel,
  AuditScopeBar,
  ConversationsPanel,
  OverviewPanel,
  useAuditAnomalies,
  useAuditConversationReports,
  type AnomalyKind,
  type AuditScope,
} from '@/features/audit'
import { userPickerSourceOf, useUsersDirectory } from '@/shared/auth'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import { auditSearchSchema, scopeFromSearch, searchFromScope } from '../-audit-search'
import { requireGovernor } from '../-require-governor'
import { useAuditTaskPreviews } from '../-use-audit-task-previews'
import { useTaskPickerSource } from '../-use-task-picker-source'

const TABS = [
  { value: 'overview', label: '总览' },
  { value: 'conversations', label: '对话明细' },
  { value: 'anomalies', label: '异常' },
] as const

// 标签与筛选范围都存在查询参数里，退回报表、刷新与分享链接都还原同一屏。
export const Route = createFileRoute('/_shell/audit')({
  beforeLoad: requireGovernor,
  component: AuditPage,
  validateSearch: auditSearchSchema,
})

/** 三个标签共用一份筛选；人和需求单的候选在路由层取，feature 之间不互引。 */
function AuditPage() {
  const search = Route.useSearch()
  const { tab = 'overview' } = search
  const navigate = Route.useNavigate()
  const taskSource = useTaskPickerSource()
  const directory = useUsersDirectory(true)
  const scope = scopeFromSearch(search)
  const setScope = (next: AuditScope) =>
    void navigate({ replace: true, search: { ...searchFromScope(next), tab: search.tab } })

  // 报表按上游归属的用户名归人，候选的 id 与显示名都按用户名查。
  const userSource = userPickerSourceOf(directory, 'username')
  const nameOf = directory.nameOfUsername

  // 切标签不动筛选范围；总览是默认标签，不写进地址。
  const selectTab = (value: string) => {
    const next = TABS.find((item) => item.value === value)?.value ?? 'overview'
    void navigate({
      replace: true,
      search: { ...searchFromScope(scope), tab: next === 'overview' ? undefined : next },
    })
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

          <AuditScopeBar onChange={setScope} scope={scope} tasks={taskSource} users={userSource} />

          <TabsContent className="flex flex-col ui-focus" value="overview">
            <OverviewPanel
              nameOf={nameOf}
              onOpenAnomalies={() => selectTab('anomalies')}
              scope={scope}
            />
          </TabsContent>
          <TabsContent className="flex flex-col ui-focus" value="conversations">
            <ConversationsTab nameOf={nameOf} scope={scope} />
          </TabsContent>
          <TabsContent className="flex flex-col ui-focus" value="anomalies">
            <AnomaliesTab nameOf={nameOf} scope={scope} />
          </TabsContent>
        </TabsRoot>
      </div>
    </main>
  )
}

type TabProps = {
  scope: AuditScope
  nameOf: (userName: string) => string | undefined
}

/**
 * 按列表已读到的每页行批量取需求单标题，一页一个请求；取不到的由面板退回占位字。
 *
 * 不借选择器候选：那只有最近一页需求单，挂在更早需求单上的行会拿不到标题。
 */
const useTaskTitleOf = (
  pages: readonly { items: readonly { taskId: string | null }[] }[] | undefined,
) => {
  const { taskPreviews } = useAuditTaskPreviews(
    (pages ?? []).map((page) =>
      page.items.flatMap((row) => (row.taskId === null ? [] : [row.taskId])),
    ),
  )
  return (taskId: string) => taskPreviews.get(taskId)?.title
}

// 标签与面板读同一个查询键，这里只为拿到行上的 taskId，不多发请求。
function ConversationsTab({ scope, nameOf }: TabProps) {
  const reports = useAuditConversationReports(scope)
  const taskTitleOf = useTaskTitleOf(reports.data?.pages)
  return <ConversationsPanel nameOf={nameOf} scope={scope} taskTitleOf={taskTitleOf} />
}

function AnomaliesTab({ scope, nameOf }: TabProps) {
  const [kinds, setKinds] = useState<AnomalyKind[]>([])
  const anomalies = useAuditAnomalies(scope, kinds)
  const taskTitleOf = useTaskTitleOf(anomalies.data?.pages)
  return (
    <AnomaliesPanel
      kinds={kinds}
      nameOf={nameOf}
      onKindsChange={setKinds}
      scope={scope}
      taskTitleOf={taskTitleOf}
    />
  )
}
