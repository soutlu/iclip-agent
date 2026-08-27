import { useQueries } from '@tanstack/react-query'
import { useState } from 'react'
import { getProductInfo } from '@/features/tasks/api/video-task.api'
import { Icon } from '@/shared/icons'
import type { MediaPreviewItem } from '@/shared/ui/media'
import TaskPickerDialog, { togglePicked } from './task-picker-dialog'

export type PickedProductImage = {
  id: string
  styleNo: string
  url: string
}

type TaskErpImagePickerDialogProps = {
  onChange: (images: PickedProductImage[]) => void
  onClose: () => void
  onPreview: (preview: MediaPreviewItem) => void
  pickedImages: PickedProductImage[]
  styleNos: string[]
}

/**
 * 按需加载的 ERP 产品图选择器。弹层关闭后由父组件保留已选图片，主页面不常驻大型图库。
 */
export default function TaskErpImagePickerDialog({
  onChange,
  onClose,
  onPreview,
  pickedImages,
  styleNos,
}: TaskErpImagePickerDialogProps) {
  const [colorFilterByStyle, setColorFilterByStyle] = useState<Record<string, string>>({})
  const productQueries = useQueries({
    queries: styleNos.map((styleNo) => ({
      queryFn: ({ signal }: { signal: AbortSignal }) => getProductInfo(styleNo, { signal }),
      queryKey: ['video-task-product-info', styleNo],
      staleTime: 5 * 60 * 1000,
    })),
  })

  return (
    <TaskPickerDialog
      countNoun="图片"
      countUnit="张"
      description="从 Style 对应的产品图库中多选参考图"
      selectedCount={pickedImages.length}
      title="ERP图片"
      onClose={onClose}
    >
      {styleNos.map((styleNo, index) => {
        const query = productQueries[index]
        if (!query) {
          return null
        }
        const colors = query.data
          ? [...new Set(query.data.images.flatMap((image) => (image.color ? [image.color] : [])))]
          : []
        const activeColor = colorFilterByStyle[styleNo]
        const visibleImages =
          query.data?.images.filter(
            (image) => activeColor === undefined || image.color === activeColor,
          ) ?? []

        return (
          <section className="home-task-product-image-group" key={styleNo}>
            <h4>{styleNo} 产品图</h4>
            {query.isLoading ? <p className="home-task-materials-state">正在加载产品图…</p> : null}
            {query.error ? (
              <p className="home-task-materials-state home-task-materials-state--error">
                {query.error.message}
              </p>
            ) : null}
            {colors.length > 1 ? (
              <div
                aria-label={`${styleNo} 产品图颜色筛选`}
                className="home-task-color-filter"
                role="group"
              >
                <button
                  aria-pressed={activeColor === undefined}
                  className="home-task-color-chip"
                  type="button"
                  onClick={() => setColorFilterByStyle(({ [styleNo]: _cleared, ...rest }) => rest)}
                >
                  全部
                </button>
                {colors.map((color) => (
                  <button
                    aria-pressed={activeColor === color}
                    className="home-task-color-chip"
                    key={color}
                    type="button"
                    onClick={() =>
                      setColorFilterByStyle((filters) => ({ ...filters, [styleNo]: color }))
                    }
                  >
                    {color}
                  </button>
                ))}
              </div>
            ) : null}
            {query.data ? (
              <div
                aria-label={`${styleNo} 产品图`}
                className="home-task-product-image-grid"
                role="group"
              >
                {visibleImages.map((image) => (
                  <div className="home-task-product-image-cell" key={image.id}>
                    <button
                      aria-label={`产品图 ${image.id}`}
                      aria-pressed={pickedImages.some((pick) => pick.url === image.url)}
                      className="home-task-product-image-option"
                      type="button"
                      onClick={() =>
                        onChange(
                          togglePicked(
                            pickedImages,
                            { id: image.id, styleNo, url: image.url },
                            (pick) => pick.url,
                          ),
                        )
                      }
                    >
                      <img alt={`${styleNo} 产品图 ${image.id}`} loading="lazy" src={image.url} />
                      <span aria-hidden="true" className="home-task-material-check">
                        <Icon decorative name="check" size="xs" />
                      </span>
                    </button>
                    <button
                      aria-label={`预览产品图 ${image.id}`}
                      className="home-task-image-zoom"
                      title="查看大图"
                      type="button"
                      onClick={() =>
                        onPreview({
                          fileName: [styleNo, image.color, `产品图 ${image.id}`]
                            .filter(Boolean)
                            .join(' '),
                          mediaType: 'image',
                          url: image.url,
                        })
                      }
                    >
                      <Icon decorative name="zoom" size="xs" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        )
      })}
    </TaskPickerDialog>
  )
}
