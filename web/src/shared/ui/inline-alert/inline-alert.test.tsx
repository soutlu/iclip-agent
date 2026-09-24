import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { InlineAlert } from './inline-alert'

describe('InlineAlert', () => {
  it('消息以 alert 播报', async () => {
    await renderWithProviders(<InlineAlert message="模型清单读取失败" />)
    expect(screen.getByRole('alert')).toHaveTextContent('模型清单读取失败')
  })

  it('没有 action 就只有文字', async () => {
    await renderWithProviders(<InlineAlert message="读不到编辑结果的时长" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('action 渲染成按钮并回调', async () => {
    const onClick = vi.fn()
    await renderWithProviders(
      <InlineAlert action={{ label: '重新加载模型', onClick }} message="模型清单读取失败" />,
    )
    await userEvent.click(screen.getByRole('button', { name: '重新加载模型' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
