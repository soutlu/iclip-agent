import { describe, expect, it } from 'vitest'
import type { ToolCallFrame } from '@/shared/transcript/vendor'
import { fileChangeOf, toolBodyText, toolCard, toolChip, toolDiff, toolMedia } from './tool-display'

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
  it.each([
    ['read', '读取文件', 'file'],
    ['write', '写入文件', 'file'],
    ['edit', '编辑文件', 'edit'],
    ['glob', '浏览目录', 'folder'],
    ['grep', '搜索内容', 'search'],
  ] as const)('文件操作 %s：标题「%s」，路径等宽做主语', (operation, label, icon) => {
    expect(toolCard({ kind: 'file_io', operation, path: 'shots/a.md' })).toEqual({
      detail: 'shots/a.md',
      icon,
      label,
      mono: true,
      operation,
    })
  })

  it('检索：标题「搜索工作区」，主语是那个词，聚合时按搜索归类', () => {
    expect(toolCard({ kind: 'search', query: '亚麻衬衫' })).toMatchObject({
      detail: '亚麻衬衫',
      label: '搜索工作区',
      operation: 'grep',
    })
  })

  it('读取网页：只留域名与路径，查询串不上界面', () => {
    expect(
      toolCard({ kind: 'url_fetch', url: 'https://example.com/docs/a?token=secret' }),
    ).toMatchObject({ detail: 'example.com/docs/a', label: '读取网页', mono: true })
  })

  it('查阅规范：主语只写读的是哪一份文档，skill 名不上界面；没点具体哪一份就没有主语', () => {
    expect(
      toolCard({ args: '镜头节奏.md', kind: 'skill_call', skill_name: '分镜脚本' }),
    ).toMatchObject({ detail: '镜头节奏.md', label: '查阅规范' })
    expect(toolCard({ kind: 'skill_call', skill_name: '分镜脚本' })).toEqual({
      icon: 'reference',
      label: '查阅规范',
    })
  })

  it('委派任务：主语是派下去的那句话，超长截断', () => {
    const prompt = '把这段素材'.repeat(20)
    const card = toolCard({ agent_name: 'storyboard', kind: 'agent_call', prompt })

    expect(card.label).toBe('委派任务')
    expect(card.detail).toHaveLength(61)
    expect(card.detail?.endsWith('…')).toBe(true)
  })

  it('兜底卡：标题与主语分开给，服务端给 null 的主语当没有；媒体类结果用图片图标', () => {
    expect(
      toolCard({ detail: '镜头 1、2', kind: 'generic', summary: '生成画面' }, 'media_grid'),
    ).toEqual({
      detail: '镜头 1、2',
      icon: 'image',
      label: '生成画面',
    })
    expect(toolCard({ detail: null, kind: 'generic', summary: '拆解视频' })).toEqual({
      icon: 'task',
      label: '拆解视频',
    })
  })

  it('认不出的 kind 退回「调用工具」', () => {
    expect(toolCard({ kind: 'shell_exec', script: 'ls' })).toEqual({
      icon: 'task',
      label: '调用工具',
    })
  })
})

describe('fileChangeOf', () => {
  it('编辑给前后文，写入给整份内容，别的没有', () => {
    expect(
      fileChangeOf({
        after: '黄昏',
        before: '夜景',
        kind: 'file_io',
        operation: 'edit',
        path: 'a.md',
      }),
    ).toEqual({ after: '黄昏', before: '夜景' })
    expect(
      fileChangeOf({ content: '# 封面', kind: 'file_io', operation: 'write', path: 'a.md' }),
    ).toEqual({
      content: '# 封面',
    })
    expect(fileChangeOf({ kind: 'file_io', operation: 'read', path: 'a.md' })).toBeUndefined()
    expect(fileChangeOf({ kind: 'search', query: '夜景' })).toBeUndefined()
  })
})

describe('toolChip / toolDiff', () => {
  it('读文件：行数，读不完时说明', () => {
    const meta = { lines: 142, path: 'a.md', truncated: false }
    expect(toolChip(toolFrame({ metadata: meta, view: 'file_content' }))).toBe('142 行')
    expect(
      toolChip(toolFrame({ metadata: { ...meta, truncated: true }, view: 'file_content' })),
    ).toBe('142 行 · 未读完')
  })

  it('检索：命中数，没命中也说', () => {
    const match = { file: 'a.md', line: 3, text: '夜景' }
    expect(
      toolChip(
        toolFrame({
          metadata: { matches: [match, match], query: '夜景', truncated: false },
          view: 'search_results',
        }),
      ),
    ).toBe('2 处命中')
    expect(
      toolChip(
        toolFrame({
          metadata: { matches: [], query: '雨', truncated: false },
          view: 'search_results',
        }),
      ),
    ).toBe('无命中')
  })

  it('媒体：工具写好的说明优先，没有就数张数', () => {
    expect(
      toolChip(toolFrame({ metadata: { ...MEDIA, note: '4 张 · dev 渠道' }, view: 'media_grid' })),
    ).toBe('4 张 · dev 渠道')
    expect(toolChip(toolFrame({ metadata: MEDIA, view: 'media_grid' }))).toBe('1 张')
  })

  it('没有卡身渲染器的工具：角标原文照给；改文件给增删数，没改动就没有', () => {
    expect(toolChip(toolFrame({ metadata: { chip: '4.2 KB' } }))).toBe('4.2 KB')
    expect(toolChip(toolFrame({}))).toBeUndefined()
    expect(toolDiff(toolFrame({ metadata: { added: 3, removed: 1 } }))).toEqual({
      added: 3,
      removed: 1,
    })
    expect(toolDiff(toolFrame({ metadata: { added: 0, removed: 0 } }))).toBeUndefined()
    expect(toolDiff(toolFrame({ metadata: { chip: '4.2 KB' } }))).toBeUndefined()
  })

  it('形状对不上就没有角标', () => {
    expect(
      toolChip(toolFrame({ metadata: { lines: 'many' }, view: 'file_content' })),
    ).toBeUndefined()
    expect(toolChip(toolFrame({ metadata: { chip: 3 } }))).toBeUndefined()
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

describe('toolBodyText', () => {
  it('多行字符串结果能展开；一句话的结果卡头已经说完，不展开', () => {
    expect(toolBodyText(toolFrame({ output: 'a.md\t12 字节\nb.md\t3 字节' }))).toBe(
      'a.md\t12 字节\nb.md\t3 字节',
    )
    expect(toolBodyText(toolFrame({ output: '已写入 a.md（12 字节）' }))).toBeUndefined()
    expect(toolBodyText(toolFrame({ output: { message: '完成' } }))).toBeUndefined()
  })

  it('工具声明正文不给看，就算多行也不展开', () => {
    expect(
      toolBodyText(toolFrame({ metadata: { body: 'none' }, output: '# 规范\n\n第一条…' })),
    ).toBeUndefined()
  })
})
