import { describe, expect, it } from 'vitest'
import { addMockConversation } from './conversations'

type AuditRow = { conversationId: string; deliveredAt: string; deletedAt: string | null }

const auditRowIn = async (conversationId: string, since: string, until: string) => {
  const query = new URLSearchParams({ since, until, limit: '50' })
  const response = await fetch(`/api/audit/conversations?${query}`)
  const { items } = (await response.json()) as { items: AuditRow[] }
  return items.find((item) => item.conversationId === conversationId)
}

describe('审计报表 mock', () => {
  it('删掉对话不挪它的交付时刻，也不挪出原来的时间窗', async () => {
    const conversation = addMockConversation('删掉也不挪位', '2026-09-01T08:00:00.000Z')
    const since = '2026-09-01T00:00:00.000Z'
    const until = '2026-09-02T00:00:00.000Z'
    const before = await auditRowIn(conversation.id, since, until)
    expect(before).toMatchObject({ deletedAt: null })

    const removed = await fetch(`/api/conversations/${conversation.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)

    expect(await auditRowIn(conversation.id, since, until)).toMatchObject({
      deletedAt: expect.any(String),
      deliveredAt: before?.deliveredAt,
    })
  })
})
