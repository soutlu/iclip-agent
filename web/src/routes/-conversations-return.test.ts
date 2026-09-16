import { beforeEach, describe, expect, it } from 'vitest'
import { conversationsReturnSearch, rememberConversationsSearch } from './-conversations-return'

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('对话页返回按钮记住的列表筛选', () => {
  it('没记过就回默认视图', () => {
    expect(conversationsReturnSearch()).toEqual({})
  })

  it('记下的筛选原样取回', () => {
    rememberConversationsSearch({ ownerUserId: 'u-1', state: 'running' })

    expect(conversationsReturnSearch()).toEqual({ ownerUserId: 'u-1', state: 'running' })
  })

  it('存储里是坏数据时当没记过', () => {
    window.sessionStorage.setItem('cue.conversations.search', '{不是 JSON')

    expect(conversationsReturnSearch()).toEqual({})
  })

  it('存储里的取值不认识就丢掉那一项', () => {
    window.sessionStorage.setItem(
      'cue.conversations.search',
      JSON.stringify({ ownerUserId: 'u-1', state: 'paused' }),
    )

    expect(conversationsReturnSearch()).toEqual({ ownerUserId: 'u-1' })
  })
})
