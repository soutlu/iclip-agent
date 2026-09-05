/** 编辑器处理键盘、粘贴与 NodeView；外层 window 处理文件拖放插入。文档变化后同步附件引用，确保条目随文档回收。 */

import { baseKeymap } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import type { Node as PMNode } from 'prosemirror-model'
import { EditorState, Selection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { useCallback, useEffect, useRef, useState } from 'react'
import { collectAttachmentIds, composerSchema, readComposerText } from './editor-schema'
import type {
  ComposerAttachmentKind,
  ComposerAttachments,
  ComposerSubmission,
} from './use-composer-attachments'

const nodeType = (name: 'attachment' | 'paragraph') => {
  const type = composerSchema.nodes[name]
  if (type === undefined) throw new Error(`composer schema 里没有 ${name} 节点`)
  return type
}

/** 无名粘贴文件命名为 paste-<时间戳>.<扩展名>。 */
const renamePastedFile = (file: File): File =>
  file.name === ''
    ? new File([file], `paste-${Date.now()}.${file.type.split('/')[1] ?? 'png'}`, {
        type: file.type,
      })
    : file

export type ComposerPillHost = {
  attId: string
  el: HTMLElement
  kind: ComposerAttachmentKind
  name: string
}

type UseComposerEditorOptions = {
  attachments: ComposerAttachments
  attachmentsEnabled: boolean
  canSend: () => boolean
  onSubmit: () => void
  registerPillHost: (host: ComposerPillHost) => void
  unregisterPillHost: (attId: string) => void
  dense: boolean
}

/** 编辑器随宿主创建；变化中的数据和回调通过 ref 读取，避免重建实例。 */
export const useComposerEditor = ({
  attachments,
  attachmentsEnabled,
  canSend,
  dense,
  onSubmit,
  registerPillHost,
  unregisterPillHost,
}: UseComposerEditorOptions) => {
  const viewRef = useRef<EditorView | null>(null)
  const [empty, setEmpty] = useState(true)
  const [attIds, setAttIds] = useState<readonly string[]>([])

  // 编辑器只建一次，变化中的回调与状态经 ref 读最新值
  const attachmentsRef = useRef(attachments)
  const canSendRef = useRef(canSend)
  const onSubmitRef = useRef(onSubmit)
  const attachmentsEnabledRef = useRef(attachmentsEnabled)
  const registerPillHostRef = useRef(registerPillHost)
  const unregisterPillHostRef = useRef(unregisterPillHost)
  useEffect(() => {
    attachmentsRef.current = attachments
    canSendRef.current = canSend
    onSubmitRef.current = onSubmit
    attachmentsEnabledRef.current = attachmentsEnabled
    registerPillHostRef.current = registerPillHost
    unregisterPillHostRef.current = unregisterPillHost
  })

  /** 插入后光标置于 pill 之后；位置不合法时回退文末。 */
  const insertNodeAt = (view: EditorView, node: PMNode, pos: number) => {
    const insert = (at: number) => {
      const tr = view.state.tr.insert(at, node)
      tr.setSelection(Selection.near(tr.doc.resolve(at + node.nodeSize))).scrollIntoView()
      view.dispatch(tr)
      return at + node.nodeSize
    }
    try {
      return insert(pos)
    } catch {
      return insert(Math.max(1, view.state.doc.content.size - 1))
    }
  }

  /** 上传并插入附件；未指定 pos 时使用当前选区。 */
  const insertFiles = (files: readonly File[], pos?: number) => {
    const view = viewRef.current
    if (view === null) return
    let at = pos ?? view.state.selection.to
    for (const raw of files) {
      const file = renamePastedFile(raw)
      const entry = attachmentsRef.current.mintEntry(file)
      at = insertNodeAt(
        view,
        nodeType('attachment').create({ attId: entry.attId, kind: entry.kind, name: entry.name }),
        at,
      )
    }
    view.focus()
  }

  const posAtCoords = (clientX: number, clientY: number): number | undefined =>
    viewRef.current?.posAtCoords({ left: clientX, top: clientY })?.pos

  /** 清空文档后由 syncReferences 回收附件条目。 */
  const clearDoc = () => {
    const view = viewRef.current
    if (view === null) return
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, nodeType('paragraph').create()),
    )
  }

  /** 按原始 parts 顺序恢复正文与附件。 */
  const restoreDoc = (submission: ComposerSubmission) => {
    const view = viewRef.current
    if (view === null) return
    attachmentsRef.current.restoreEntries(submission.media)
    const content = submission.parts.flatMap((part) =>
      part.kind === 'text'
        ? part.text === ''
          ? []
          : [composerSchema.text(part.text)]
        : [
            nodeType('attachment').create({
              attId: part.media.attId,
              kind: part.media.kind,
              name: part.media.name,
            }),
          ],
    )
    view.dispatch(
      view.state.tr.replaceWith(
        0,
        view.state.doc.content.size,
        nodeType('paragraph').create(null, content),
      ),
    )
  }

  const focusEditor = () => viewRef.current?.focus()

  // PM 粘贴处理器经 ref 调用最新 insertFiles，外层拖放复用同一操作。
  const insertFilesRef = useRef(insertFiles)
  useEffect(() => {
    insertFilesRef.current = insertFiles
  })

  // dense 仅在挂载时读取，两个页面各自使用固定编辑器形态。
  const denseRef = useRef(dense)

  /** React 19 回调 ref 创建编辑器并返回清理函数，使实例生命周期与宿主元素一致。 */
  const mountEditor = useCallback((el: HTMLDivElement | null) => {
    if (el === null) return undefined
    const isDense = denseRef.current
    const view = new EditorView(el, {
      attributes: {
        'aria-label': '输入消息',
        'aria-multiline': 'true',
        class: isDense ? 'composer-editor composer-editor-dense' : 'composer-editor',
        role: 'textbox',
      },
      dispatchTransaction(tr) {
        const next = view.state.apply(tr)
        view.updateState(next)
        if (!tr.docChanged) return
        const ids = collectAttachmentIds(next.doc)
        setAttIds(ids)
        attachmentsRef.current.syncReferences(ids)
        setEmpty(readComposerText(next.doc) === '' && ids.length === 0)
      },
      handleKeyDown(view, event) {
        if (event.key !== 'Enter' || event.isComposing) return false
        if (event.shiftKey) {
          view.dispatch(view.state.tr.insertText('\n').scrollIntoView())
          return true
        }
        // 内容不可发送时 Enter 仍不插入换行。
        if (canSendRef.current()) onSubmitRef.current()
        return true
      },
      handlePaste(_view, event) {
        if (!attachmentsEnabledRef.current) return false
        const files = [...(event.clipboardData?.files ?? [])]
        if (files.length === 0) return false
        event.preventDefault()
        insertFilesRef.current(files)
        return true
      },
      handleDrop(_view, event) {
        if (!attachmentsEnabledRef.current) return false
        if (event.dataTransfer?.types.includes('Files') !== true) return false
        event.preventDefault()
        return true
      },
      nodeViews: {
        attachment(node) {
          const attId = node.attrs['attId'] as string
          const kind = node.attrs['kind'] as ComposerAttachmentKind
          const span = document.createElement('span')
          span.className = `attachment-pill attachment-${kind}`
          span.dataset['attachmentId'] = attId
          span.dataset['attachmentKind'] = kind
          span.dataset['attachmentName'] = node.attrs['name'] as string
          registerPillHostRef.current({
            attId,
            el: span,
            kind,
            name: node.attrs['name'] as string,
          })
          return {
            destroy() {
              unregisterPillHostRef.current(attId)
            },
            dom: span,
            update: (next) => next.attrs['attId'] === attId,
          }
        },
      },
      state: EditorState.create({
        plugins: [
          history(),
          keymap({ 'Mod-y': redo, 'Mod-z': undo, 'Shift-Mod-z': redo }),
          keymap(baseKeymap),
        ],
        schema: composerSchema,
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  return {
    attIds,
    clearDoc,
    empty,
    focusEditor,
    insertFiles,
    mountEditor,
    posAtCoords,
    restoreDoc,
    viewRef,
  }
}
