import { describe, expect, it } from 'vitest'
import { editTriggerOf, editableModels } from './video-editor.api'

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
