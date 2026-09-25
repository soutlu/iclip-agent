/** 瀑布流的几何：列数、卡片预估高度、封面截帧宽度。虚拟列表按这里的预估分列，预估准了布局就不跳。 */

import type { LibraryVideo } from './library.api'
import { aspectOf } from './library-media'

/** 容器宽度对应的列数；宽度未知（0）时按最少的两列。 */
export const columnCountFor = (width: number): number => {
  if (width >= 1380) return 5
  if (width >= 1060) return 4
  if (width >= 700) return 3
  return 2
}

/** 列间距：窄屏收紧。 */
export const columnGapFor = (width: number): number => (width < 700 ? 10 : 16)

/** 画面下方标题两行加作者一行的高度。 */
const CARD_BODY_HEIGHT = 68

export const cardHeightFor = (video: LibraryVideo, columnWidth: number): number => {
  const { w, h } = aspectOf(video.take.aspectRatio)
  return (columnWidth * h) / w + CARD_BODY_HEIGHT
}

/** 截帧宽度按显示宽度乘像素密度，向上取到几档固定宽，同一张图在不同列宽下能命中缓存。 */
const SNAPSHOT_WIDTHS = [240, 360, 480, 640, 720] as const

export const snapshotWidthFor = (cssWidth: number, pixelRatio: number): number => {
  const wanted = cssWidth * Math.min(pixelRatio, 2)
  return SNAPSHOT_WIDTHS.find((width) => width >= wanted) ?? SNAPSHOT_WIDTHS.at(-1) ?? 720
}
