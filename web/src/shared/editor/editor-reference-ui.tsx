import type { EditorReference } from '@/shared/editor/editor-reference'
import { EditorReferenceIcon } from '@/shared/editor/editor-reference-icon'

const REFERENCE_KIND_LABELS = {
  arrow: '箭头',
  audio: '音频',
  brush: '画笔',
  frame: '线框',
  image: '图片',
  note: '标记',
  video: '视频',
} as const satisfies Record<EditorReference['kind'], string>

type EditorReferenceChipProps = {
  onActivate?: (reference: EditorReference) => void
  reference: EditorReference
}

/**
 * 渲染引用来源缩略图；没有预览时使用同类型 SVG 占位。
 *
 * @param props - 当前编辑器引用。
 * @returns 固定 16px 的来源视觉。
 */
const EditorReferenceSource = ({ reference }: { reference: EditorReference }) => {
  const previewUrl =
    reference.source?.previewUrl ??
    (reference.source?.kind === 'image' ? reference.source.url : undefined)

  return (
    <span className="editor-reference-chip__source" aria-hidden="true">
      {previewUrl ? (
        <img src={previewUrl} alt="" />
      ) : (
        <EditorReferenceIcon
          className="editor-reference-chip__source-placeholder"
          kind={reference.kind}
          size={10}
          title={REFERENCE_KIND_LABELS[reference.kind]}
        />
      )}
    </span>
  )
}

/**
 * 渲染所有输入框共用的正文引用 chip。
 *
 * @param props - 当前引用与可选激活回调。
 * @returns 来源图、类型 SVG 和统一标签组成的 chip。
 */
export function EditorReferenceChip({ onActivate, reference }: EditorReferenceChipProps) {
  const content = (
    <>
      <EditorReferenceSource reference={reference} />
      <span className="editor-reference-chip__icon" aria-hidden="true">
        <EditorReferenceIcon
          kind={reference.kind}
          size={7}
          title={REFERENCE_KIND_LABELS[reference.kind]}
        />
      </span>
      <span className="editor-reference-chip__label">{reference.label}</span>
    </>
  )

  if (!onActivate)
    return (
      <span className="editor-reference-chip" data-reference-kind={reference.kind}>
        {content}
      </span>
    )

  return (
    <button
      type="button"
      className="editor-reference-chip"
      data-reference-kind={reference.kind}
      title={`预览 ${reference.label}`}
      onClick={() => onActivate(reference)}
    >
      {content}
    </button>
  )
}

export type EditorReferenceSuggestionMenuProps = {
  items: EditorReference[]
  onSelect: (reference: EditorReference) => void
  selectedIndex: number
}

/**
 * 渲染所有输入框共用的 @ 引用候选列表。
 *
 * @param props - 已排序候选、当前键盘索引与选择回调。
 * @returns 共享候选菜单；没有候选时不渲染额外说明 UI。
 */
export function EditorReferenceSuggestionMenu({
  items,
  onSelect,
  selectedIndex,
}: EditorReferenceSuggestionMenuProps) {
  if (items.length === 0) return null

  return (
    <div
      className="editor-reference-suggestion-menu"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div role="listbox" aria-label="选择引用">
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            aria-label={`引用 ${item.label}`}
            aria-selected={selectedIndex === index}
            data-reference-kind={item.kind}
            data-selected={selectedIndex === index || undefined}
            role="option"
            title={item.label}
            onMouseDown={(event) => {
              event.preventDefault()
              onSelect(item)
            }}
          >
            <EditorReferenceSource reference={item} />
            <span className="editor-reference-chip__icon" aria-hidden="true">
              <EditorReferenceIcon
                kind={item.kind}
                size={7}
                title={REFERENCE_KIND_LABELS[item.kind]}
              />
            </span>
            <strong>{item.label}</strong>
          </button>
        ))}
      </div>
    </div>
  )
}
