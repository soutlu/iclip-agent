import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import './editor-composer.css'

export type EditorReference = { id: string; name: string; url: string }

type EditorComposerProps = {
  prompt: string
  onPromptChange: (value: string) => void
  references: readonly EditorReference[]
  onReferencesChange: (references: EditorReference[]) => void
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_IMAGE_SIZE = 10 * 1024 * 1024

/** 参考图仅在浏览器内读取，编辑原型不发起上传。 */
function readReference(file: File): Promise<EditorReference> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('图片读取失败'))
        return
      }
      resolve({ id: crypto.randomUUID(), name: file.name, url: reader.result })
    }
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onabort = () => reject(new Error('图片读取已取消'))
    reader.readAsDataURL(file)
  })
}

export function EditorComposer({
  prompt,
  onPromptChange,
  references,
  onReferencesChange,
}: EditorComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const referencesRef = useRef(references)
  const [preview, setPreview] = useState<EditorReference | null>(null)
  const [reading, setReading] = useState(0)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    referencesRef.current = references
  }, [references])

  const changeReferences = (next: EditorReference[]) => {
    referencesRef.current = next
    onReferencesChange(next)
  }

  const addFiles = async (files: readonly File[]) => {
    const valid = files.filter((file) => {
      if (!IMAGE_TYPES.has(file.type)) {
        toast.error('请选择 PNG、JPEG、WebP 或 GIF 图片')
        return false
      }
      if (file.size > MAX_IMAGE_SIZE) {
        toast.error('每张参考图片不能超过 10 MB')
        return false
      }
      if (file.size === 0) {
        toast.error('图片文件为空，请重新选择')
        return false
      }
      return true
    })
    if (valid.length === 0) return
    setReading((count) => count + valid.length)
    const results = await Promise.allSettled(valid.map(readReference))
    const added: EditorReference[] = []
    for (const result of results) {
      if (result.status === 'fulfilled') added.push(result.value)
      else toast.error('参考图片读取失败，请重新选择')
    }
    // 文件读取期间仍可移除已有参考图；以最新列表追加，避免恢复已移除的图片。
    if (added.length > 0) changeReferences([...referencesRef.current, ...added])
    setReading((count) => count - valid.length)
  }

  return (
    <div
      className={cn('video-editor-composer', dragging && 'video-editor-composer-dragging')}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragging(false)
        void addFiles([...event.dataTransfer.files])
      }}
      onPaste={(event) => {
        const images = [...event.clipboardData.files].filter((file) =>
          file.type.startsWith('image/'),
        )
        if (images.length === 0) return
        event.preventDefault()
        void addFiles(images)
      }}
    >
      <textarea
        aria-label="修改要求"
        className="video-editor-composer-input text-body text-on-surface"
        onChange={(event) => onPromptChange(event.target.value)}
        placeholder="描述你想修改的画面…"
        value={prompt}
      />
      <div aria-label="参考图片" className="video-editor-composer-references" role="group">
        {references.map((reference) => (
          <div className="video-editor-composer-reference" key={reference.id}>
            <button
              aria-label={`预览参考图 ${reference.name}`}
              className="video-editor-composer-photo ui-focus"
              onClick={() => setPreview(reference)}
              type="button"
            >
              <img alt={reference.name} draggable={false} src={reference.url} />
            </button>
            <IconButton
              className="video-editor-composer-remove"
              label={`移除参考图 ${reference.name}`}
              name="close"
              onClick={() =>
                changeReferences(referencesRef.current.filter((item) => item.id !== reference.id))
              }
              size="xs"
            />
          </div>
        ))}
        <button
          aria-busy={reading > 0}
          aria-label={reading > 0 ? '正在读取参考图片' : '添加参考图片'}
          className="video-editor-composer-add hit-48 ui-focus"
          disabled={reading > 0}
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          <Icon
            className={cn(reading > 0 && 'animate-spin')}
            decorative
            name={reading > 0 ? 'loading' : 'add'}
            size="md"
          />
        </button>
      </div>
      <input
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label="选择参考图片"
        className="hidden"
        multiple
        onChange={(event) => {
          void addFiles([...(event.target.files ?? [])])
          event.target.value = ''
        }}
        ref={inputRef}
        type="file"
      />
      <MediaLightbox
        media={preview === null ? null : { kind: 'image', ...preview }}
        onClose={() => setPreview(null)}
      />
    </div>
  )
}
