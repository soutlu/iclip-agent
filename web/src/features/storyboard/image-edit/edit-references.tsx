import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Icon } from '@/shared/icons'
import { uploadMediaFile, MEDIA_IMAGE_ACCEPT } from '@/shared/api/media-upload'
import { cn } from '@/shared/lib/utils'
import { mintUuid } from '@/shared/lib/uuid'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { toast } from '@/shared/ui/toast'
import type { EditReference } from './image-edit-types'

type EditReferencesProps = {
  references: EditReference[]
  frames: readonly string[]
  currentFrame: number
  sourceUrl: string
  hasAnnotations: boolean
  disabled: boolean
  onChange: (references: EditReference[]) => void
  onBusyChange: (busy: boolean) => void
  onInsertReference: (id: string) => void
  onPreview: (reference: EditReference) => void
}

export function EditReferences({
  references,
  frames,
  currentFrame,
  sourceUrl,
  hasAnnotations,
  disabled,
  onChange,
  onBusyChange,
  onInsertReference,
  onPreview,
}: EditReferencesProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const uploadRef = useRef(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const latestRef = useRef(references)
  useEffect(() => {
    latestRef.current = references
  }, [references])
  const locked = disabled || uploading
  const otherFrames = frames
    .map((url, index) => ({ url, number: index + 1 }))
    .filter((frame) => frame.number !== currentFrame)

  const append = (reference: Omit<EditReference, 'id'>) => {
    const current = latestRef.current
    if (current.length >= 10) {
      toast.error('每次最多提交 10 张图片')
      return
    }
    if (
      current.some((item) =>
        reference.kind === 'annotated'
          ? item.kind === 'annotated'
          : item.kind === 'image' && item.url === reference.url,
      )
    )
      return
    const next = [...current, { ...reference, id: mintUuid() }]
    latestRef.current = next
    onChange(next)
  }

  const upload = async (files: readonly File[]) => {
    if (locked || uploadRef.current || files.length === 0) return
    if (files.length + latestRef.current.length > 10) {
      toast.error('每次最多提交 10 张图片')
      return
    }
    uploadRef.current = true
    setUploading(true)
    onBusyChange(true)
    try {
      for (const file of files) {
        const url = await uploadMediaFile(file, 'image')
        append({ kind: 'image', label: file.name.slice(0, 200), url })
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '参考图上传失败')
    } finally {
      uploadRef.current = false
      setUploading(false)
      onBusyChange(false)
    }
  }

  const move = (id: string, to: number) => {
    const from = references.findIndex((reference) => reference.id === id)
    if (locked || from < 0 || to < 0 || to >= references.length || from === to) return
    const next = [...references]
    const [item] = next.splice(from, 1)
    if (item === undefined) return
    next.splice(to, 0, item)
    onChange(next)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    setDragOver(false)
    if ([...event.dataTransfer.items].some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      toast.error('请拖入图片文件，不支持文件夹')
      return
    }
    void upload([...event.dataTransfer.files])
  }

  return (
    <section className="image-edit-references" aria-label="参考图片">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-body font-medium">
          输入图片{' '}
          <span className="text-caption text-on-surface-muted">{references.length}/10</span>
        </h3>
        <Button
          disabled={locked}
          leadingIcon="grid"
          onClick={() => setPickerOpen(true)}
          size="md"
          variant="outlined"
        >
          选择参考帧
        </Button>
      </div>
      <div
        className={cn(
          'image-edit-dropzone rounded-sm border border-dashed border-outline-variant bg-surface-container-lowest',
          dragOver && 'border-primary bg-primary-container-soft',
        )}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          event.stopPropagation()
          if (!locked) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <button
          className="flex w-full cursor-pointer flex-col items-center gap-1 rounded-sm px-4 py-4 ui-focus disabled:cursor-default"
          disabled={locked || references.length >= 10}
          onClick={() => fileRef.current?.click()}
          type="button"
        >
          <Icon
            decorative
            name={uploading ? 'loading' : 'add-file'}
            className={uploading ? 'animate-spin' : ''}
            size="lg"
          />
          <span className="text-body-sm">{uploading ? '正在上传参考图…' : '拖放图片到这里'}</span>
          <span className="text-caption text-on-surface-muted">或点击上传</span>
        </button>
        <input
          ref={fileRef}
          className="hidden"
          type="file"
          multiple
          accept={MEDIA_IMAGE_ACCEPT}
          aria-label="上传参考图片"
          disabled={locked}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            void upload(files)
          }}
        />
      </div>
      {references.length > 0 ? (
        <ol className="mt-3 grid grid-cols-3 gap-2" aria-label="提交图片顺序">
          {references.map((reference, index) => (
            <li
              key={reference.id}
              className="group relative min-w-0"
              draggable={!locked}
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-cue-edit-reference', reference.id)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes('application/x-cue-edit-reference')) {
                  event.preventDefault()
                  event.stopPropagation()
                }
              }}
              onDrop={(event) => {
                const id = event.dataTransfer.getData('application/x-cue-edit-reference')
                if (!id) return
                event.preventDefault()
                event.stopPropagation()
                move(id, index)
              }}
            >
              <button
                className="relative block aspect-square w-full cursor-zoom-in overflow-hidden rounded-sm bg-surface-container ui-focus"
                onClick={() => onPreview(reference)}
                type="button"
                aria-label={`预览参考图 ${index + 1}`}
              >
                <img
                  src={reference.kind === 'annotated' ? sourceUrl : reference.url}
                  alt={reference.label}
                  className="size-full object-cover"
                />
                {reference.kind === 'annotated' ? (
                  <span className="absolute inset-x-0 bottom-0 bg-scrim/64 py-1 text-caption text-on-scrim">
                    含当前标注
                  </span>
                ) : null}
              </button>
              <IconButton
                disabled={locked}
                label={`移除参考图 ${index + 1}`}
                name="close"
                size="xs"
                className="absolute top-1 right-1 bg-surface-container-lowest/96"
                onClick={() => onChange(references.filter((item) => item.id !== reference.id))}
              />
              <button
                className="mt-1 w-full truncate rounded-xs text-center text-caption text-on-surface-muted ui-focus"
                title={reference.label}
                onClick={() => onInsertReference(reference.id)}
                disabled={locked}
                type="button"
              >
                参考图 {index + 1} · {reference.label}
              </button>
              <div className="flex justify-center gap-2">
                <IconButton
                  disabled={locked || index === 0}
                  label={`参考图 ${index + 1} 向前移`}
                  name="back"
                  size="xs"
                  onClick={() => move(reference.id, index - 1)}
                />
                <IconButton
                  disabled={locked || index === references.length - 1}
                  label={`参考图 ${index + 1} 向后移`}
                  name="next"
                  size="xs"
                  onClick={() => move(reference.id, index + 1)}
                />
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="mt-2 text-caption leading-relaxed text-on-surface-muted">
        默认使用当前原图；需要其他参考时再添加图片，可调整提交顺序。
      </p>
      <DialogRoot open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogSurface aria-describedby={undefined} className="max-w-2xl">
          <DialogHeader title="选择参考帧" closeLabel="关闭参考帧选择" />
          <DialogBody>
            <div className="mb-4 flex flex-wrap gap-2">
              <Button
                size="md"
                variant="outlined"
                disabled={
                  locked ||
                  references.length >= 10 ||
                  references.some((item) => item.kind === 'image' && item.url === sourceUrl)
                }
                onClick={() => append({ kind: 'image', url: sourceUrl, label: '当前原图' })}
              >
                加入当前原图
              </Button>
              <Button
                size="md"
                variant="outlined"
                disabled={
                  locked ||
                  !hasAnnotations ||
                  references.length >= 10 ||
                  references.some((item) => item.kind === 'annotated')
                }
                onClick={() => append({ kind: 'annotated', url: sourceUrl, label: '当前标注图' })}
              >
                加入当前标注图
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-3" aria-label="当前镜头组的其他参考帧">
              {otherFrames.map(({ url, number }) => (
                <button
                  key={number}
                  type="button"
                  className="relative overflow-hidden rounded-sm border border-outline-variant p-1 ui-focus disabled:opacity-50"
                  aria-label={`添加参考帧 ${number}`}
                  aria-pressed={references.some(
                    (item) => item.kind === 'image' && item.url === url,
                  )}
                  disabled={
                    locked ||
                    references.length >= 10 ||
                    references.some((item) => item.kind === 'image' && item.url === url)
                  }
                  onClick={() => append({ kind: 'image', url, label: `帧 @${number}` })}
                >
                  <img
                    className="aspect-[3/4] w-full rounded-xs object-cover"
                    src={url}
                    alt={`参考帧 ${number}`}
                  />
                  <span className="mt-1 block text-caption">帧 @{number}</span>
                  {references.some((item) => item.kind === 'image' && item.url === url) ? (
                    <span className="absolute top-2 right-2 rounded-full bg-primary p-1 text-on-primary">
                      <Icon decorative name="check" size="sm" />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <Button className="mt-5 w-full" onClick={() => setPickerOpen(false)} size="md">
              完成选择
            </Button>
          </DialogBody>
        </DialogSurface>
      </DialogRoot>
    </section>
  )
}
