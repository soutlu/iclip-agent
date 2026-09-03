/**
 * 用户气泡：按 part 原顺序画、超长折叠。
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptContentPart, TranscriptTurn } from '@/shared/transcript/vendor'
import { ConversationTurn } from './conversation-turn'
import { UserBubble } from './user-bubble'

/** jsdom 里元素没有高度，把量高这件事垫成「内容比 10 行高」。 */
const stubOverflowing = () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
  const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240)
  return () => {
    scroll.mockRestore()
    client.mockRestore()
  }
}

/** jsdom 没有剪贴板，垫一个能断言的最小实现。 */
const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return writeText
}

const text = (value: string): PromptContentPart => ({ text: value, type: 'text' })
const image = (url: string): PromptContentPart => ({ source: { kind: 'url', url }, type: 'image' })
const video = (url: string): PromptContentPart => ({ source: { kind: 'url', url }, type: 'video' })

describe('UserBubble', () => {
  let restore: (() => void) | undefined
  afterEach(() => restore?.())

  it('短消息不折叠，没有展开胶囊', () => {
    // jsdom 里元素高度是 0：量不出超高，自然不给入口
    render(<UserBubble content={[text('就一句')]} />)
    expect(screen.queryByRole('button', { name: '展开' })).toBeNull()
  })

  it('超长消息折叠成渐隐，点「展开」放开全文', async () => {
    restore = stubOverflowing()
    const user = userEvent.setup()
    render(<UserBubble content={[text('一行长长的素材说明\n'.repeat(20))]} />)

    // scrollHeight 500 > 240：量出超高才给入口
    const toggle = await screen.findByRole('button', { name: '展开' })
    await user.click(toggle)

    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument()
  })

  it('气泡下有复制钮：复制的是文字 part 原样接起来的正文；没给 onEdit 就没有修改钮', async () => {
    // user-event 自己会垫一份剪贴板，垫子要在它之后放才生效
    const user = userEvent.setup()
    const writeText = stubClipboard()
    render(
      <UserBubble
        content={[
          text('先看这张图：'),
          image('https://bkt.oss-cn-hangzhou.aliyuncs.com/u/S6-1.jpg'),
          text('\n说明它写了什么'),
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: '复制消息' }))

    expect(writeText).toHaveBeenCalledWith('先看这张图：\n说明它写了什么')
    expect(screen.queryByRole('button', { name: '修改' })).toBeNull()
  })

  it('给了 onEdit 才有修改钮，editDisabled 时置灰', async () => {
    const onEdit = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<UserBubble content={[text('问')]} onEdit={onEdit} />)

    await user.click(screen.getByRole('button', { name: '修改' }))
    expect(onEdit).toHaveBeenCalledOnce()

    rerender(<UserBubble content={[text('问')]} editDisabled onEdit={onEdit} />)
    expect(screen.getByRole('button', { name: '修改' })).toBeDisabled()
  })

  it('图夹在两句话中间：芯片就画在那两句话中间，头部是这张图的缩略图', () => {
    const url = 'https://bkt.oss-cn-hangzhou.aliyuncs.com/u/S6-1.jpg'
    render(<UserBubble content={[text('先看这张图：'), image(url), text('\n说明它写了什么')]} />)

    // 芯片不再带文件名，位置看 DOM 次序
    const chip = screen.getByRole('button', { name: 'S6-1.jpg' })
    const before = screen.getByText('先看这张图：')
    const after = screen.getByText(/说明它写了什么/)
    expect(before.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(chip.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(chip.querySelector('img')?.getAttribute('src')).toBe(
      `${url}?x-oss-process=image/resize,l_64`,
    )
  })

  it('视频芯片：OSS 地址给首帧缩略图，其他来源画视频图标', () => {
    render(
      <UserBubble
        content={[
          video('https://bkt.oss-cn-hangzhou.aliyuncs.com/u/demo.mp4'),
          video('https://example.com/clip.mp4'),
        ]}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'demo.mp4' }).querySelector('img')?.getAttribute('src'),
    ).toContain('x-oss-process=video/snapshot')
    expect(screen.getByRole('button', { name: 'clip.mp4' }).querySelector('img')).toBeNull()
  })

  it('点图片芯片开灯箱，灯箱里是图', async () => {
    const user = userEvent.setup()
    render(<UserBubble content={[image('https://example.com/reference.png')]} />)

    await user.click(screen.getByRole('button', { name: 'reference.png' }))

    expect(screen.getByRole('dialog', { name: 'reference.png' })).toBeInTheDocument()
    // 芯片上那颗缩略图是装饰性的（alt 空），带名字的这张只能是灯箱里的
    expect(screen.getByRole('img', { name: 'reference.png' })).toBeInTheDocument()
  })

  it('点视频芯片开灯箱，灯箱里是能播的视频', async () => {
    const user = userEvent.setup()
    render(<UserBubble content={[video('https://example.com/clip.mp4')]} />)

    await user.click(screen.getByRole('button', { name: 'clip.mp4' }))

    const dialog = screen.getByRole('dialog', { name: 'clip.mp4' })
    expect(dialog.querySelector('video')).not.toBeNull()
  })
})

