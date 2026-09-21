import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import type { Task } from '../tasks.api'

type TaskProduct = Task['inputs']['products'][number]
const imageLabel = (product: TaskProduct) => `${product.name.trim() || product.style_no} 商品图`

/** 封面始终取第一款有商品图的首图，不用参考图替代商品。 */
export function TaskCardMedia({ products }: { products: TaskProduct[] }) {
  const cover = products.find((product) => product.image_oss_urls.length > 0)
  return (
    <span className="task-card-media relative block w-full overflow-hidden rounded-md bg-surface-container-low">
      <ProductImage
        alt={cover ? imageLabel(cover) : '需求单商品图'}
        src={cover?.image_oss_urls[0]}
      />
    </span>
  )
}

/** 滚动控件与打开详情的按钮平级，避免按钮嵌套和滚动时误开详情。 */
export function TaskCardReferences({
  inputs,
  onOpen,
}: {
  inputs: Task['inputs']
  onOpen: () => void
}) {
  const stripRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ previous: false, next: false })
  const cover = inputs.products.find((product) => product.image_oss_urls.length > 0)
    ?.image_oss_urls[0]
  const images = [
    ...inputs.products.flatMap((product) =>
      product.image_oss_urls.map((src) => ({ src, alt: imageLabel(product) })),
    ),
    ...inputs.reference_image_oss_urls.model.map((src) => ({ src, alt: '模特参考图' })),
    ...inputs.reference_image_oss_urls.outfit.map((src) => ({ src, alt: '穿搭参考图' })),
    ...inputs.reference_image_oss_urls.prop.map((src) => ({ src, alt: '道具参考图' })),
  ].filter(
    (image, index, all) =>
      image.src !== cover && all.findIndex((other) => other.src === image.src) === index,
  )

  const updateEdges = () => {
    const element = stripRef.current
    if (!element) return
    const previous = element.scrollLeft > 1
    const next = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
    setEdges((old) => (old.previous === previous && old.next === next ? old : { previous, next }))
  }
  useEffect(() => {
    const element = stripRef.current
    if (!element) return
    const observer = new ResizeObserver(updateEdges)
    observer.observe(element)
    return () => observer.disconnect()
  }, [images.length])

  const scroll = (direction: number) => {
    const element = stripRef.current
    if (!element) return
    element.scrollBy({
      left: direction * element.clientWidth,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    })
  }

  if (!images.length) return null
  return (
    <div className="task-card-references absolute right-1 left-1 flex items-center gap-1 rounded-sm bg-scrim/45 p-1 backdrop-blur-sm">
      {edges.previous && (
        <IconButton
          className="shrink-0 text-on-scrim"
          label="向左滚动参考图"
          name="back"
          size="xs"
          onClick={() => scroll(-1)}
        />
      )}
      <div
        aria-label="商品与参考图"
        className="task-card-reference-strip flex min-w-0 flex-1 gap-1 overflow-x-auto overscroll-x-contain"
        onScroll={updateEdges}
        ref={stripRef}
      >
        {images.map((image) => (
          <button
            key={image.src}
            aria-label={`打开需求详情：${image.alt}`}
            className="h-7 shrink-0 cursor-pointer overflow-hidden rounded-xs bg-surface-container-low ui-focus"
            onClick={onOpen}
            type="button"
          >
            <ProductImage alt={image.alt} compact src={image.src} onLoad={updateEdges} />
          </button>
        ))}
      </div>
      {edges.next && (
        <IconButton
          className="shrink-0 text-on-scrim"
          label="向右滚动参考图"
          name="next"
          size="xs"
          onClick={() => scroll(1)}
        />
      )}
    </div>
  )
}

function ProductImage({
  alt,
  compact = false,
  src,
  onLoad,
}: {
  alt: string
  compact?: boolean
  src: string | undefined
  onLoad?: (() => void) | undefined
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const failed = src !== undefined && failedSrc === src

  if (!src || failed) {
    const message = failed ? '商品图加载失败' : '暂无商品图'
    return (
      <span
        aria-label={`${alt}，${message}`}
        className={cn(
          'flex size-full items-center justify-center text-on-surface-variant',
          compact ? 'gap-1' : 'flex-col gap-2',
        )}
        role="img"
        title={message}
      >
        <Icon decorative name="image" size={compact ? 'sm' : 'xl'} />
        <span className={compact ? 'text-caption' : 'text-body-sm'}>
          {compact ? '无图' : '暂无商品图'}
        </span>
        {failed && !compact && <span className="text-caption">图片加载失败</span>}
      </span>
    )
  }

  return (
    <img
      alt={alt}
      className={compact ? 'task-card-reference-image object-contain' : 'size-full object-cover'}
      decoding="async"
      loading="lazy"
      onLoad={onLoad}
      onError={() => setFailedSrc(src)}
      src={src}
    />
  )
}
