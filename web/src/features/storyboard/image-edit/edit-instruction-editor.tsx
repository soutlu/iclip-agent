import { baseKeymap } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { type Node as PMNode, Slice } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView, type NodeView } from 'prosemirror-view'
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { docToInstructions, instructionNode, instructionsToDoc } from './edit-instruction-doc'
import type { EditInstruction, EditReference, ImageAnnotation } from './image-edit-types'

type Reference = { kind: 'annotation' | 'referenceImage'; id: string }
type Props = {
  value: readonly EditInstruction[]
  onChange: (parts: EditInstruction[]) => void
  annotations: readonly ImageAnnotation[]
  references: readonly EditReference[]
  onSelectAnnotation: (id: string) => void
  onPreviewReference: (id: string) => void
  selectedAnnotationId?: string | null
  disabled?: boolean
  pendingInsertion?: (Reference & { requestId: number }) | null
  onInserted?: () => void
}
type Choice = Reference & { label: string; url?: string }
type MenuState = { from: number; to: number; query: string; active: number; typed: boolean }

function choices(props: Pick<Props, 'annotations' | 'references'>): Choice[] {
  return [
    ...props.annotations.map((item) => ({
      kind: 'annotation' as const,
      id: item.id,
      label: `标注 ${item.number}`,
    })),
    ...props.references.map((item, index) => ({
      kind: 'referenceImage' as const,
      id: item.id,
      label: `参考图 ${index + 1} · ${item.label}`,
      url: item.url,
    })),
  ]
}
const sameReference = (a: Reference, b: Reference) => a.kind === b.kind && a.id === b.id
const isActivation = (event: KeyboardEvent) => event.key === 'Enter' || event.key === ' '

class ReferenceView implements NodeView {
  readonly dom = document.createElement('span')
  private readonly reference: Reference
  private readonly latestRef: () => Props
  private readonly views: Set<ReferenceView>
  constructor(node: PMNode, latestRef: () => Props, views: Set<ReferenceView>) {
    this.latestRef = latestRef
    this.views = views
    this.reference = {
      kind: node.attrs['kind'] as Reference['kind'],
      id: node.attrs['id'] as string,
    }
    this.dom.contentEditable = 'false'
    this.dom.tabIndex = 0
    this.dom.setAttribute('role', 'button')
    this.dom.addEventListener('click', (event) => {
      event.preventDefault()
      this.activate()
    })
    this.dom.addEventListener('keydown', (event) => {
      if (isActivation(event)) {
        event.preventDefault()
        this.activate()
      }
    })
    views.add(this)
    this.refresh()
  }
  private activate() {
    const props = this.latestRef()
    if (!choices(props).some((item) => sameReference(item, this.reference))) return
    if (this.reference.kind === 'annotation') props.onSelectAnnotation(this.reference.id)
    else props.onPreviewReference(this.reference.id)
  }
  refresh() {
    const props = this.latestRef()
    const item = choices(props).find((choice) => sameReference(choice, this.reference))
    const isAnnotation = this.reference.kind === 'annotation'
    const label = item?.label ?? `${isAnnotation ? '标注' : '参考图'}已失效`
    this.dom.setAttribute('aria-label', label)
    this.dom.setAttribute('aria-disabled', String(item === undefined))
    this.dom.dataset['referenceId'] = this.reference.id
    this.dom.className = cn(
      'mx-1 my-0.5 inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-sm border px-2 py-1 align-middle text-body leading-normal ui-focus select-none',
      isAnnotation
        ? 'border-warning/40 bg-warning-container text-on-warning-container'
        : 'border-primary/30 bg-primary-container text-on-primary-container',
      item === undefined && 'border-error bg-error-container text-on-error-container',
      isAnnotation && props.selectedAnnotationId === this.reference.id && 'ring-1 ring-warning',
    )
    this.dom.replaceChildren()
    if (item?.url !== undefined) {
      const image = document.createElement('img')
      image.src = item.url
      image.alt = ''
      image.className = 'size-5 rounded-xs object-cover'
      this.dom.append(image)
    }
    const text = document.createElement('span')
    text.className = 'max-w-52 truncate'
    text.textContent = label
    this.dom.title = label
    this.dom.append(text)
  }
  stopEvent(event: Event) {
    return (
      event.type === 'click' ||
      event.type === 'mousedown' ||
      (event instanceof KeyboardEvent && isActivation(event))
    )
  }
  ignoreMutation() {
    return true
  }
  destroy() {
    this.views.delete(this)
  }
}

