import { useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { MEDIA_IMAGE_ACCEPT } from '@/shared/api/media-upload'
import { cn } from '@/shared/lib/utils'
import { mintUuid } from '@/shared/lib/uuid'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { MenuItem, MenuRoot, MenuSeparator, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { MAX_EDIT_REFERENCES } from '../generation-limits'
import { useReferenceUploads } from '../use-reference-uploads'
import type { EditReference } from './image-edit-types'
import './edit-references.css'

/** 去重后配上 id：标注图只留一份，图片按地址认；已有同一张就回 `undefined`。 */
const withId = (
  reference: Omit<EditReference, 'id'>,
  current: readonly EditReference[],
): EditReference | undefined =>
  current.some((item) =>
    reference.kind === 'annotated'
      ? item.kind === 'annotated'
      : item.kind === 'image' && item.url === reference.url,
  )
    ? undefined
    : { ...reference, id: mintUuid() }

type EditReferencesProps = {
  references: EditReference[]
  frames: readonly string[]
  currentFrame: number
  baseUrl: string
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
  baseUrl,
  hasAnnotations,
  disabled,
  onChange,
  onBusyChange,
  onInsertReference,
  onPreview,
}: EditReferencesProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const {
    locked,
    uploading,
    dragOver,
    upload,
    dragHandlers,
    latest: latestRef,
  } = useReferenceUploads<EditReference>({
    references,
    disabled,
    limit: MAX_EDIT_REFERENCES,
    tooMany: `每次最多提交 ${MAX_EDIT_REFERENCES} 张图片`,
    onChange,
    onBusyChange,
    fromUpload: (file, url, current) =>
      withId({ kind: 'image', label: file.name.slice(0, 200), url }, current),
  })
  const otherFrames = frames
    .map((url, index) => ({ url, number: index + 1 }))
    .filter((frame) => frame.number !== currentFrame)

  // 上限由选择器按钮的禁用挡住，这里只管去重。
  const append = (reference: Omit<EditReference, 'id'>) => {
    const next = withId(reference, latestRef.current)
    if (next === undefined) return
    const list = [...latestRef.current, next]
    latestRef.current = list
    onChange(list)
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

  return (
    <section className="image-edit-references" aria-label="参考图片">
      <div className="image-edit-reference-heading">
        <h3 className="text-body font-medium">
          参考图片{' '}
          <span className="text-caption text-on-surface-muted">
            {references.length}/{MAX_EDIT_REFERENCES}
          </span>
        </h3>
        <Button
          className="px-0 text-on-surface-muted"
          disabled={locked}
          onClick={() => setPickerOpen(true)}
          size="md"
          variant="ghost"
        >
          选择参考帧
        </Button>
      </div>
      <div
        className={cn('image-edit-reference-drop', dragOver && 'image-edit-reference-drop-active')}
        {...dragHandlers}
      >
        <ol className="image-edit-reference-list" aria-label="提交图片顺序">
          {references.map((reference, index) => (
            <li
              key={reference.id}
              className="image-edit-reference-item"
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
                className="image-edit-reference-photo ui-focus"
                onClick={() => onPreview(reference)}
                type="button"
                aria-label={`预览参考图 ${index + 1}`}
              >
                <img
                  src={reference.kind === 'annotated' ? baseUrl : reference.url}
                  alt={reference.label}
                  draggable={false}
                  className="size-full object-cover"
                />
                {reference.kind === 'annotated' ? (
                  <span className="absolute inset-x-0 bottom-0 bg-scrim/64 py-1 text-caption text-on-scrim">
                    含当前标注
                  </span>
                ) : null}
              </button>
              <MenuRoot>
                <MenuTrigger asChild>
                  <IconButton
                    className="image-edit-reference-menu"
                    disabled={locked}
                    label={`参考图 ${index + 1} 更多操作`}
                    name="more"
                    size="sm"
                  />
                </MenuTrigger>
                <MenuSurface align="end">
                  <MenuItem
                    aria-label={`参考图 ${index + 1} 向前移`}
                    disabled={locked || index === 0}
                    icon="back"
                    onSelect={() => move(reference.id, index - 1)}
                  >
                    向前移
                  </MenuItem>
                  <MenuItem
                    aria-label={`参考图 ${index + 1} 向后移`}
                    disabled={locked || index === references.length - 1}
                    icon="next"
                    onSelect={() => move(reference.id, index + 1)}
                  >
                    向后移
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    aria-label={`移除参考图 ${index + 1}`}
                    destructive
                    disabled={locked}
                    icon="delete"
                    onSelect={() => onChange(references.filter((item) => item.id !== reference.id))}
                  >
                    移除图片
                  </MenuItem>
                </MenuSurface>
              </MenuRoot>
              <button
                className="image-edit-reference-name ui-focus"
                aria-label={`引用参考图 ${index + 1} · ${reference.label}`}
                title={`引用参考图 ${index + 1} · ${reference.label}`}
                onClick={() => onInsertReference(reference.id)}
                disabled={locked}
                type="button"
              >
                @{index + 1} · {reference.label}
              </button>
            </li>
          ))}
          <li className="image-edit-reference-item">
            <button
              className="image-edit-reference-add ui-focus"
              disabled={locked || references.length >= MAX_EDIT_REFERENCES}
              onClick={() => fileRef.current?.click()}
              type="button"
              aria-label="添加参考图片"
            >
              <Icon
                decorative
                name={uploading ? 'loading' : 'add'}
                className={uploading ? 'motion-safe:animate-spin' : ''}
                size="lg"
              />
              <span>{uploading ? '上传中…' : '添加图片'}</span>
            </button>
          </li>
        </ol>
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
      <p className="mt-2 text-caption leading-relaxed text-on-surface-muted">
        可拖入图片，点击名称插入引用
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
                  references.length >= MAX_EDIT_REFERENCES ||
                  references.some((item) => item.kind === 'image' && item.url === baseUrl)
                }
                onClick={() => append({ kind: 'image', url: baseUrl, label: '编辑底图' })}
              >
                加入编辑底图
              </Button>
              <Button
                size="md"
                variant="outlined"
                disabled={
                  locked ||
                  !hasAnnotations ||
                  references.length >= MAX_EDIT_REFERENCES ||
                  references.some((item) => item.kind === 'annotated')
                }
                onClick={() => append({ kind: 'annotated', url: baseUrl, label: '当前标注图' })}
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
                    references.length >= MAX_EDIT_REFERENCES ||
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
