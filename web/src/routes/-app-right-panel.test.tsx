import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { AppRightPanel } from './-app-right-panel'

describe('AppRightPanel', () => {
  it('路由没声明面板就什么都不画，也没有展开钮', async () => {
    await renderWithProviders(<AppRightPanel />)

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
