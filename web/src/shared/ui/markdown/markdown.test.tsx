import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from './markdown'

const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return writeText
}

describe('Markdown 代码块', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fenced 代码块带头部条：语言名，点复制把原文写进剪贴板', async () => {
    // userEvent.setup 会替换剪贴板，断言用替身须随后安装。
    const user = userEvent.setup()
    const writeText = stubClipboard()
    render(<Markdown text={'```json\n{\n  "shots": 3\n}\n```\n'} />)

    expect(screen.getByText('json')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '复制代码' }))

    expect(writeText).toHaveBeenCalledWith('{\n  "shots": 3\n}\n')
  })

  it('没有语言标记的代码块，头部条写作 text', () => {
    stubClipboard()
    render(<Markdown text={'```\n纯文本\n```\n'} />)
    expect(screen.getByText('text')).toBeInTheDocument()
  })

  it('混合代码块与行内代码时保留两处原文', () => {
    render(<Markdown text={'```\n第一行\n第二行\n```\n\n写进 `shots/storyboard.md`\n'} />)
    expect(screen.getByText('第一行 第二行')).toBeVisible()
    expect(screen.getByText('shots/storyboard.md')).toBeVisible()
  })

  it('GFM 表格渲染成表头与单元格', () => {
    render(<Markdown text={'| 结构 | 出场 |\n| :--- | :--- |\n| Open Hook | 女模特 |\n'} />)
    expect(screen.getByRole('columnheader', { name: '结构' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Open Hook' })).toBeInTheDocument()
  })
})