describe('UserBubble 媒体芯片的悬停卡', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** 走过 N 毫秒：卡的开合都是定时器落地的，要包在 act 里才算一次渲染。 */
  const advance = (ms: number) => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  /** 画一颗图片芯片。「刚关过一张就免延迟」是跨芯片的全局窗口，先走过它再开始量时序。 */
  const renderChip = () => {
    render(<UserBubble content={[image('https://example.com/reference.png')]} />)
    advance(500)
    return screen.getByRole('button', { name: 'reference.png' })
  }

  it('悬停 150ms 后出卡，离开 120ms 后收起', () => {
    const chip = renderChip()

    fireEvent.mouseEnter(chip)
    expect(screen.queryByRole('tooltip')).toBeNull()
    advance(150)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.mouseLeave(chip)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    advance(120)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('光标从芯片移进卡里，卡不收起', () => {
    const chip = renderChip()

    fireEvent.mouseEnter(chip)
    advance(150)
    fireEvent.mouseLeave(chip)
    fireEvent.mouseEnter(screen.getByRole('tooltip'))
    advance(500)

    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })
})

const turnWithFrames = (frames: TranscriptTurn['steps'][number]['frames']): TranscriptTurn => ({
  content: [text('先做开场镜头')],
  kind: 'turn',
  ordinal: 1,
  origin: { kind: 'user' },
  state: 'completed',
  steps: [
    {
      frames: [...frames],
      kind: 'step',
      ordinal: 1,
      state: 'completed',
      stepId: 't1.1',
      turnId: 't1',
    },
  ],
  turnId: 't1',
})

describe('ConversationTurn', () => {
  afterEach(() => vi.restoreAllMocks())

  it('已经有模型块时仍显示轮头部的开场输入', () => {
    render(
      <ConversationTurn
        turn={turnWithFrames([
          { frameId: 't1.1.f1', kind: 'thinking', text: '先分析素材' },
          { frameId: 't1.1.f2', kind: 'text', role: 'assistant', text: '已经完成。' },
        ])}
      />,
    )

    expect(screen.getByText('先做开场镜头')).toBeInTheDocument()
    expect(screen.getByText('已经完成。')).toBeInTheDocument()
  })

  it('开场输入与中途插话各自显示一次', () => {
    render(
      <ConversationTurn
        turn={turnWithFrames([
          {
            content: [text('再补一个特写')],
            frameId: 't1.1.f1',
            kind: 'text',
            role: 'user',
            text: '再补一个特写',
          },
          { frameId: 't1.1.f2', kind: 'text', role: 'assistant', text: '收到。' },
        ])}
      />,
    )

    expect(screen.getAllByText('先做开场镜头')).toHaveLength(1)
    expect(screen.getAllByText('再补一个特写')).toHaveLength(1)
  })

  it('只有一张图的开场输入也显示用户气泡', () => {
    render(
      <ConversationTurn
        turn={{ ...turnWithFrames([]), content: [image('https://example.com/reference.png')] }}
      />,
    )

    expect(screen.getByRole('button', { name: 'reference.png' })).toBeInTheDocument()
  })

  it('回复结束后复制最后一次用户输入之后的助手原始 markdown', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    render(
      <ConversationTurn
        turn={turnWithFrames([
          { frameId: 't1.1.f1', kind: 'text', role: 'assistant', text: '前一段回复' },
          {
            content: [text('再补一个结尾')],
            frameId: 't1.1.f2',
            kind: 'text',
            role: 'user',
            text: '再补一个结尾',
          },
          { frameId: 't1.1.f3', kind: 'thinking', text: '调整结构' },
          { frameId: 't1.1.f4', kind: 'text', role: 'assistant', text: '## 最终回复' },
          { frameId: 't1.1.f5', kind: 'text', role: 'assistant', text: '补充说明' },
        ])}
      />,
    )

    await user.click(screen.getByRole('button', { name: '复制' }))

    expect(writeText).toHaveBeenCalledWith('## 最终回复\n\n补充说明')
  })

  it('回复仍在输出时不显示复制按钮', () => {
    stubClipboard()
    render(
      <ConversationTurn
        turn={{
          ...turnWithFrames([
            { frameId: 't1.1.f1', kind: 'text', role: 'assistant', text: '还在输出' },
          ]),
          state: 'running',
        }}
      />,
    )

    expect(screen.queryByRole('button', { name: '复制' })).toBeNull()
  })
})

