import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import {
  editTriggerOf,
  editableModels,
  pickEditModel,
  seedVideoEditJob,
  videoEditChainKey,
} from './video-editor.api'

describe('seedVideoEditJob', () => {
  const conversationId = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'
  const chainKey = videoEditChainKey(conversationId, 'root-job')
  const clip = makeGenerationJob({ kind: 'clip', status: 'pending' })

  it('这条链还没读过就只有这一条', () => {
    const queryClient = new QueryClient()

    seedVideoEditJob(queryClient, conversationId, 'root-job', clip)

    expect(queryClient.getQueryData(chainKey)).toEqual({ items: [clip] })
  })

  it('放进这条链最前面、同一条替换不重复，并失效本对话全部编辑链', () => {
    const queryClient = new QueryClient()
    const earlier = makeGenerationJob({ kind: 'clip' })
    const otherChain = videoEditChainKey(conversationId, 'other-root')
    queryClient.setQueryData(chainKey, { items: [clip, earlier] })
    queryClient.setQueryData(otherChain, { items: [] })
    const accepted = { ...clip, status: 'submitted' as const }

    seedVideoEditJob(queryClient, conversationId, 'root-job', accepted)

    expect(queryClient.getQueryData(chainKey)).toEqual({ items: [accepted, earlier] })
    expect(queryClient.getQueryState(otherChain)?.isInvalidated).toBe(true)
  })
})

describe('编辑器用哪个模型', () => {
  const models = ['moyu-seedance-2-5', 'wan3.0-video']

  it.each([
    ['选过的还在允许表里就用它', 'wan3.0-video', 'moyu-seedance-2-5', 'wan3.0-video'],
    ['选过的不在了退回默认', 'gone-model', 'moyu-seedance-2-5', 'moyu-seedance-2-5'],
    ['默认模型不支持编辑就取第一个支持的', undefined, 'moyu-seedance-2-0', 'moyu-seedance-2-5'],
  ])('%s', (_name, wanted, fallback, expected) => {
    expect(pickEditModel(models, wanted, fallback)).toBe(expected)
  })

  it('一个都没有就没有模型', () => {
    expect(pickEditModel([], 'x', 'y')).toBeUndefined()
  })
})

describe('模型怎么触发编辑，按名字认', () => {
  it('Seedance 2.5 走 provider_options 开关，网关的两种前缀都认', () => {
    expect(editTriggerOf('moyu-seedance-2-5')).toEqual({
      providerOptions: { omni_reference_task_type: 'edit' },
    })
    expect(editTriggerOf('mmt-seedance-2-5')).toEqual(editTriggerOf('moyu-seedance-2-5'))
  })

  it('万相 3.0 靠正文前缀', () => {
    expect(editTriggerOf('wan3.0-video-prime')).toEqual({ promptPrefix: '编辑视频，' })
  })

  it('不认识的模型做不了编辑，下拉里不列', () => {
    expect(editTriggerOf('moyu-seedance-2-0')).toBeUndefined()
    expect(editableModels(['moyu-seedance-2-0', 'moyu-seedance-2-5', 'wan3.0-video'])).toEqual([
      'moyu-seedance-2-5',
      'wan3.0-video',
    ])
  })
})
