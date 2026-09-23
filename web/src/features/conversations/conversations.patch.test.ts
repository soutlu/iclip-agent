import { describe, expect, it } from 'vitest'
import { addMockConversation } from '@/testing/mocks/handlers'
import type { Conversation } from './conversations.api'
import { applyPatch, findConversationRow, patchConversationRows } from './conversations.patch'

const row = (overrides: Partial<Conversation> = {}): Conversation => ({
  ...addMockConversation('小王的秋季片', '2026-09-20T00:00:00Z'),
  completedAt: '2026-09-20T01:00:00Z',
  ...overrides,
})

const activityOf = (target: Conversation, overrides: Partial<Conversation['activity']> = {}) => ({
  busy: target.activity.busy,
  lastTurnReason: target.activity.lastTurnReason,
  pendingInteraction: target.activity.pendingInteraction,
  ...overrides,
})

describe('applyPatch', () => {
  it('改名：同名原样交回，不同名换标题', () => {
    const target = row()

    expect(applyPatch(target, { title: target.title })).toBe(target)
    expect(applyPatch(target, { title: '新名字' })).toMatchObject({ title: '新名字' })
  })

  it('抹收尾标记：本来就空的原样交回', () => {
    const cleared = row({ completedAt: null })

    expect(applyPatch(cleared, { completedAt: null })).toBe(cleared)
    expect(applyPatch(row(), { completedAt: null }).completedAt).toBeNull()
  })

  it('开跑的帧同时抹掉收尾标记，即使轮次三件事实都没变', () => {
    const busy = row({ activity: { ...row().activity, busy: true } })

    const patched = applyPatch(busy, { activity: activityOf(busy) })

    expect(patched).not.toBe(busy)
    expect(patched.completedAt).toBeNull()
    expect(patched.activity).toEqual(busy.activity)
  })

  it('lastTurnReason 在 undefined 与 null 之间不算变化，行保持原引用', () => {
    const target = row({ activity: { ...row().activity, busy: false, lastTurnReason: undefined } })

    expect(applyPatch(target, { activity: activityOf(target, { lastTurnReason: null }) })).toBe(
      target,
    )
  })

  it('只有待办变了也换行，但不碰收尾标记', () => {
    const target = row({ activity: { ...row().activity, busy: false, pendingInteraction: 'none' } })

    const patched = applyPatch(target, {
      activity: activityOf(target, { pendingInteraction: 'approval' }),
    })

    expect(patched).not.toBe(target)
    expect(patched.completedAt).toBe(target.completedAt)
    expect(patched.activity.pendingInteraction).toBe('approval')
  })
})

describe('在各种形状的缓存里找行、改行', () => {
  const first = row()
  const second = row()
  /** 全部对话页的无限查询：两页，目标在第二页；第一页应保持原引用。 */
  const infinite = {
    pageParams: [null, 'cursor'],
    pages: [
      { items: [first], nextCursor: 'cursor', runningTotal: 0, total: 2 },
      { items: [second], nextCursor: null, runningTotal: 0, total: 2 },
    ],
  }

  it('按 id 找到深处的那一行', () => {
    expect(findConversationRow(infinite, second.id)).toBe(second)
    expect(findConversationRow([first], second.id)).toBeUndefined()
  })

  it('改第二页的行时第一页与它的 items 保持原引用', () => {
    const patched = patchConversationRows(infinite, second.id, { title: '改过' }) as typeof infinite

    expect(patched).not.toBe(infinite)
    expect(patched.pages[0]).toBe(infinite.pages[0])
    expect(patched.pages[0]?.items).toBe(infinite.pages[0]?.items)
    expect(patched.pages[1]?.items[0]?.title).toBe('改过')
  })

  it('哪一行都没变时整份数据保持原引用', () => {
    expect(patchConversationRows(infinite, second.id, { title: second.title })).toBe(infinite)
    expect(patchConversationRows(infinite, 'nobody', { title: '无关' })).toBe(infinite)
  })

  it('只有 id 相同、不带 activity 与 ownerUserId 的对象不算行，不被碰', () => {
    const workspace = { id: first.id, files: [{ id: first.id, name: 'a.txt' }] }

    expect(findConversationRow(workspace, first.id)).toBeUndefined()
    expect(patchConversationRows(workspace, first.id, { title: '无关' })).toBe(workspace)
  })
})
