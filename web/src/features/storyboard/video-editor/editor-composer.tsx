/** 修改要求输入框：正文、参考图与页脚（模型、生成）合在一个白框里。参考图选了就直传对象存储。 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MEDIA_IMAGE_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { hasDraggedFiles } from '@/shared/lib/drag-files'
import { cn } from '@/shared/lib/utils'
import { mintUuid } from '@/shared/lib/uuid'
import { IconButton } from '@/shared/ui/button'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import { MAX_EDIT_REFERENCES } from '../image-edit/image-edit-draft'
import './editor-composer.css'

export type EditorReference = { id: string; label: string; url: string }

type EditorComposerProps = {
  prompt: string
  footer?: ReactNode
  disabled: boolean
  onPromptChange: (value: string) => void
  references: readonly EditorReference[]
  onReferencesChange: (references: EditorReference[]) => void
  onBusyChange: (busy: boolean) => void
}

export function EditorComposer({
  prompt,
  footer,
  disabled,
  onPromptChange,
  references,
  onReferencesChange,
  onBusyChange,
}: EditorComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const referencesRef = useRef(references)
  useEffect(() => {
    referencesRef.current = references
  }, [references])
  const [preview, setPreview] = useState<EditorReference | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const locked = disabled || uploading

  const addFiles = async (files: readonly File[]) => {
    if (locked || files.length === 0) return
    if (files.length + referencesRef.current.length > MAX_EDIT_REFERENCES) {
      toast.error(`每次最多带 ${MAX_EDIT_REFERENCES} 张参考图`)
      return
    }
    setUploading(true)
    onBusyChange(true)
    try {
      for (const file of files) {
        // 类型与尺寸由上传通道统一校验，这里不再复制一份规则。
        const url = await uploadMediaFile(file, 'image')
        // 上传期间仍可移除已有参考图：按最新列表追加，不把移掉的装回来。
        const next = [...referencesRef.current, { id: mintUuid(), label: file.name, url }]
        referencesRef.current = next
        onReferencesChange(next)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '参考图上传失败')
    } finally {
      setUploading(false)
      onBusyChange(false)
    }
  }

  return (
    <div
      className={cn('video-editor-composer', dragging && 'video-editor-composer-dragging')}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDragOver={(event) => {
        if (!hasDraggedFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = locked ? 'none' : 'copy'
        if (!locked) setDragging(true)
      }}
      onDrop={(event) => {
        if (!hasDraggedFiles(event)) return
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
        disabled={disabled}
        onChange={(event) => onPromptChange(event.target.value)}
        placeholder="描述你想修改的画面…"
        value={prompt}
      />
      <div aria-label="参考图片" className="video-editor-composer-references" role="group">
        {references.map((reference) => (
          <div className="video-editor-composer-reference" key={reference.id}>
            <button
              aria-label={`预览参考图 ${reference.label}`}
              className="video-editor-composer-photo ui-focus"
              onClick={() => setPreview(reference)}
              type="button"
            >
              <img alt={reference.label} draggable={false} src={reference.url} />
            </button>
            <IconButton
              className="video-editor-composer-remove"
              disabled={locked}
              label={`移除参考图 ${reference.label}`}
              name="close"
              onClick={() =>
                onReferencesChange(referencesRef.current.filter((item) => item.id !== reference.id))
              }
              size="xs"
            />
          </div>
        ))}
        <button
          aria-busy={uploading}
          aria-label={uploading ? '正在上传参考图片' : '添加参考图片'}
          className="video-editor-composer-add hit-48 ui-focus"
          disabled={locked || references.length >= MAX_EDIT_REFERENCES}
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          <Icon
            className={cn(uploading && 'animate-spin')}
            decorative
            name={uploading ? 'loading' : 'add'}
            size="md"
          />
        </button>
      </div>
      {footer}
      <input
        accept={MEDIA_IMAGE_ACCEPT}
        aria-label="选择参考图片"
        className="hidden"
        disabled={locked}
        multiple
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          void addFiles(files)
        }}
        ref={inputRef}
        type="file"
      />
      <MediaLightbox
        media={preview === null ? null : { kind: 'image', name: preview.label, url: preview.url }}
        onClose={() => setPreview(null)}
      />
    </div>
  )
}
