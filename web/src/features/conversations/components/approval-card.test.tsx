import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { ApprovalCard } from './approval-card'

/** 记录这张卡向服务端提交了几次决定。 */
function countDecisions() {
  const decisions: boolean[] = []
  server.use(
    http.post('*/api/conversations/c1/interactions/i1', async ({ request }) => {
      decisions.push(((await request.json()) as { approved: boolean }).approved)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return decisions
}

const card = (
  <ApprovalCard
    conversationId="c1"
    frame={undefined}
    interactionId="i1"
    onRefresh={() => {}}
    readOnly={false}
  />
)

describe('ApprovalCard 数字快捷键', () => {
  it('卡片在前时按 1 即同意', async () => {
    const decisions = countDecisions()
    await renderWithProviders(card)

    await userEvent.keyboard('1')

    expect(await screen.findByText('已同意')).toBeVisible()
    expect(decisions).toEqual([true])
  })

  it('弹窗盖着卡片时数字键是打给弹窗的，不替看不见的审批做决定', async () => {
    const decisions = countDecisions()
    await renderWithProviders(
      <>
        {card}
        <DialogRoot open>
          <DialogSurface aria-describedby={undefined}>
            <DialogHeader closeLabel="关闭" title="编辑图片" />
          </DialogSurface>
        </DialogRoot>
      </>,
    )
    await screen.findByRole('dialog', { name: '编辑图片' })

    await userEvent.keyboard('12')

    expect(decisions).toEqual([])
    // 弹窗打开期间卡片被标成 aria-hidden，查询要带 hidden 才找得到。
    expect(screen.getByRole('button', { hidden: true, name: '同意' })).toBeEnabled()
  })
})
