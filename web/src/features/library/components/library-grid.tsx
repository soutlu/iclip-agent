/** 瀑布流：TanStack Virtual 的多列（lanes）虚拟列表，只渲染视口附近的卡片；列数随容器宽度变。 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { LibraryVideo } from '../library.api'
import { cardHeightFor, columnCountFor, columnGapFor } from '../library-layout'
import { LibraryCard } from './library-card'

/** 同一列里上下两张卡的间距。 */
const ROW_GAP = 20

/** 首帧还没量到容器时按这个视口估，jsdom 里也靠它渲染出卡片。 */
const INITIAL_RECT = { height: 900, width: 1200 }

type LibraryGridProps = {
  videos: readonly LibraryVideo[]
  /** 页面的滚动容器；虚拟列表跟着它的滚动位置算哪些卡在视口里。 */
  getScrollElement: () => HTMLElement | null
  onAuthor: (userName: string) => void
}

export function LibraryGrid({ videos, getScrollElement, onAuthor }: LibraryGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { width, offsetTop } = useContainerBox(containerRef, getScrollElement)
  const lanes = columnCountFor(width)
  const gap = columnGapFor(width)
  const columnWidth = width > 0 ? (width - gap * (lanes - 1)) / lanes : 0

  // eslint-disable-next-line react-hooks/incompatible-library -- 虚拟列表的方法随滚动变化，编译器跳过这个组件正是需要的
  const virtualizer = useVirtualizer({
    count: videos.length,
    estimateSize: (index) => {
      const video = videos[index]
      return video === undefined ? 0 : cardHeightFor(video, columnWidth)
    },
    gap: ROW_GAP,
    getItemKey: (index) => videos[index]?.id ?? index,
    getScrollElement,
    initialRect: INITIAL_RECT,
    lanes,
    overscan: 6,
    scrollMargin: offsetTop,
  })

  // 列宽一变，按新列宽重估全部卡片的高度并重新分列。
  useLayoutEffect(() => {
    virtualizer.measure()
  }, [virtualizer, lanes, columnWidth])

  return (
    <div
      className="relative w-full"
      ref={containerRef}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const video = videos[item.index]
        if (video === undefined) return null
        return (
          <div
            className="absolute top-0"
            data-index={item.index}
            key={item.key}
            ref={virtualizer.measureElement}
            style={{
              left: item.lane * (columnWidth + gap),
              transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
              width: columnWidth,
            }}
          >
            <LibraryCard onAuthor={onAuthor} video={video} width={columnWidth} />
          </div>
        )
      })}
    </div>
  )
}

/** 容器宽度与它在滚动容器里的纵向偏移；宽度变了（筛选条换行、侧栏收起）两者一起重量。 */
function useContainerBox(
  containerRef: RefObject<HTMLDivElement | null>,
  getScrollElement: () => HTMLElement | null,
): { width: number; offsetTop: number } {
  const [box, setBox] = useState({ offsetTop: 0, width: 0 })

  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const measure = () => {
      const scroller = getScrollElement()
      const top = container.getBoundingClientRect().top
      const offsetTop =
        scroller === null ? 0 : top - scroller.getBoundingClientRect().top + scroller.scrollTop
      const width = container.clientWidth
      setBox((old) =>
        old.width === width && old.offsetTop === offsetTop ? old : { offsetTop, width },
      )
    }
    // ResizeObserver 开始观察时就回调一次，在首帧绘制前量到初值。
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, getScrollElement])

  return box
}

/** 几种常见画幅轮着占位，和真卡同一个节奏。 */
const SKELETONS = [
  { id: 'a', ratio: '9 / 16' },
  { id: 'b', ratio: '3 / 4' },
  { id: 'c', ratio: '9 / 16' },
  { id: 'd', ratio: '16 / 9' },
  { id: 'e', ratio: '9 / 16' },
  { id: 'f', ratio: '4 / 5' },
  { id: 'g', ratio: '9 / 16' },
  { id: 'h', ratio: '3 / 4' },
] as const

/** 读取中的占位：CSS 多列排几张灰卡，读屏只读到 label。 */
export function LibraryGridSkeleton({ label }: { label: string }) {
  return (
    <div className="library-skeleton-grid" role="status">
      <span className="sr-only">{label}</span>
      {SKELETONS.map(({ id, ratio }) => (
        <div
          aria-hidden="true"
          className="mb-5 flex break-inside-avoid flex-col gap-2 motion-safe:animate-pulse"
          key={id}
        >
          <div className="rounded-md bg-surface-container-low" style={{ aspectRatio: ratio }} />
          <div className="h-3 w-4/5 rounded-xs bg-surface-container-low" />
          <div className="h-3 w-1/2 rounded-xs bg-surface-container-low" />
        </div>
      ))}
    </div>
  )
}
