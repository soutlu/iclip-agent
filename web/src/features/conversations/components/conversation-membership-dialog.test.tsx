import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { zConversationCollectionIn, zConversationTaskIn } from '@/shared/api/generated/zod.gen'
import { Toaster } from '@/shared/ui/toast'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { Conversation } from '../conversations.api'
import { ConversationMembershipDialog } from './conversation-membership-dialog'

const COLLECTION_A = '11111111-1111-4111-8111-111111111111'
const COLLECTION_B = '22222222-2222-4222-8222-222222222222'
const TASK_A = '33333333-3333-4333-8333-333333333333'
const TASK_B = '44444444-4444-4444-8444-444444444444'

const conversation = (): Conversation => ({
  activity: { busy: false, lastTurnReason: null, pendingInteraction: 'none' },
  agentId: 'storyboard',
  collectionId: COLLECTION_A,
  createdAt: '2026-09-11T00:00:00Z',
  id: '55555555-5555-4555-8555-555555555555',
  lastRunId: null,
  ownerUserId: '66666666-6666-4666-8666-666666666666',
  taskId: TASK_A,
  title: '秋季新品分镜',
  updatedAt: '2026-09-11T00:00:00Z',
})

function MembershipControls({
  initial,
  taskUnavailable,
}: {
  initial: Conversation
  taskUnavailable?: string
}) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <ConversationMembershipDialog
        collectionOptions={[
          { id: COLLECTION_A, label: '合集 A' },
          { id: COLLECTION_B, label: '合集 B' },
        ]}
        conversation={initial}
        onOpenChange={setOpen}
        onSaved={() => {}}
        open={open}
        taskOptions={
          taskUnavailable
            ? []
            : [
                { id: TASK_A, label: '需求单 A' },
                { id: TASK_B, label: '需求单 B' },
              ]
        }
        taskUnavailable={taskUnavailable}
      />
      <Toaster />
    </>
  )
}

describe('ConversationMembershipDialog', () => {
  it('合集保存成功但需求单失败后，改回原合集重试会恢复服务端归属', async () => {
    const initial = conversation()
    let stored = initial
    let rejectTask = true
    server.use(
      http.put('*/api/conversations/:conversationId/collection', async ({ request }) => {
        const body = zConversationCollectionIn.parse(await request.json())
        stored = { ...stored, collectionId: body.collectionId }
        return HttpResponse.json({ conversation: stored })
      }),
      http.put('*/api/conversations/:conversationId/task', async ({ request }) => {
        const body = zConversationTaskIn.parse(await request.json())
        if (rejectTask) {
          rejectTask = false
          return HttpResponse.json({ detail: '需求单暂时无法关联' }, { status: 422 })
        }
        stored = { ...stored, taskId: body.taskId }
        return HttpResponse.json({ conversation: stored })
      }),
    )
    const user = userEvent.setup()
    await renderWithProviders(<MembershipControls initial={initial} />)

    await user.selectOptions(screen.getByRole('combobox', { name: '合集' }), COLLECTION_B)
    await user.selectOptions(screen.getByRole('combobox', { name: '需求单' }), TASK_B)
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText(/需求单暂时无法关联/)).toBeVisible()
    expect(stored).toMatchObject({ collectionId: COLLECTION_B, taskId: TASK_A })
    expect(screen.getByRole('combobox', { name: '需求单' })).toHaveValue(TASK_B)

    await user.selectOptions(screen.getByRole('combobox', { name: '合集' }), COLLECTION_A)
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(stored).toMatchObject({ collectionId: COLLECTION_A, taskId: TASK_B })
  })

  it('无需求单查看权限时只修改合集，保留原有需求单归属', async () => {
    const initial = conversation()
    let stored = initial
    server.use(
      http.put('*/api/conversations/:conversationId/collection', async ({ request }) => {
        const body = zConversationCollectionIn.parse(await request.json())
        stored = { ...stored, collectionId: body.collectionId }
        return HttpResponse.json({ conversation: stored })
      }),
      http.put('*/api/conversations/:conversationId/task', async ({ request }) => {
        const body = zConversationTaskIn.parse(await request.json())
        stored = { ...stored, taskId: body.taskId }
        return HttpResponse.json({ conversation: stored })
      }),
    )
    const user = userEvent.setup()
    await renderWithProviders(
      <MembershipControls initial={initial} taskUnavailable="当前账号没有查看需求单权限" />,
    )

    expect(screen.getByRole('combobox', { name: '需求单' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '需求单' })).toHaveValue(TASK_A)
    await user.selectOptions(screen.getByRole('combobox', { name: '合集' }), COLLECTION_B)
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(stored).toMatchObject({ collectionId: COLLECTION_B, taskId: TASK_A })
  })
})
