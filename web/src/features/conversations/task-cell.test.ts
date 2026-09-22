import { describe, expect, it } from 'vitest'
import { taskCellOf } from './task-cell'

const PREVIEW = { title: '夏季上新', requirement: '用自然光展示亚麻衬衫的质感', imageUrl: null }

describe('taskCellOf', () => {
  it('没关联需求单时两格都说未关联，不看读取状态', () => {
    expect(taskCellOf(null, undefined, '候选名', 'error')).toEqual({
      requirement: '未关联需求单',
      taskName: '未关联',
    })
  })

  it('预览到了就用预览：要求空白时说未填写', () => {
    expect(taskCellOf('t1', PREVIEW, undefined, 'ready')).toEqual({
      requirement: PREVIEW.requirement,
      taskName: PREVIEW.title,
    })
    expect(
      taskCellOf('t1', { ...PREVIEW, requirement: '  ' }, undefined, 'ready').requirement,
    ).toBe('未填写创作要求')
  })

  it.each([
    { state: 'loading', text: '正在读取需求单…' },
    { state: 'error', text: '需求单信息暂不可用' },
    { state: 'forbidden', text: '无需求单查看权限' },
    { state: 'ready', text: '需求单暂不可用' },
  ] as const)('预览没到时按 $state 说话，名字能用候选标题顶一下', ({ state, text }) => {
    expect(taskCellOf('t1', undefined, undefined, state)).toEqual({
      requirement: text,
      taskName: text,
    })
    expect(taskCellOf('t1', undefined, '候选名', state)).toEqual({
      requirement: text,
      taskName: '候选名',
    })
  })
})