/** 一次出图调用：结果里给人看的那份是两张图。 */
const mediaFrame = (metadata: unknown) => ({
  display: { kind: 'generic' as const, summary: '出镜头帧' },
  frameId: 't1.1.f1',
  kind: 'tool' as const,
  metadata,
  name: 'generate_shot_frames',
  output: '出好了 2 张',
  state: 'done' as const,
  toolCallId: 'call_1',
  view: 'media_grid',
})

const TWO_ITEMS = {
  items: [
    { caption: 'S01 · 产品特写', url: 'https://example.com/a.png' },
    { caption: 'S02 · 场景全景', url: 'https://example.com/b.png' },
  ],
}

describe('工具结果按 view 选渲染器', () => {
  it('media_grid 在工具行下面画出每一张图与它的标题', () => {
    render(<ConversationTurn turn={turnWithFrames([mediaFrame(TWO_ITEMS)])} />)

    expect(screen.getAllByRole('figure')).toHaveLength(2)
    expect(screen.getByRole('img', { name: 'S01 · 产品特写' })).toBeInTheDocument()
    expect(screen.getByText('S02 · 场景全景')).toBeInTheDocument()
  })

  it('点一张图开灯箱', async () => {
    const user = userEvent.setup()
    render(<ConversationTurn turn={turnWithFrames([mediaFrame(TWO_ITEMS)])} />)

    await user.click(screen.getByRole('button', { name: 'S01 · 产品特写' }))

    expect(screen.getByRole('dialog', { name: 'S01 · 产品特写' })).toBeInTheDocument()
  })

  it('结果形状对不上就退回朴素行：没有图，纯文本结果照旧可以展开', async () => {
    const user = userEvent.setup()
    render(<ConversationTurn turn={turnWithFrames([mediaFrame({ items: 3 })])} />)

    expect(screen.queryByRole('figure')).toBeNull()
    await user.click(screen.getByRole('button', { name: /出镜头帧/ }))
    expect(screen.getByText('出好了 2 张')).toBeInTheDocument()
  })

  it('file_content 的纯文本结果可以展开', async () => {
    const user = userEvent.setup()
    render(
      <ConversationTurn
        turn={turnWithFrames([
          {
            display: { kind: 'file_io', operation: 'read', path: 'shots/storyboard.md' },
            frameId: 't1.1.f1',
            kind: 'tool',
            name: 'read_file',
            output: '# 分镜\n\nS01 产品特写',
            state: 'done',
            toolCallId: 'call_1',
            view: 'file_content',
          },
        ])}
      />,
    )

    await user.click(screen.getByRole('button', { name: /读文件/ }))

    expect(screen.getByText(/S01 产品特写/)).toBeInTheDocument()
  })

  it('画出图的那次调用不折进活动组：折起来图就跟着不见了', () => {
    render(
      <ConversationTurn
        turn={turnWithFrames([
          {
            display: { kind: 'file_io', operation: 'read', path: 'shots/storyboard.md' },
            frameId: 't1.1.f0',
            kind: 'tool',
            name: 'read_file',
            state: 'done',
            toolCallId: 'call_0',
          },
          mediaFrame(TWO_ITEMS),
        ])}
      />,
    )

    expect(screen.getAllByRole('figure')).toHaveLength(2)
    expect(screen.queryByText(/读取了 1 个文件/)).toBeNull()
  })
})