/** 独立 ProseMirror 输入框；业务层只接收文字与稳定 ID 引用。 */
export function EditInstructionEditor(props: Props) {
  const { pendingInsertion, onInserted, disabled } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const latestRef = useRef(props)
  const initialRef = useRef(props.value)
  const serializedRef = useRef(JSON.stringify(props.value))
  const chipViewsRef = useRef(new Set<ReferenceView>())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<MenuState | null>(null)
  const menuId = useId()
  const handledInsertionRef = useRef<number | null>(null)
  const filtered = choices(props).filter((item) => item.label.includes(menu?.query ?? ''))
  useEffect(() => {
    latestRef.current = props
  })
  const updateMenu = (next: MenuState | null) => {
    menuRef.current = next
    setMenu(next)
  }
  function insert(reference: Reference, range?: { from: number; to: number }) {
    const view = viewRef.current
    if (view === null || latestRef.current.disabled) return
    const { from, to } = range ?? view.state.selection
    updateMenu(null)
    view.dispatch(
      view.state.tr
        .replaceWith(from, to, instructionNode('reference').create(reference))
        .scrollIntoView(),
    )
    view.focus()
  }
  const actionsRef = useRef({ insert })
  useEffect(() => {
    actionsRef.current = { insert }
  })
  useEffect(() => {
    if (hostRef.current === null) return
    const views = chipViewsRef.current
    const view: EditorView = new EditorView(hostRef.current, {
      state: EditorState.create({
        doc: instructionsToDoc(initialRef.current),
        plugins: [
          history(),
          keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo }),
          keymap(baseKeymap),
        ],
      }),
      attributes: {
        role: 'textbox',
        'aria-label': '修改要求',
        'aria-multiline': 'true',
        class:
          'image-edit-instruction-input min-h-32 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-t-md px-4 pt-4 pb-2 text-body leading-loose',
      },
      editable: () => !latestRef.current.disabled,
      nodeViews: { reference: (node) => new ReferenceView(node, () => latestRef.current, views) },
      dispatchTransaction(transaction) {
        view.updateState(view.state.apply(transaction))
        if (transaction.docChanged) {
          const parts = docToInstructions(view.state.doc)
          serializedRef.current = JSON.stringify(parts)
          latestRef.current.onChange(parts)
          const { $from, empty } = view.state.selection
          const preceding = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc')
          const match = /@([^@\s\ufffc]*)$/.exec(preceding)
          if (empty && match !== null) {
            const query = match[1] ?? ''
            updateMenu({
              from: $from.pos - query.length - 1,
              to: $from.pos,
              query,
              active: 0,
              typed: true,
            })
          } else updateMenu(null)
        } else if (transaction.selectionSet && menuRef.current?.typed) updateMenu(null)
      },
      handleKeyDown(_view, event) {
        const current = menuRef.current
        if (current === null || event.isComposing) return false
        const items = choices(latestRef.current).filter((item) =>
          item.label.includes(current.query),
        )
        if (event.key === 'Escape') {
          event.stopPropagation()
          updateMenu(null)
          return true
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const step = event.key === 'ArrowDown' ? 1 : -1
          updateMenu({
            ...current,
            active: (current.active + step + items.length) % Math.max(1, items.length),
          })
          return true
        }
        if (event.key === 'Enter') {
          const item = items[current.active]
          if (item !== undefined) actionsRef.current.insert(item, current)
          return true
        }
        return false
      },
      clipboardTextSerializer(slice) {
        return slice.content.textBetween(0, slice.content.size, '\n', (node) => {
          const item = choices(latestRef.current).find(
            (choice) => choice.kind === node.attrs['kind'] && choice.id === node.attrs['id'],
          )
          return `【${item?.label ?? '失效引用'}】`
        })
      },
      handlePaste(_view, event) {
        if (latestRef.current.disabled) return true
        const text = event.clipboardData?.getData('text/plain')
        if (text === undefined) return false
        // 粘贴文字不按编号推断引用身份，避免跨编辑稿误绑定图片。
        const doc = instructionsToDoc([{ kind: 'text', text }])
        view.dispatch(view.state.tr.replaceSelection(new Slice(doc.content, 1, 1)).scrollIntoView())
        return true
      },
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])
  useEffect(() => {
    const view = viewRef.current
    const next = JSON.stringify(props.value)
    if (view === null || next === serializedRef.current) return
    serializedRef.current = next
    view.updateState(
      EditorState.create({ doc: instructionsToDoc(props.value), plugins: view.state.plugins }),
    )
  }, [props.value])
  useEffect(() => {
    for (const chip of chipViewsRef.current) chip.refresh()
    viewRef.current?.setProps({ editable: () => !latestRef.current.disabled })
  }, [props.annotations, props.references, props.selectedAnnotationId, props.disabled])
  useEffect(() => {
    const pending = pendingInsertion
    if (pending == null || pending.requestId === handledInsertionRef.current || disabled) return
    handledInsertionRef.current = pending.requestId
    actionsRef.current.insert(pending)
    onInserted?.()
  }, [pendingInsertion, onInserted, disabled])
  useEffect(() => {
    viewRef.current?.setProps({
      attributes: {
        role: 'textbox',
        'aria-label': '修改要求',
        'aria-multiline': 'true',
        'aria-controls': menu === null ? '' : menuId,
        'aria-activedescendant':
          menu === null || filtered.length === 0 ? '' : `${menuId}-${menu.active}`,
        class:
          'image-edit-instruction-input min-h-32 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-t-md px-4 pt-4 pb-2 text-body leading-loose',
      },
    })
  }, [menu, menuId, filtered.length])
  return (
    <div className="image-edit-instruction-editor relative rounded-md border border-border bg-surface-container-lowest">
      <div ref={hostRef} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-1 pb-3">
        <button
          type="button"
          className="shrink-0 rounded-sm px-2 py-1.5 text-body-sm text-on-surface-variant ui-focus hover:bg-surface-container disabled:opacity-50"
          disabled={props.disabled}
          aria-label="插入引用"
          aria-expanded={menu !== null}
          aria-controls={menuId}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const view = viewRef.current
            if (view === null) return
            const { from, to } = view.state.selection
            updateMenu(
              menuRef.current === null ? { from, to, query: '', active: 0, typed: false } : null,
            )
            view.focus()
          }}
        >
          @ 插入引用
        </button>
        <span className="text-caption text-on-surface-muted">输入 @ 引用标注或参考图</span>
      </div>
      {menu !== null && (
        <div
          id={menuId}
          role="listbox"
          aria-label="选择引用"
          className="layer-popup absolute inset-x-0 top-full mt-1 max-h-60 overflow-y-auto rounded-md border border-border bg-popup-bg p-1 shadow-[var(--shadow-2)]"
        >
          {filtered.length === 0 && (
            <p className="p-3 text-body-sm text-on-surface-muted">暂无可引用内容</p>
          )}
          {filtered.map((item, index) => (
            <div key={`${item.kind}:${item.id}`}>
              {(index === 0 || filtered[index - 1]?.kind !== item.kind) && (
                <p className="px-2 pt-2 pb-1 text-caption text-on-surface-muted">
                  {item.kind === 'annotation' ? '标注' : '参考图'}
                </p>
              )}
              <button
                id={`${menuId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === menu.active}
                aria-label={`插入${item.label}`}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-body-sm text-on-surface ui-focus hover:bg-surface-container-high',
                  index === menu.active && 'bg-surface-container-high',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  insert(item, menu)
                }}
              >
                {item.url !== undefined && (
                  <img src={item.url} alt="" className="size-6 rounded-xs object-cover" />
                )}
                <span>{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
