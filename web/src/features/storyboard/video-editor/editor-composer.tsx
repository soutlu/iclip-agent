/** 修改要求与参考图放在输入区，上传和生成设置放在下方工具栏。参考图选了就直传对象存储。 */

import { useRef, useState, type ReactNode } from 'react'
import { MEDIA_IMAGE_ACCEPT } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { mintUuid } from '@/shared/lib/uuid'
import { IconButton } from '@/shared/ui/button'
import { MediaLightbox } from '@/shared/ui/media-lightbox'
import { MAX_EDIT_REFERENCES } from '../generation-limits'
import { useReferenceUploads } from '../use-reference-uploads'
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
  const [preview, setPreview] = useState<EditorReference | null>(null)
  const { locked, uploading, dragOver, upload, remove, dragHandlers } =
    useReferenceUploads<EditorReference>({
      references,
      disabled,
      limit: MAX_EDIT_REFERENCES,
      tooMany: `每次最多带 ${MAX_EDIT_REFERENCES} 张参考图`,
      onChange: onReferencesChange,
      onBusyChange,
      fromUpload: (file, url) => ({ id: mintUuid(), label: file.name, url }),
    })

  return (
    <div
      className="video-editor-composer-layout"
      {...dragHandlers}
      onPaste={(event) => {
        const images = [...event.clipboardData.files].filter((file) =>
          file.type.startsWith('image/'),
        )
        if (images.length === 0) return
        event.preventDefault()
        void upload(images)
      }}
    >
      <div className={cn('video-editor-composer', dragOver && 'video-editor-composer-dragging')}>
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
                onClick={() => remove(reference.id)}
                size="xs"
              />
            </div>
          ))}
        </div>
      </div>
      <div className="video-editor-composer-actions">
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
        {footer}
      </div>
      <input
        accept={MEDIA_IMAGE_ACCEPT}
        aria-label="选择参考图片"
        className="hidden"
        disabled={locked}
        multiple
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          void upload(files)
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
