/**
 * 用户气泡：超长折叠。
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@/shared/transcript/vendor'
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

describe('UserBubble', () => {
  let restore: (() => void) | undefined
  afterEach(() => restore?.())

  it('短消息不折叠，没有展开胶囊', () => {
    // jsdom 里元素高度是 0：量不出超高，自然不给入口
    render(<UserBubble text="就一句" />)
    expect(screen.queryByRole('button', { name: '展开' })).toBeNull()
  })

  it('超长消息折叠成渐隐，点「展开」放开全文', async () => {
    restore = stubOverflowing()
    const user = userEvent.setup()
    render(<UserBubble text={'一行长长的素材说明\n'.repeat(20)} />)

    // scrollHeight 500 > 240：量出超高才给入口
    const toggle = await screen.findByRole('button', { name: '展开' })
    await user.click(toggle)

    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument()
  })
})

const turnWithFrames = (frames: TranscriptTurn['steps'][number]['frames']): TranscriptTurn => ({
  kind: 'turn',
  ordinal: 1,
  origin: { kind: 'user' },
  prompt: '先做开场镜头',
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
        attachments={new Map()}
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
        attachments={new Map()}
        turn={turnWithFrames([
          { frameId: 't1.1.f1', kind: 'text', role: 'user', text: '再补一个特写' },
          { frameId: 't1.1.f2', kind: 'text', role: 'assistant', text: '收到。' },
        ])}
      />,
    )

    expect(screen.getAllByText('先做开场镜头')).toHaveLength(1)
    expect(screen.getAllByText('再补一个特写')).toHaveLength(1)
  })

  it('只有附件的开场输入也显示用户气泡', () => {
    render(
      <ConversationTurn
        attachments={
          new Map([
            [
              'att-1',
              {
                attachmentId: 'att-1',
                mediaType: 'image/png',
                name: '参考图.png',
                source: { kind: 'url', url: 'https://example.com/reference.png' },
              },
            ],
          ])
        }
        turn={{ ...turnWithFrames([]), attachmentIds: ['att-1'], prompt: '' }}
      />,
    )

    expect(screen.getByRole('button', { name: '参考图.png' })).toBeInTheDocument()
  })

  it('回复结束后复制最后一次用户输入之后的助手原始 markdown', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    render(
      <ConversationTurn
        attachments={new Map()}
        turn={turnWithFrames([
          { frameId: 't1.1.f1', kind: 'text', role: 'assistant', text: '前一段回复' },
          { frameId: 't1.1.f2', kind: 'text', role: 'user', text: '再补一个结尾' },
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
        attachments={new Map()}
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
