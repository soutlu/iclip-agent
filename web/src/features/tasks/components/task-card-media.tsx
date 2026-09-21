import { useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import type { Task } from '../tasks.api'

type TaskProduct = Task['inputs']['products'][number]

const imageLabel = (product: TaskProduct) => `${product.name.trim() || product.style_no} 商品图`

/** 封面按款式顺序取第一款有商品图的首图；缩略图保留前三款的原始顺序。 */
export function TaskCardMedia({ products }: { products: TaskProduct[] }) {
  const cover = products.find((product) => product.image_oss_urls.length > 0)
  const multiple = products.length > 1

  return (
    <span className="relative block aspect-square w-full overflow-hidden rounded-t-md bg-surface-container-low">
      <span className="absolute inset-0">
        <ProductImage
          alt={cover ? imageLabel(cover) : '需求单商品图'}
          src={cover?.image_oss_urls[0]}
        />
      </span>
      {multiple && (
        <>
          <span className="absolute top-3 left-3 rounded-sm bg-surface-container-lowest px-2 py-1 text-body-sm font-medium text-on-surface">
            {products.length} 款
          </span>
          <span className="absolute right-3 bottom-3 left-3 flex gap-2">
            {products.slice(0, 3).map((product) => (
              <span
                className="block h-10 w-16 min-w-0 overflow-hidden rounded-sm bg-surface-container-lowest p-1"
                key={product.style_no}
              >
                <ProductImage alt={imageLabel(product)} compact src={product.image_oss_urls[0]} />
              </span>
            ))}
            {products.length > 3 && (
              <span
                aria-label={`另有 ${products.length - 3} 款商品`}
                className="grid size-10 shrink-0 place-items-center rounded-sm bg-surface-container-lowest text-body font-medium text-on-surface"
              >
                +{products.length - 3}
              </span>
            )}
          </span>
        </>
      )}
    </span>
  )
}

function ProductImage({
  alt,
  compact = false,
  src,
}: {
  alt: string
  compact?: boolean
  src: string | undefined
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
      className="size-full object-contain"
      decoding="async"
      loading="lazy"
      onError={() => setFailedSrc(src)}
      src={src}
    />
  )
}
