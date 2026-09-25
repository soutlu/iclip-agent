import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { addMockConversation, mockAuthUser, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { DEFAULT_AUDIT_SCOPE, type AnomalyKind, type AuditScope, type Metrics } from '../audit.api'
import { AnomaliesPanel } from './anomalies-panel'
import { ConversationsPanel } from './conversations-panel'
import { OverviewPanel } from './overview-panel'

const nameOf = (userName: string) =>
  userName === mockAuthUser.username
    ? '测试用户'
    : userName === mockGovernor.username
      ? '治理者'
      : undefined
const TASK_ID = '11111111-1111-4111-8111-111111111111'
const taskTitleOf = (taskId: string) => (taskId === TASK_ID ? '夏季亚麻系列' : undefined)
const ALL_TIME: AuditScope = { ...DEFAULT_AUDIT_SCOPE, range: 'all' }

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000).toISOString()

/** 全零的一格指标，给只关心某一段的用例当底座。 */
const EMPTY_METRICS = {
  attempts: 0,
  attemptsPerShot: null,
  completedVideos: 0,
  cycleSeconds: null,
  deliveredConversations: 0,
  deliveredOrphanConversations: 0,
  deliveredShots: 0,
  deliveredTasks: 0,
  deliveries: 0,
  effectiveRate: null,
  effectiveShots: 0,
  oneTakeRate: null,
  oneTakeShots: 0,
  producers: 0,
  runs: 0,
  shots: 0,
  tokensPerDelivery: null,
  upstreamSeconds: null,
  usage: {
    cacheHitRate: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    totalTokens: 0,
  },
  videoSeconds: null,
}

/** 排行表里某一行、某一列的格子；列按表头名找，行按名字找。 */
const rankCellOf = (table: HTMLElement, rowName: string, column: string): HTMLElement => {
  const index = within(table)
    .getAllByRole('columnheader')
    .findIndex((header) => header.textContent === column)
  // 第一列是行头，数据格从第二列起。
  const cell = within(within(table).getByRole('row', { name: new RegExp(rowName) }))
    .getAllByRole('cell')
    .at(index - 1)
  if (index < 1 || cell === undefined) throw new Error(`「${rowName}」行没有「${column}」列`)
  return cell
}

/** 三段对话：第三段（下标 2）镜 2 会试三次；第二段没挂需求单；第一段是治理者的。 */
const seed = () => {
  const first = addMockConversation('秋季新品短片', hoursAgo(2), mockGovernor.id)
  first.taskId = TASK_ID
  const second = addMockConversation('无单的试拍', hoursAgo(5))
  const third = addMockConversation('亚麻系列 B 版', hoursAgo(30))
  third.taskId = TASK_ID
  return { first, second, third }
}

