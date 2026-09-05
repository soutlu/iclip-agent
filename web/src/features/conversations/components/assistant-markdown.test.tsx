import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantMarkdown } from './assistant-markdown'

const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return writeText
}

describe('AssistantMarkdown 代码块', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fenced 代码块带头部条：语言名，点复制把原文写进剪贴板', async () => {
    // userEvent.setup 会替换剪贴板，断言用替身须随后安装。
    const user = userEvent.setup()
    const writeText = stubClipboard()
    render(<AssistantMarkdown text={'```json\n{\n  "shots": 3\n}\n```\n'} />)

    expect(screen.getByText('json')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '复制代码' }))

    expect(writeText).toHaveBeenCalledWith('{\n  "shots": 3\n}\n')
  })

  it('没有语言标记的代码块，头部条写作 text', () => {
    stubClipboard()
    render(<AssistantMarkdown text={'```\n纯文本\n```\n'} />)
    expect(screen.getByText('text')).toBeInTheDocument()
  })

  it('块内文字是纯文本，不套行内代码的底色；段落里的行内代码才有', () => {
    stubClipboard()
    const { container } = render(
      <AssistantMarkdown text={'```\n第一行\n第二行\n```\n\n写进 `shots/storyboard.md`\n'} />,
    )
    expect(container.querySelector('pre code')).toBeNull()
    expect(container.querySelector('pre')).toHaveTextContent('第一行 第二行')
    expect(container.querySelector('p code')).toHaveClass('bg-chat-code-bg')
  })
})
