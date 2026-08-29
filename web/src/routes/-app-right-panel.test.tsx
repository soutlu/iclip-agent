import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { AppRightPanel } from './-app-right-panel'

describe('AppRightPanel', () => {
  it('默认折叠为浮出展开钮，点开展开右面板', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<AppRightPanel />)

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '展开右侧面板' }))

    expect(screen.getByRole('complementary', { name: '右侧面板' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '面板' })).toBeVisible()
    expect(screen.getByText('还没有面板内容')).toBeVisible()
  })

  it('展开后可再折叠回浮出按钮', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<AppRightPanel />)

    await user.click(screen.getByRole('button', { name: '展开右侧面板' }))
    await user.click(screen.getByRole('button', { name: '折叠右侧面板' }))

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '展开右侧面板' })).toBeVisible()
  })
})
