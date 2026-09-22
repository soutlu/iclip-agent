import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { MediaFallback } from './media-fallback'

describe('MediaFallback', () => {
  it.each([
    { expected: '图片加载失败', kind: 'image' },
    { expected: '视频加载失败', kind: 'video' },
  ] as const)('$kind 的主句是「$expected」', async ({ expected, kind }) => {
    await renderWithProviders(<MediaFallback kind={kind} />)
    expect(screen.getByText(expected)).toBeVisible()
  })

  it('hint 作为第二句留在主句旁边', async () => {
    await renderWithProviders(<MediaFallback hint="点击打开预览" kind="video" />)
    expect(screen.getByText('视频加载失败')).toBeVisible()
    expect(screen.getByText('点击打开预览')).toBeVisible()
  })

  it('compact 同样保留 hint', async () => {
    await renderWithProviders(<MediaFallback compact hint="请关闭后重试" kind="image" />)
    expect(screen.getByText('图片加载失败')).toBeVisible()
    expect(screen.getByText('请关闭后重试')).toBeVisible()
  })

  it('没有 onRetry 就不出重试按钮', async () => {
    await renderWithProviders(<MediaFallback kind="image" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('点重试调用回调', async () => {
    const onRetry = vi.fn()
    await renderWithProviders(<MediaFallback kind="video" onRetry={onRetry} />)
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('不自己做播报，由调用点的外壳决定', async () => {
    await renderWithProviders(<MediaFallback kind="image" />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
