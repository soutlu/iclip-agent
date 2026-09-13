import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/shared/ui/tooltip'
import { StatusBadge, type StatusBadgeProps } from './status-badge'

const renderBadge = (props: StatusBadgeProps) =>
  render(
    <TooltipProvider>
      <StatusBadge {...props} />
    </TooltipProvider>,
  )

describe('StatusBadge', () => {
  it.each([
    { kind: 'conversation', status: 'idle' },
    { kind: 'video', status: 'idle' },
  ] as const)('$kind 的 idle 不渲染', (props) => {
    const { container } = renderBadge(props)
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    { expected: '等待审批', kind: 'conversation', status: 'approval' },
    { expected: '等待回答', kind: 'conversation', status: 'question' },
    { expected: '视频生成中', kind: 'video', status: 'running' },
    { expected: '图片排队中', kind: 'image', status: 'queued' },
  ] as const)('纯图标以「$expected」命名，媒体类带种类前缀', ({ expected, ...props }) => {
    renderBadge(props)
    expect(screen.getByRole('img', { name: expected })).toBeVisible()
  })

  it('带文字以可见文字命名，可用 text 覆盖默认文案', () => {
    renderBadge({ appearance: 'label', kind: 'image', status: 'completed', text: '有新结果' })
    expect(screen.getByText('有新结果')).toBeVisible()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('纯图标悬停出浮层，说明写在名字下面', async () => {
    renderBadge({ detail: '完成后会更新结果', kind: 'video', status: 'running' })
    await userEvent.hover(screen.getByRole('img', { name: '视频生成中' }))
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('视频生成中')
    expect(tooltip).toHaveTextContent('完成后会更新结果')
  })

  it('带文字没有 detail 时不挂浮层', async () => {
    renderBadge({ appearance: 'label', kind: 'conversation', status: 'failed' })
    await userEvent.hover(screen.getByText('上次失败'))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
