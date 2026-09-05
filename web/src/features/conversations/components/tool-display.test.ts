import { describe, expect, it } from 'vitest'
import type { ToolCallFrame } from '@/shared/transcript/vendor'
import { toolCard, toolMedia } from './tool-display'

const toolFrame = (fields: Partial<ToolCallFrame>): ToolCallFrame => ({
  frameId: 'f1',
  kind: 'tool',
  name: 'generate_shot_frames',
  state: 'done',
  toolCallId: 'call_1',
  ...fields,
})

const MEDIA = { items: [{ caption: 'S01', url: 'https://example.com/a.png' }] }

describe('toolCard', () => {
  it('检索：写搜内容，副标题是那个词', () => {
    expect(toolCard({ kind: 'search', query: '亚麻衬衫' })).toMatchObject({
      detail: '亚麻衬衫',
      label: '搜内容',
    })
  })

  it('取网页：只留域名与路径，查询串不上界面', () => {
    expect(
      toolCard({ kind: 'url_fetch', url: 'https://example.com/docs/a?token=secret' }),
    ).toMatchObject({ detail: 'example.com/docs/a', label: '取网页' })
  })

  it('取网页：地址不合法也画得出卡', () => {
    expect(toolCard({ kind: 'url_fetch', url: '不是地址' })).toMatchObject({
      detail: '不是地址',
      label: '取网页',
    })
  })

  it('读规范：副标题只写读的是哪一份文档，skill 名不上界面', () => {
    expect(
      toolCard({ args: '镜头节奏.md', kind: 'skill_call', skill_name: '分镜脚本' }),
    ).toMatchObject({ detail: '镜头节奏.md', label: '读规范' })
  })

  it('读规范：没点具体哪一份就没有副标题', () => {
    const card = toolCard({ kind: 'skill_call', skill_name: '分镜脚本' })
    expect(card.label).toBe('读规范')
    expect(card.detail).toBeUndefined()
  })

  it('派活：副标题是派下去的那句话，超长截断', () => {
    const prompt = '把这段素材'.repeat(20)
    const card = toolCard({ agent_name: 'storyboard', kind: 'agent_call', prompt })

    expect(card.label).toBe('派活')
    expect(card.detail).toHaveLength(61)
    expect(card.detail?.endsWith('…')).toBe(true)
  })

  it('认不出的 kind 退回朴素卡', () => {
    expect(toolCard({ kind: 'shell_exec', script: 'ls' })).toEqual({
      icon: 'task',
      label: '工具调用',
    })
  })
})

describe('toolMedia', () => {
  it('渲染器是媒体墙、调用跑完了、形状对得上，才给出这一排图', () => {
    expect(toolMedia(toolFrame({ metadata: MEDIA, view: 'media_grid' }))).toEqual(MEDIA.items)
  })

  it('还在跑的时候不画图', () => {
    expect(toolMedia(toolFrame({ metadata: MEDIA, state: 'running', view: 'media_grid' }))).toEqual(
      [],
    )
  })

  it('没点媒体墙这个渲染器就不画图', () => {
    expect(toolMedia(toolFrame({ metadata: MEDIA }))).toEqual([])
  })

  it('形状对不上就当一张都没有', () => {
    expect(toolMedia(toolFrame({ metadata: { items: 'a.png' }, view: 'media_grid' }))).toEqual([])
  })
})
