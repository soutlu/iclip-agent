import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMediaDurations } from './use-media-durations'

const CLIP = 'https://example.com/clip.mp4'
const UPSTREAM = 'https://example.com/upstream.mp4'

/** 数一数建了几个 `<video>`：探时长是唯一会建它的动作。 */
const countProbes = () => {
  const create = document.createElement.bind(document)
  const spy = vi.spyOn(document, 'createElement')
  spy.mockImplementation((tag: string) => create(tag))
  return () => spy.mock.calls.filter(([tag]) => tag === 'video').length
}

describe('useMediaDurations', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('后端已经量好的地址直接给出来，不再去探', () => {
    const probes = countProbes()
    const { result } = renderHook(() => useMediaDurations([CLIP], { [CLIP]: 4.213 }))

    expect(result.current[CLIP]).toBe(4.213)
    expect(probes()).toBe(0)
  })

  it('后端不知道的地址还要自己探', () => {
    const probes = countProbes()
    const { result } = renderHook(() => useMediaDurations([CLIP, UPSTREAM], { [CLIP]: 4.213 }))

    // 上游的地址没有已知时长，探它；jsdom 里元数据不会回来，所以表里还没有它。
    expect(probes()).toBe(1)
    expect(UPSTREAM in result.current).toBe(false)
  })
})
