import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeroAnimation } from './hero-animation'

const EXPAND = '展开鞋盒，展示鞋履与服装'
const COLLAPSE = '收起鞋盒'

const stubReducedMotion = (matches: boolean) => {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: query.includes('prefers-reduced-motion') && matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HeroAnimation', () => {
  it('内联 SVG 并默认收起，鼠标悬停展开、移开收起', () => {
    render(<HeroAnimation />)
    const trigger = screen.getByRole('button', { name: EXPAND })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger.querySelector('svg [data-cue-node]')).not.toBeNull()

    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAccessibleName(COLLAPSE)

    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('点击固定展开，移开不收起，再点或 Escape 收起', async () => {
    const user = userEvent.setup()
    render(<HeroAnimation />)
    const trigger = screen.getByRole('button', { name: EXPAND })

    await user.click(trigger)
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard('{Escape}')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('触屏的悬停事件不触发展开', () => {
    render(<HeroAnimation />)
    const trigger = screen.getByRole('button', { name: EXPAND })
    fireEvent.pointerEnter(trigger, { pointerType: 'touch' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('系统减少动态效果时定格在展开态', () => {
    stubReducedMotion(true)
    render(<HeroAnimation />)
    expect(screen.getByRole('button', { name: COLLAPSE })).toHaveAttribute('aria-expanded', 'true')
  })
})
