/**
 * 输入框的 ProseMirror 装配（照 kimi 网页版 composer：自定义 schema + EditorView +
 * NodeView + handleKeyDown/handlePaste/handleDrop，不走 Tiptap 之类的封装）。
 *
 * 这里管四件事：
 * - 键盘：Enter 发送（IME 组字期间的 Enter 是选字，不触发）、Shift+Enter 换行、Mod+Z 撤销；
 * - 粘贴：剪贴板里有文件就拦下收为附件（无名文件改名 `paste-<时间戳>.<扩展名>`），纯文字
 *   交还 PM 默认行为；
 * - 拖放：Files 落在编辑区由这里 preventDefault 吞掉，真正的插入由 composer 外层的
 *   window 级处理器做（照 kimi 的分工）；
 * - pill 落位：attachment 节点的 NodeView 只出外层 span 并向 composer 登记，内容
 *   （图标、名字、悬停卡）由 composer 那边经 portal 渲染。
 *
 * 文档是 pill 的唯一事实源：每次 doc 变化都把当前引用的 attId 列表喂给
 * `attachments.syncReferences` 做 refCount 对账。
 */

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

/** schema 里取节点类型；schema 是模块级常量，取不到就是写错了名字。 */
const nodeType = (name: 'attachment' | 'paragraph') => {
  const type = composerSchema.nodes[name]
  if (type === undefined) throw new Error(`composer schema 里没有 ${name} 节点`)
  return type
}

/** 无名粘贴文件改名（照 kimi）：`paste-<时间戳>.<类型扩展名>`。 */
const renamePastedFile = (file: File): File =>
  file.name === ''
    ? new File([file], `paste-${Date.now()}.${file.type.split('/')[1] ?? 'png'}`, {
        type: file.type,
      })
    : file

/** pill 的 NodeView 落位信息：外层 span 登记给 composer，portal 渲染内容。 */
export type ComposerPillHost = {
  attId: string
  el: HTMLElement
  kind: ComposerAttachmentKind
  name: string
}

type UseComposerEditorOptions = {
  attachments: ComposerAttachments
  attachmentsEnabled: boolean
  /** Enter 时判一次能不能发。 */
  canSend: () => boolean
  /** 触发提交（具体组包在 composer 那边）。 */
  onSubmit: () => void
  registerPillHost: (host: ComposerPillHost) => void
  unregisterPillHost: (attId: string) => void
  /** 紧凑形态（会话页）：单行起步。 */
  dense: boolean
}

/**
 * 装配输入框编辑器。
 *
 * @param options - 装配参数；除 dense 外的值经 ref 读取，编辑器实例只建一次。
 * @returns 挂载点 ref、文档状态与一组命令式操作。
 */
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

  /** 往 pos 插一颗 inline pill 并把光标挪到它后面；落点不合法（块边界之类）就退到文末（照 kimi 的兜底）。 */
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

  /**
   * 收一批文件：建 entry 起传、插 pill。
   *
   * @param files - 文件列表。
   * @param pos - 插入位置；不给就插当前选区。
   */
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

  /** 目测坐标对应的文档位置；拿不到（在编辑区外）返回 undefined。 */
  const posAtCoords = (clientX: number, clientY: number): number | undefined =>
    viewRef.current?.posAtCoords({ left: clientX, top: clientY })?.pos

  /** 清空整篇（发送成功后调用）；entry 由 doc 变化触发的 syncReferences 顺带回收。 */
  const clearDoc = () => {
    const view = viewRef.current
    if (view === null) return
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, nodeType('paragraph').create()),
    )
  }

  /**
   * 发送失败把内容还回来：附件排在文字前（原文里 pill 与文字的相对位置丢不起就不还——
   * 它们都还在，只是聚到了开头）。
   *
   * @param submission - 当时发出去的那份快照。
   */
  const restoreDoc = (submission: ComposerSubmission) => {
    const view = viewRef.current
    if (view === null) return
    attachmentsRef.current.restoreEntries(submission.media)
    // 按发出去时的先后还回来：图仍在它原来那句话旁边
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

  // insertFiles 同时被 PM 的 handlePaste（编辑器只建一次）与外层 drop 用，进 ref 供前者拿
  const insertFilesRef = useRef(insertFiles)
  useEffect(() => {
    insertFilesRef.current = insertFiles
  })

  // dense 只在挂载时读（两个页面的 composer 各自是固定形态），经 ref 读就不进依赖
  const denseRef = useRef(dense)

  /**
   * 编辑器的挂载点（React 19 回调 ref：返回清理函数）。编辑器随宿主元素生灭，
   * 不依赖 effect 时序；回调里只读 ref，行为以挂载那一刻为准。
   */
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
        // 空输入 / 附件还在传时 Enter 不换行（聊天输入惯例），只是不发
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
