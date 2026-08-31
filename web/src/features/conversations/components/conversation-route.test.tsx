/**
 * 会话页：历史铺得出来，逐字来的内容跟着长。
 */

import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { renderWithProviders } from '@/testing/render'
import { ConversationRoute } from './conversation-route'

const TAIL_TEXT = '这是第 2 轮的回复。'

class FakeSocket {
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  send(): void {}

  close(): void {
    this.readyState = 3
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const HELLO = {
  payload: { heartbeat_ms: 10_000, protocol_version: 2, ws_connection_id: 'w1' },
  type: 'server_hello',
}

/** 渲染会话页，连接用假 socket；返回那个 socket 以便往里灌帧。 */
const renderConversation = async () => {
  const socket = new FakeSocket()
  const view = await renderWithProviders(
    <TranscriptProvider createSocket={() => socket as unknown as WebSocket}>
      <ConversationRoute conversationId="c1" />
    </TranscriptProvider>,
  )
  socket.deliver(HELLO)
  return { ...view, socket }
}

describe('ConversationRoute', () => {
  it('把历史那几轮铺开：用户那条、模型那条、工具卡', async () => {
    await renderConversation()

    expect(await screen.findByText('第 1 个问题')).toBeInTheDocument()
    expect(screen.getByText(TAIL_TEXT)).toBeInTheDocument()
    // 工具卡认的是服务端给的 display，不是工具名——工具名不上界面。
    expect(screen.getByText('读文件')).toBeInTheDocument()
    expect(screen.getByText('shots/storyboard.md')).toBeInTheDocument()
    expect(screen.queryByText('read_file')).not.toBeInTheDocument()
  })

  it('逐字追加接在同一块上，不另起一段', async () => {
    const { socket } = await renderConversation()
    await screen.findByText(TAIL_TEXT)

    socket.deliver({
      payload: {
        agent_id: 'main',
        ops: [
          {
            offset: TAIL_TEXT.length,
            op: 'append',
            target: { frameId: 't2.1.f3', stepId: 't2.1', turnId: 't2', type: 'frame' },
            text: '再补一句。',
          },
        ],
        seq: 11,
      },
      session_id: 'c1',
      type: 'transcript.ops',
    })

    expect(await screen.findByText(`${TAIL_TEXT}再补一句。`)).toBeInTheDocument()
  })
})
