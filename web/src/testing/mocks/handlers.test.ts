import { describe, expect, it } from 'vitest'
import { addMockTask, loginAs, mockGovernor } from './handlers'

describe('需求单 mock', () => {
  it('治理者认领后在自己的需求单中可见，重复认领不会添加其他用户', async () => {
    const task = addMockTask('治理者认领的需求')
    task.status = 'published'
    loginAs(mockGovernor)
    const claim = () => fetch(`/api/tasks/${task.id}/confirm`, { method: 'POST' })

    expect((await claim()).status).toBe(200)
    expect((await claim()).status).toBe(200)
    expect(task.assigneeUserIds).toEqual([mockGovernor.id])

    const mine = await fetch('/api/tasks?claimedBy=me')
    const { items } = (await mine.json()) as { items: { id: string }[] }
    expect(items.map((item) => item.id)).toEqual([task.id])
  })
})
