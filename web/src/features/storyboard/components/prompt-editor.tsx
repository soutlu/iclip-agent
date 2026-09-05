/** 帧记号使用 inline atom NodeView；只读与编辑共用实例，通过 editable 切换。 */

import { baseKeymap } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import type { Node as PMNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView, type NodeView } from 'prosemirror-view'
import { useEffect, useRef } from 'react'
import { cn } from '@/shared/lib/utils'
import { type PromptLine, serializeLines } from '../prompt-doc'
import { docToLines, linesToDoc } from './prompt-editor-doc'

/** NodeView 经 ref 读取最新数据，避免重建编辑器。 */
type ChipContext = {
  frameUrl: (n: number) => string | undefined
  highlighted: () => number | undefined
  onPick: (n: number) => void
}

const CHIP_CLASS =
  'frame-chip mx-0.5 inline-flex cursor-pointer items-center gap-1 rounded-xs bg-surface-container-high px-1 py-px align-middle text-caption text-on-surface-variant select-none ui-focus ui-motion-s'
const CHIP_ACTIVE_CLASS = 'bg-on-surface text-surface'

const isActivationKey = (key: string) => key === 'Enter' || key === ' '

class FrameChipView implements NodeView {
  readonly dom: HTMLSpanElement
  private readonly img: HTMLImageElement
  private readonly n: number
  private readonly ctx: ChipContext
  private readonly chips: Set<FrameChipView>

  constructor(node: PMNode, ctx: ChipContext, chips: Set<FrameChipView>) {
    this.ctx = ctx
    this.chips = chips
    this.n = node.attrs['n'] as number
    this.dom = document.createElement('span')
    this.dom.dataset['n'] = String(this.n)
    this.dom.setAttribute('role', 'button')
    this.dom.setAttribute('aria-label', `看第 ${this.n} 帧`)
    this.dom.contentEditable = 'false'
    this.dom.tabIndex = 0
    this.img = document.createElement('img')
    this.img.alt = ''
    this.img.className = 'size-4 rounded-xs object-cover'
    const label = document.createElement('span')
    label.textContent = `@${this.n}`
    this.dom.append(this.img, label)
    this.dom.addEventListener('click', (event) => {
      event.preventDefault()
      this.ctx.onPick(this.n)
    })
    this.dom.addEventListener('keydown', (event) => {
      if (!isActivationKey(event.key)) return
      event.preventDefault()
      this.ctx.onPick(this.n)
    })
    chips.add(this)
    this.refresh()
  }

  refresh() {
    const url = this.ctx.frameUrl(this.n)
    if (url === undefined) this.img.removeAttribute('src')
    else if (this.img.getAttribute('src') !== url) this.img.src = url
    this.img.hidden = url === undefined
    this.dom.className = cn(CHIP_CLASS, this.ctx.highlighted() === this.n && CHIP_ACTIVE_CLASS)
  }

  stopEvent(event: Event) {
    return (
      event.type === 'click' ||
      event.type === 'mousedown' ||
      (event.type === 'keydown' && event instanceof KeyboardEvent && isActivationKey(event.key))
    )
  }

  ignoreMutation() {
    return true
  }

  destroy() {
    this.chips.delete(this)
  }
}

type PromptEditorProps = {
  lines: readonly PromptLine[]
  /** 帧数组下标为编号减一。 */
  frames: readonly string[]
  highlighted?: number | undefined
  readOnly?: boolean
  onChange?: ((lines: PromptLine[]) => void) | undefined
  onPickFrame?: ((n: number) => void) | undefined
  'aria-label': string
  className?: string
}

export function PromptEditor({
  'aria-label': ariaLabel,
  className,
  frames,
  highlighted,
  lines,
  onChange,
  onPickFrame,
  readOnly = false,
}: PromptEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const chipsRef = useRef(new Set<FrameChipView>())
  // 编辑器只建一次；变化中的回调与数据经 ref 读最新值
  const latestRef = useRef({ frames, highlighted, onChange, onPickFrame, readOnly })
  useEffect(() => {
    latestRef.current = { frames, highlighted, onChange, onPickFrame, readOnly }
  })
  // 记录最近序列化结果，忽略编辑器自身发出的更新，避免重置光标。
  const serializedRef = useRef(serializeLines(lines))
  const initialRef = useRef({ ariaLabel, lines })

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    const chips = chipsRef.current
    const ctx: ChipContext = {
      frameUrl: (n) => latestRef.current.frames[n - 1],
      highlighted: () => latestRef.current.highlighted,
      onPick: (n) => latestRef.current.onPickFrame?.(n),
    }
    const view: EditorView = new EditorView(host, {
      attributes: {
        'aria-label': initialRef.current.ariaLabel,
        'aria-multiline': 'true',
        class: 'prompt-editor-content',
        role: 'textbox',
      },
      dispatchTransaction(tr) {
        const next = view.state.apply(tr)
        view.updateState(next)
        if (!tr.docChanged) return
        const changed = docToLines(next.doc)
        serializedRef.current = serializeLines(changed)
        latestRef.current.onChange?.(changed)
      },
      editable: () => !latestRef.current.readOnly,
      nodeViews: { frame: (node) => new FrameChipView(node, ctx, chips) },
      state: EditorState.create({
        doc: linesToDoc(initialRef.current.lines),
        plugins: [
          history(),
          keymap({ 'Mod-y': redo, 'Mod-z': undo, 'Shift-Mod-z': redo }),
          keymap(baseKeymap),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // 外部文本变化时替换文档并重置光标。
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const serialized = serializeLines(lines)
    if (serialized === serializedRef.current) return
    serializedRef.current = serialized
    view.updateState(EditorState.create({ doc: linesToDoc(lines), plugins: view.state.plugins }))
  }, [lines])

  useEffect(() => {
    for (const chip of chipsRef.current) chip.refresh()
  }, [frames, highlighted])

  useEffect(() => {
    viewRef.current?.setProps({ editable: () => !readOnly })
  }, [readOnly])

  return <div className={cn('prompt-editor', className)} ref={hostRef} />
}