describe('OverviewPanel', () => {
  it('把接口数字翻成人话铺在四张头条卡、排行表与异常概览里', async () => {
    const overall = {
      ...EMPTY_METRICS,
      attemptsPerShot: 1.5,
      // 一张需求单算一件，加一段无单对话，共两件。
      deliveredOrphanConversations: 1,
      deliveredTasks: 1,
      deliveries: 2,
      cycleSeconds: { avg: 7200, median: 7200, p90: 10_800 },
      // 四镜里一镜一次通过、三镜有人下载过。
      shots: 4,
      oneTakeShots: 1,
      oneTakeRate: 0.25,
      deliveredShots: 4,
      effectiveShots: 3,
      effectiveRate: 0.75,
    }
    server.use(
      http.get('*/api/audit/summary', () =>
        HttpResponse.json({
          anomalyCounts: [{ count: 3, kind: 'retry' }],
          attemptDistribution: [],
          overall,
          series: null,
          tasks: [{ metrics: overall, taskId: TASK_ID, title: '夏季亚麻系列' }],
          users: [
            { metrics: overall, userName: mockAuthUser.username },
            { metrics: EMPTY_METRICS, userName: mockGovernor.username },
          ],
        }),
      ),
    )
    await renderWithProviders(
      <OverviewPanel nameOf={nameOf} onOpenAnomalies={() => {}} scope={ALL_TIME} />,
    )

    const deliveries = await screen.findByRole('article', { name: '成片件数' })
    await waitFor(() => expect(within(deliveries).getByText('2')).toBeVisible())
    expect(within(deliveries).getByText('需求单 1 · 无单对话 1')).toBeVisible()

    const attempts = screen.getByRole('article', { name: '每镜平均出片次数' })
    expect(within(attempts).getByText(/次$/)).toBeVisible()

    const oneTake = screen.getByRole('article', { name: '一次通过率' })
    expect(within(oneTake).getByText('25.0%')).toBeVisible()
    expect(within(oneTake).getByText('1 / 4 镜 · 有效率 75.0%')).toBeVisible()

    const cycle = screen.getByRole('article', { name: '交付周期' })
    expect(within(cycle).getAllByText(/小时$/).length).toBeGreaterThan(0)

    const spreads = screen.getByRole('region', { name: '耗时分布' })
    expect(within(spreads).getAllByRole('rowheader')).toHaveLength(3)
    expect(within(spreads).getByRole('rowheader', { name: /交付周期/ })).toBeVisible()
    expect(within(spreads).getByRole('rowheader', { name: /上游段/ })).toBeVisible()

    for (const title of ['成片件数', '一次通过率', '每镜次数', '交付周期中位数']) {
      expect(screen.getByRole('figure', { name: title })).toBeVisible()
    }

    const byUser = screen.getByRole('region', { name: '按人' })
    expect(within(byUser).getByText('测试用户')).toBeVisible()
    expect(within(byUser).getByText('治理者')).toBeVisible()
    expect(within(byUser).getByRole('columnheader', { name: '运行次数' })).toBeVisible()
    // 出片镜为零的人有效率是 null，显示成破折号而不是 0%。
    expect(rankCellOf(byUser, '测试用户', '有效率')).toHaveTextContent('75.0%')
    expect(rankCellOf(byUser, '治理者', '有效率')).toHaveTextContent('—')
    const byTask = screen.getByRole('region', { name: '按需求单' })
    expect(within(byTask).getAllByRole('row')).toHaveLength(2)
    expect(rankCellOf(byTask, '夏季亚麻系列', '有效率')).toHaveTextContent('75.0%')

    const anomalies = screen.getByRole('region', { name: '异常概览' })
    expect(await within(anomalies).findByText('反复重试')).toBeVisible()
    expect(within(anomalies).getByText('3')).toBeVisible()
  })

  it('出片次数那段给出分布曲线与集中度结论', async () => {
    seed()
    server.use(
      http.get('*/api/audit/summary', () =>
        HttpResponse.json({
          anomalyCounts: [],
          // 五个镜：1、1、1、2、5 次，集中度 0.36。
          attemptDistribution: [
            { attempts: 1, shots: 3 },
            { attempts: 2, shots: 1 },
            { attempts: 5, shots: 1 },
          ],
          overall: EMPTY_METRICS,
          series: null,
          tasks: [],
          users: [],
        }),
      ),
    )
    await renderWithProviders(
      <OverviewPanel nameOf={nameOf} onOpenAnomalies={() => {}} scope={ALL_TIME} />,
    )

    const section = await screen.findByRole('region', { name: '出片次数分析' })
    const concentration = within(section).getByRole('figure', { name: '出片次数集中度' })
    // 最费劲的一成是半个出五次的镜，按镜数折半得 2.5 次，占十次里的 25%。
    await waitFor(() => expect(within(concentration).getByText('25%')).toBeVisible())

    const curve = within(section).getByRole('figure', { name: '出片次数分布' })
    expect(within(curve).getByText('一次完成 60% · 两次以内 80%')).toBeVisible()

    await userEvent.click(within(concentration).getByText('看数字'))
    // 分档表按档位列，末档是「5 次以上」：一个镜、五次，占十次里的一半。
    const tail = within(concentration).getByRole('row', { name: /5 次以上/ })
    expect(within(tail).getByRole('cell', { name: '50%' })).toBeVisible()
    expect(within(concentration).getByText(/集中度 0.36/)).toBeVisible()
  })

  it('各镜次数一致时不摆空表格', async () => {
    seed()
    server.use(
      http.get('*/api/audit/summary', () =>
        HttpResponse.json({
          anomalyCounts: [],
          attemptDistribution: [{ attempts: 2, shots: 7 }],
          overall: EMPTY_METRICS,
          series: null,
          tasks: [],
          users: [],
        }),
      ),
    )
    await renderWithProviders(
      <OverviewPanel nameOf={nameOf} onOpenAnomalies={() => {}} scope={ALL_TIME} />,
    )

    const section = await screen.findByRole('region', { name: '出片次数分析' })
    const concentration = within(section).getByRole('figure', { name: '出片次数集中度' })
    await waitFor(() => expect(within(concentration).getByText('各镜出片次数一致')).toBeVisible())
    expect(within(concentration).queryByText('看数字')).not.toBeInTheDocument()
  })

  it('不限时间没有上一期，头条卡不出「较上期」', async () => {
    seed()
    await renderWithProviders(
      <OverviewPanel nameOf={nameOf} onOpenAnomalies={() => {}} scope={ALL_TIME} />,
    )

    await screen.findByRole('article', { name: '成片件数' })
    expect(screen.queryByText('较上期')).not.toBeInTheDocument()
  })

  it('近 30 天时向上一期再要一份汇总，头条卡带变化', async () => {
    seed()
    const windows: string[] = []
    server.use(
      http.get('*/api/audit/summary', ({ request }) => {
        const query = new URL(request.url).searchParams
        // 两期都带 bucket，近 30 天只有上一期带右端点。
        const isPrevious = query.has('until')
        windows.push(isPrevious ? 'previous' : 'current')
        const base = { ...EMPTY_METRICS, deliveries: isPrevious ? 10 : 12 }
        return HttpResponse.json({
          anomalyCounts: [],
          attemptDistribution: [],
          overall: base,
          series: [],
          tasks: [],
          users: [],
        })
      }),
    )
    await renderWithProviders(
      <OverviewPanel nameOf={nameOf} onOpenAnomalies={() => {}} scope={DEFAULT_AUDIT_SCOPE} />,
    )

    const deliveries = await screen.findByRole('article', { name: '成片件数' })
    await waitFor(() => expect(within(deliveries).getByText('+20%')).toBeVisible())
    expect(windows.sort()).toEqual(['current', 'previous'])
  })

  it('接口失败时给出错误与重试', async () => {
    server.use(
      http.get('*/api/audit/summary', () =>
        HttpResponse.json({ detail: '报表暂时不可用' }, { status: 503 }),
      ),
    )
    await renderWithProviders(
      <OverviewPanel nameOf={nameOf} onOpenAnomalies={() => {}} scope={ALL_TIME} />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('报表暂时不可用')
    expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible()
  })

  it('上一期读不到时本期照常显示，说明一句并给重试，不出「较上期」', async () => {
    seed()
    let previousFails = true
    server.use(
      http.get('*/api/audit/summary', ({ request }) => {
        const isPrevious = new URL(request.url).searchParams.has('until')
        if (isPrevious && previousFails) {
          return HttpResponse.json({ detail: '上一期算不出来' }, { status: 503 })
        }
        return HttpResponse.json({
          anomalyCounts: [],
          attemptDistribution: [],
          overall: { ...EMPTY_METRICS, deliveries: isPrevious ? 10 : 12 },
          series: [],
          tasks: [],
          users: [],
        })
      }),
    )
    await renderWithProviders(
      <OverviewPanel nameOf={nameOf} onOpenAnomalies={() => {}} scope={DEFAULT_AUDIT_SCOPE} />,
    )

    const deliveries = await screen.findByRole('article', { name: '成片件数' })
    await waitFor(() => expect(within(deliveries).getByText('12')).toBeVisible())
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 })
    expect(alert).toHaveTextContent('上一期汇总没读到')
    expect(screen.queryByText('较上期')).not.toBeInTheDocument()

    previousFails = false
    await userEvent.click(within(alert).getByRole('button', { name: '重试' }))

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(await screen.findByText(/较上期/)).toBeVisible()
  })
})

