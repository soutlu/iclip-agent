import { beforeEach, describe, expect, it } from 'vitest'
import { conversationsReturnSearch, rememberReturn } from './-conversations-return'

const KEY = 'cue.conversations.return'

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('对话页返回按钮记住的列表筛选', () => {
  it('没记过就回默认视图', () => {
    expect(conversationsReturnSearch('c-1')).toEqual({})
  })

  it('从列表点进去的那段对话带着当时的筛选', () => {
    rememberReturn('c-1', { ownerUserId: 'u-1', state: 'running' })

    expect(conversationsReturnSearch('c-1')).toEqual({ ownerUserId: 'u-1', state: 'running' })
  })

  it('换成别处进来的对话就回默认视图', () => {
    rememberReturn('c-1', { ownerUserId: 'u-1' })

    expect(conversationsReturnSearch('c-2')).toEqual({})
  })

  it('存储里是坏数据时当没记过', () => {
    window.sessionStorage.setItem(KEY, '{不是 JSON')

    expect(conversationsReturnSearch('c-1')).toEqual({})
  })

  it('存储里的取值不认识就丢掉那一项', () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ conversationId: 'c-1', search: { ownerUserId: 'u-1', state: 'paused' } }),
    )

    expect(conversationsReturnSearch('c-1')).toEqual({ ownerUserId: 'u-1' })
  })
})
