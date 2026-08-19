import { useRef, type ChangeEvent } from 'react'
import StoryboardIcon from '@/features/storyboards/components/storyboard-icon'
import type { ComposerFileAttachment } from '@/shared/composer'
import { EditorReferenceIcon } from '@/shared/editor'

interface StoryboardReferenceImageTrayProps {
  disabled?: boolean
  images: ComposerFileAttachment[]
  onFilesSelected: (files: File[]) => void
  onRemove: (attachmentId: string) => void
}

/**
 * 在修改指令顶部展示紧凑图片附件 tray。
 *
 * @param props - 当前图片、文件接入回调、删除回调与禁用状态。
 * @returns 共享引用图标和等高图片 chip 组成的附件管理区域。
 */
export default function StoryboardReferenceImageTray({
  disabled = false,
  images,
  onFilesSelected,
  onRemove,
}: StoryboardReferenceImageTrayProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * 把文件 input 的当前选择交给统一图片接入流程，并允许再次选择同一文件。
   *
   * @param event - 文件 input change 事件。
   * @returns 无返回值；异步错误由文件接入边界显式写入页面状态。
   */
  const selectFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    onFilesSelected(files)
  }

  return (
    <div className="storyboards-reference-images-viewport" aria-busy={disabled}>
      <ul className="storyboards-reference-images" aria-label="参考图片">
        {images.map((image) => (
          <li key={image.id} className="storyboards-reference-image-chip">
            <img src={image.thumbnailUrl ?? image.url} alt={image.name} />
            <span className="storyboards-reference-image-type" aria-hidden="true">
              <EditorReferenceIcon kind="image" size={8} title="图片" />
            </span>
            <button
              type="button"
              className="storyboards-reference-image-remove"
              aria-label={`移除参考图片：${image.name}`}
              onClick={() => onRemove(image.id)}
            >
              <StoryboardIcon name="reference-close" size={7} title="移除参考图片" />
            </button>
          </li>
        ))}
        <li className="storyboards-reference-image-add-item">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            disabled={disabled}
            multiple
            hidden
            onChange={selectFiles}
          />
          <button
            type="button"
            className="storyboards-reference-image-add"
            aria-label="添加参考图片"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <StoryboardIcon name="reference-add" size={9} title="添加参考图片" />
            <span>添加</span>
          </button>
        </li>
      </ul>
    </div>
  )
}
