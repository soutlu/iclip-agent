import { describe, expect, it } from 'vitest'
import { zTaskInputsOutput } from '@/shared/api/generated/zod.gen'
import { buildTaskCreationDraft } from './task-creation'

const task = () => ({
  id: '46d82b9c-7456-43f6-bab0-67fb7525dafe',
  title: '仅用于系统关联的需求单名称',
  inputs: zTaskInputsOutput.parse({
    video_spec: {
      platform: '不发送的平台',
      video_type: '不发送的视频类型',
      content_type: '不发送的内容类型',
      aspect_ratio: '9:16',
      duration_seconds: 25,
      resolution: '1080p',
    },
    product: {
      style_no: '不发送的款号',
      name: '不发送的商品名',
      image_oss_urls: [
        'https://assets.example.com/product-1.png',
        'https://assets.example.com/product-2.png',
      ],
    },
    reference_image_oss_urls: {
      model: ['https://assets.example.com/product-2.png', 'https://assets.example.com/model.png'],
      outfit: ['https://assets.example.com/outfit.png'],
      prop: ['https://assets.example.com/prop.png'],
    },
    reference_video_oss_url: 'https://assets.example.com/reference.mp4',
    creative_requirement: '  逐字保留这段原文。\n\n口播：Hello!  \n',
  }),
})

describe('buildTaskCreationDraft', () => {
  it('仅组装约定字段，一条文字后按顺序附商品图、模特图和视频，不修改需求单', () => {
    const original = task()
    const snapshot = structuredClone(original)
    const draft = buildTaskCreationDraft(original)
    expect(draft?.taskId).toBe(original.id)
    expect(draft?.title).toBe(original.title)
    expect(draft?.content).toEqual([
      {
        type: 'text',
        text: `请基于以下创作要求和参考素材，按创作流程要求生成可执行的 Storyboard，用中文回复。\n\n## 创作要求\n- 目标画幅：9:16\n- 目标时长：25 秒\n- 分辨率：1080p\n\n## 需求描述\n${original.inputs.creative_requirement}`,
      },
      { type: 'image', source: { kind: 'url', url: 'https://assets.example.com/product-1.png' } },
      { type: 'image', source: { kind: 'url', url: 'https://assets.example.com/product-2.png' } },
      { type: 'image', source: { kind: 'url', url: 'https://assets.example.com/model.png' } },
      { type: 'video', source: { kind: 'url', url: 'https://assets.example.com/reference.mp4' } },
    ])
    expect(original).toEqual(snapshot)
  })

  it('可只发送媒体，不产生空规格或素材用途段落', () => {
    const original = task()
    original.inputs.video_spec = {
      ...original.inputs.video_spec,
      aspect_ratio: null,
      duration_seconds: null,
      resolution: '',
    }
    original.inputs.creative_requirement = ''
    const draft = buildTaskCreationDraft(original)
    expect(draft?.content.filter((part) => part.type === 'text')).toEqual([
      {
        type: 'text',
        text: '请基于以下创作要求和参考素材，按创作流程要求生成可执行的 Storyboard，用中文回复。',
      },
    ])
    expect(draft?.content).toHaveLength(5)
  })

  it('仅有被排除的字段或空白原文，不把固定开场当成有效输入', () => {
    const original = task()
    original.inputs.video_spec = {
      ...original.inputs.video_spec,
      aspect_ratio: null,
      duration_seconds: null,
      resolution: '  ',
    }
    original.inputs.creative_requirement = '  \n'
    original.inputs.product.image_oss_urls = []
    original.inputs.reference_image_oss_urls.model = []
    original.inputs.reference_video_oss_url = null
    expect(buildTaskCreationDraft(original)).toBeNull()
  })
})
