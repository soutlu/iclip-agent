import { describe, expect, it } from 'vitest'
import { zTaskInputsOutput } from '@/shared/api/generated/zod.gen'
import { canEditTaskField, creationBlockReason, type TaskField } from './task-permissions'
import type { Task } from './tasks.api'

const CREATOR_ID = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
const OTHER_ID = '4133e687-07d8-4460-a0dc-954f802697f4'
const WRITER = ['tasks:read', 'tasks:write', 'agent:run']

const creator = { id: CREATOR_ID, permissions: WRITER }
const other = { id: OTHER_ID, permissions: WRITER }
const manager = { id: OTHER_ID, permissions: [...WRITER, 'users:manage'] }

const task = (overrides: Partial<Task> = {}): Task => ({
  assigneeUserIds: [],
  createdAt: '2026-09-01T00:00:00Z',
  creatorUserId: CREATOR_ID,
  deadline: null,
  id: '46d82b9c-7456-43f6-bab0-67fb7525dafe',
  inputs: zTaskInputsOutput.parse({
    video_spec: { aspect_ratio: null, duration_seconds: null },
    reference_video_oss_url: null,
    products: [{ style_no: 'SBPU24001W', image_oss_urls: [] }],
    reference_image_oss_urls: { model: [], outfit: [], prop: [] },
  }),
  priority: 0,
  status: 'draft',
  title: '需求单',
  updatedAt: '2026-09-01T00:00:00Z',
  ...overrides,
})

const PLANNER: TaskField[] = [
  'title',
  'deadline',
  'resolution',
  'aspect_ratio',
  'duration_seconds',
  'references',
  'creative_requirement',
]
const FROZEN_ON_PUBLISH: TaskField[] = ['platform', 'video_type', 'content_type', 'product']
const FIXED_AT_CREATION: TaskField[] = ['products', 'style_no']
const ALL_FIELDS = [...PLANNER, ...FROZEN_ON_PUBLISH, ...FIXED_AT_CREATION]

const editableFields = (user: Parameters<typeof canEditTaskField>[0], target: Task) =>
  ALL_FIELDS.filter((field) => canEditTaskField(user, target, field))

describe('canEditTaskField', () => {
  it.each([
    { who: '创建者', user: creator, fields: [...PLANNER, ...FROZEN_ON_PUBLISH] },
    {
      who: '持 users:manage 的非创建者',
      user: manager,
      fields: [...PLANNER, ...FROZEN_ON_PUBLISH],
    },
    { who: '非创建者', user: other, fields: [] },
    {
      who: '没有 tasks:write 的创建者',
      user: { ...creator, permissions: ['tasks:read'] },
      fields: [],
    },
    { who: '未登录', user: undefined, fields: [] },
  ])('草稿：$who 能改的字段', ({ user, fields }) => {
    expect(editableFields(user, task({ status: 'draft' }))).toEqual(fields)
  })

  it.each(['published', 'confirmed'] as const)(
    '%s：任何持 tasks:write 的人只能改发布后仍开放的字段',
    (status) => {
      expect(editableFields(other, task({ status }))).toEqual(PLANNER)
      expect(editableFields(creator, task({ status }))).toEqual(PLANNER)
    },
  )

  it('发布后只有查看权限时什么都改不了', () => {
    expect(
      editableFields({ ...other, permissions: ['tasks:read'] }, task({ status: 'published' })),
    ).toEqual([])
  })

  it.each([
    { who: '创建者', user: creator },
    { who: '治理者', user: manager },
  ])('撤回后 $who 也全部只读', ({ user }) => {
    expect(editableFields(user, task({ status: 'withdrawn' }))).toEqual([])
  })
})

describe('creationBlockReason', () => {
  it.each([
    { case: '未登录', user: undefined, target: task({ status: 'confirmed' }), reason: /权限/ },
    {
      case: '没有 agent:run',
      user: { ...creator, permissions: ['tasks:read', 'tasks:write'] },
      target: task({ status: 'confirmed', assigneeUserIds: [CREATOR_ID] }),
      reason: /权限/,
    },
    { case: '读不到需求单', user: creator, target: undefined, reason: /读取/ },
    { case: '已撤回', user: creator, target: task({ status: 'withdrawn' }), reason: /撤回/ },
    { case: '草稿', user: creator, target: task({ status: 'draft' }), reason: /尚未认领/ },
    { case: '待认领', user: creator, target: task({ status: 'published' }), reason: /尚未认领/ },
    {
      case: '别人认领的进行中',
      user: creator,
      target: task({ status: 'confirmed', assigneeUserIds: [OTHER_ID] }),
      reason: /你尚未认领/,
    },
  ])('$case 时拦下并说明原因', ({ user, target, reason }) => {
    expect(creationBlockReason(user, target)).toMatch(reason)
  })

  it('自己认领的进行中需求单可以开始', () => {
    const target = task({ status: 'confirmed', assigneeUserIds: [CREATOR_ID] })
    expect(creationBlockReason(creator, target)).toBeNull()
  })
})