describe('ConversationsPanel', () => {
  it('列出有成片的对话，展开看到每镜出片次数与按模型用量', async () => {
    const { third } = seed()
    const user = userEvent.setup()
    await renderWithProviders(
      <ConversationsPanel nameOf={nameOf} scope={ALL_TIME} taskTitleOf={taskTitleOf} />,
    )

    const list = await screen.findByRole('region', { name: '对话明细' })
    const rows = within(list).getAllByRole('listitem')
    const [firstRow, secondRow] = rows
    expect(rows).toHaveLength(3)
    if (firstRow === undefined || secondRow === undefined) throw new Error('列表应有三行')
    expect(within(firstRow).getByRole('link', { name: '秋季新品短片' })).toHaveAttribute(
      'href',
      expect.stringContaining('/c/'),
    )
    expect(within(firstRow).getByText('夏季亚麻系列')).toBeVisible()
    expect(within(secondRow).getByText('没挂需求单')).toBeVisible()

    const thirdRow = rows.find((row) => within(row).queryByText(third.title) !== null)
    if (thirdRow === undefined) throw new Error('第三段对话应在列表里')
    await user.click(within(thirdRow).getByRole('button', { name: '展开镜头明细' }))

    const shots = within(thirdRow).getByRole('list', { name: '镜头出片次数' })
    expect(
      within(shots).getByRole('listitem', { name: /第 2 镜，出了 3 次，没有一次通过/ }),
    ).toBeVisible()
    expect(within(thirdRow).getByRole('list', { name: '按模型用量' })).toHaveTextContent(
      'claude-sonnet-5',
    )
  })

  it('每段对话给出有效率，没有出片镜的是破折号；镜头带标出有人下载过的镜', async () => {
    const user = userEvent.setup()
    const at = hoursAgo(3)
    const shot = (index: number, effective: boolean) => ({
      attempts: 1,
      effective,
      firstAt: at,
      lastAt: at,
      oneTake: true,
      shot: index,
    })
    const report = (
      conversationId: string,
      title: string,
      metrics: Metrics,
      shots: ReturnType<typeof shot>[],
    ) => ({
      conversationId,
      deletedAt: null,
      deliveredAt: at,
      metrics,
      ownerUserId: mockAuthUser.id,
      shots,
      startedAt: at,
      taskId: null,
      title,
      usage: [],
      userName: mockAuthUser.username,
    })
    server.use(
      http.get('*/api/audit/conversations', () =>
        HttpResponse.json({
          items: [
            report(
              '22222222-2222-4222-8222-222222222222',
              '四镜里一镜被下载',
              {
                ...EMPTY_METRICS,
                attempts: 4,
                attemptsPerShot: 1,
                completedVideos: 4,
                deliveredShots: 4,
                effectiveRate: 0.25,
                effectiveShots: 1,
                oneTakeRate: 1,
                oneTakeShots: 4,
                shots: 4,
              },
              [shot(1, true), shot(2, false), shot(3, false), shot(4, false)],
            ),
            // 成片不带镜号：没有出片镜，有效率算不出来。
            report('33333333-3333-4333-8333-333333333333', '不带镜号的成片', EMPTY_METRICS, []),
          ],
          nextCursor: null,
        }),
      ),
    )
    await renderWithProviders(
      <ConversationsPanel nameOf={nameOf} scope={ALL_TIME} taskTitleOf={taskTitleOf} />,
    )

    const list = await screen.findByRole('region', { name: '对话明细' })
    const [withShots, withoutShots] = within(list).getAllByRole('listitem')
    if (withShots === undefined || withoutShots === undefined) throw new Error('列表应有两行')
    /** 每行摘要里某一项的值：dt 是名字，紧跟的 dd 是值。 */
    const statOf = (row: HTMLElement, label: string) =>
      within(row).getByText(label, { selector: 'dt' }).nextElementSibling
    expect(statOf(withShots, '有效率')).toHaveTextContent('25.0%')
    expect(statOf(withoutShots, '有效率')).toHaveTextContent('—')

    await user.click(within(withShots).getByRole('button', { name: '展开镜头明细' }))
    const shots = within(withShots).getByRole('list', { name: '镜头出片次数' })
    const downloaded = within(shots).getByRole('listitem', { name: /^第 1 镜.*，有人下载过$/ })
    expect(within(downloaded).getByTitle('有人下载过')).toBeVisible()
    const untouched = within(shots).getByRole('listitem', { name: /^第 2 镜.*，没人下载过$/ })
    expect(within(untouched).queryByTitle('有人下载过')).not.toBeInTheDocument()
  })

  it('没有对话时说明这个范围里没有成片', async () => {
    await renderWithProviders(
      <ConversationsPanel nameOf={nameOf} scope={ALL_TIME} taskTitleOf={taskTitleOf} />,
    )

    expect(await screen.findByText('这个范围里没有出过片的对话')).toBeVisible()
  })
})

/** 种类筛选由上层持有，这里替路由层握住它。 */
function AnomaliesWithKinds() {
  const [kinds, setKinds] = useState<AnomalyKind[]>([])
  return (
    <AnomaliesPanel
      kinds={kinds}
      nameOf={nameOf}
      onKindsChange={setKinds}
      scope={ALL_TIME}
      taskTitleOf={taskTitleOf}
    />
  )
}

describe('AnomaliesPanel', () => {
  it('列出异常并按种类筛', async () => {
    seed()
    const user = userEvent.setup()
    await renderWithProviders(<AnomaliesWithKinds />)

    const list = await screen.findByRole('region', { name: '异常列表' })
    expect(within(list).getByText('反复重试')).toBeVisible()
    expect(within(list).getByText('没挂需求单')).toBeVisible()
    expect(within(list).getByText(/第 2 镜出了 3 次/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: /反复重试/ }))

    await waitFor(() => {
      const filtered = screen.getByRole('region', { name: '异常列表' })
      expect(within(filtered).queryByText('没挂需求单')).not.toBeInTheDocument()
      expect(within(filtered).getByText('反复重试')).toBeVisible()
    })
  })
})
