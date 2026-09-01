/**
 * 用户气泡：超长折叠。
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
