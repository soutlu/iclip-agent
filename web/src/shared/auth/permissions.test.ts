import { describe, expect, it } from 'vitest'
import { canAuditAll, hasPermission, PERMISSION } from './permissions'

const userWith = (...permissions: string[]) => ({ permissions })

describe('权限判定', () => {
  it('带着这条权限才算有', () => {
    const user = userWith(PERMISSION.agentRead)

    expect(hasPermission(user, PERMISSION.agentRead)).toBe(true)
    expect(hasPermission(user, PERMISSION.agentRun)).toBe(false)
  })

  it.each([null, undefined])('没有会话（%s）一律没有权限', (user) => {
    expect(hasPermission(user, PERMISSION.agentRead)).toBe(false)
    expect(canAuditAll(user)).toBe(false)
  })
})

describe('看全部对话', () => {
  it.each([
    { expected: true, permissions: [PERMISSION.usersManage, PERMISSION.agentRead] },
    { expected: false, permissions: [PERMISSION.usersManage] },
    { expected: false, permissions: [PERMISSION.agentRead] },
    { expected: false, permissions: [] },
  ])('$permissions 的结果是 $expected', ({ expected, permissions }) => {
    expect(canAuditAll(userWith(...permissions))).toBe(expected)
  })
})
