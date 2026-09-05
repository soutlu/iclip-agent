/** 参考 Kimi composer；Enter 发送，Shift+Enter 换行，IME 组字不发送。文档中的附件必须全部就绪才可提交，允许纯附件内容。 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { Tag } from '@/shared/ui/tag'
import { ComposerAttachmentPill } from './composer-attachment-pill'
import { readComposerSegments, readComposerText } from './editor-schema'
import type { ComposerPillHost } from './use-composer-editor'
import { useComposerEditor } from './use-composer-editor'
import type { ComposerPart, ComposerSubmission } from './use-composer-attachments'
import { useComposerAttachments } from './use-composer-attachments'

export type ComposerHandle = {
  clear: () => void
  /** 按 parts 顺序替换整篇内容，用于发送失败恢复与修改已发消息。 */
  restore: (submission: ComposerSubmission) => void
  focus: () => void
}

type ComposerProps = {
  /** 回车或发送按钮触发；空内容和未就绪附件不提交。 */
  onSubmit: (submission: ComposerSubmission) => void
  placeholder?: string
  /** 附件按钮之后的工具行内容。 */
  leading?: ReactNode
  /** 发送按钮之前的工具行内容。 */
  trailing?: ReactNode
  sending?: boolean
  /** dense 从单行起步，否则从三行起步。 */
  dense?: boolean
  /** 运行时替换为停止按钮，不受空输入的发送禁用条件影响。 */
  busy?: boolean
  onStop?: (() => void) | undefined
  /** 由调用方根据登录态与 assets:write 决定上传入口是否可用。 */
  attachmentsEnabled?: boolean
  /** 工作台引用独立于 PM 文档与撤销栈，发送时由调用方转换为正文。 */
  references?: readonly { id: string; label: string; onRemove: () => void }[]
  ref?: Ref<ComposerHandle>
  className?: string
}

export function Composer({
  attachmentsEnabled = false,
  busy = false,
  className,
  dense = false,
  leading,
  onStop,
  onSubmit,
  placeholder = '输入消息，开始创作…',
  ref,
  references = [],
  sending = false,
  trailing,
}: ComposerProps) {
  const attachments = useComposerAttachments()
  const [pillHosts, setPillHosts] = useState<readonly ComposerPillHost[]>([])
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const registerPillHost = useCallback((host: ComposerPillHost) => {
    setPillHosts((prev) => [...prev.filter((item) => item.attId !== host.attId), host])
  }, [])
  const unregisterPillHost = useCallback((attId: string) => {
    setPillHosts((prev) => prev.filter((item) => item.attId !== attId))
  }, [])

  /** 只有内容非空且引用附件全部就绪才可发送；编辑器经 ref 获取最新判定闭包。 */
  const canSendNow = () => {
    if (sending || editor.empty) return false
    return !editor.attIds.some((attId) => attachments.entries.get(attId)?.status !== 'ready')
  }

  const submit = () => {
    const view = editor.viewRef.current
    if (view === null || !canSendNow()) return
    const text = readComposerText(view.state.doc).trim()
    const media = attachments.takeReady(editor.attIds)
    const parts: ComposerPart[] = []
    for (const segment of readComposerSegments(view.state.doc)) {
      if (segment.kind === 'attachment') {
        const entry = media.find((item) => item.attId === segment.attId)
        if (entry !== undefined) parts.push({ kind: 'media', media: entry })
        continue
      }
      const previous = parts.at(-1)
      if (previous?.kind === 'text') {
        parts[parts.length - 1] = { kind: 'text', text: previous.text + segment.text }
      } else {
        parts.push(segment)
      }
    }
    onSubmit({ media, parts, text })
  }

  const editor = useComposerEditor({
    attachments,
    attachmentsEnabled,
    canSend: canSendNow,
    dense,
    onSubmit: submit,
    registerPillHost,
    unregisterPillHost,
  })
  // 先解构挂载回调，避免 react-hooks/refs 将 editor.mountEditor 误判为 ref 读取。
  const { mountEditor } = editor

  // 命令式句柄与全局拖放监听器经 ref 获取最新编辑器操作。
  const editorRef = useRef(editor)
  useEffect(() => {
    editorRef.current = editor
  })

  useImperativeHandle(
    ref,
    () => ({
      clear: () => editorRef.current.clearDoc(),
      focus: () => editorRef.current.focusEditor(),
      restore: (submission) => editorRef.current.restoreDoc(submission),
    }),
    [],
  )

  // 用 window 级计数吸收子元素间的 dragenter / dragleave，避免遮罩闪烁。
  useEffect(() => {
    if (!attachmentsEnabled) return
    let depth = 0
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') === true
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      setDragOver(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault() // dragover 必须 preventDefault 才能接收 drop。
    }
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragOver(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragOver(false)
      const { dataTransfer } = event
      if (dataTransfer === null) return
      const items = [...dataTransfer.items]
      // 过滤无 MIME 的目录，上传签名不支持目录。
      const files = [...dataTransfer.files].filter(
        (_file, index) => items[index]?.webkitGetAsEntry()?.isDirectory !== true,
      )
      if (files.length === 0) return
      const editorDom = editorRef.current.viewRef.current?.dom
      const pos =
        editorDom !== undefined && event.target instanceof Node && editorDom.contains(event.target)
          ? editorRef.current.posAtCoords(event.clientX, event.clientY)
          : undefined
      editorRef.current.insertFiles(files, pos)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [attachmentsEnabled])

  const canSend = canSendNow()

  return (
    <div
      className={cn(
        'composer-card relative rounded-3xl border-[0.5px] border-chat-hairline bg-top-layer shadow-[var(--shadow-input)]',
        'transition-[border-color,box-shadow,background-color] ui-motion-m',
        'focus-within:border-border-hover',
        dragOver && 'bg-primary-container-soft',
        className,
      )}
    >
      {references.length > 0 ? (
        <div aria-label="引用" className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
          {references.map((reference) => (
            <Tag key={reference.id}>
              {reference.label}
              <IconButton
                className="-mr-1.5"
                label={`不再引用 ${reference.label}`}
                name="close"
                onClick={reference.onRemove}
                size="xs"
              />
            </Tag>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <div ref={mountEditor} />
        {editor.empty ? (
          <div aria-hidden className="composer-placeholder-overlay">
            {placeholder}
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-2">
        <div className="flex items-center gap-1">
          {attachmentsEnabled ? (
            <IconButton
              label="添加附件"
              name="add"
              onClick={() => fileInputRef.current?.click()}
              size="md"
            />
          ) : null}
          {leading}
        </div>
        <div className="flex items-center gap-2">
          {trailing}
          {busy && onStop !== undefined ? (
            <button
              aria-label="停止"
              className={cn(
                'grid size-(--control-height-md) ui-state cursor-pointer place-items-center rounded-full ui-focus',
                'bg-surface-container-high text-error shadow-[var(--shadow-xs)] hover:bg-error hover:text-on-error active:scale-95',
              )}
              onClick={onStop}
              type="button"
            >
              <Icon decorative name="stopped" size="md" />
            </button>
          ) : (
            <button
              aria-label="发送"
              className={cn(
                'grid size-(--control-height-md) ui-state cursor-pointer place-items-center rounded-full ui-focus',
                canSend
                  ? 'bg-inverse-surface text-inverse-on-surface shadow-[var(--shadow-send)] active:scale-95'
                  : 'bg-surface-container-high',
              )}
              disabled={!canSend}
              onClick={submit}
              type="button"
            >
              <Icon
                className={cn(sending && 'animate-spin')}
                decorative
                name={sending ? 'loading' : 'send-up'}
                size="md"
              />
            </button>
          )}
        </div>
      </div>
      {attachmentsEnabled ? (
        <input
          aria-hidden
          className="hidden"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = '' // 清空文件输入值，允许再次选择同一文件。
            if (files.length > 0) editorRef.current.insertFiles(files)
          }}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
      ) : null}
      {pillHosts.map((host) =>
        createPortal(
          <ComposerAttachmentPill
            entry={attachments.entries.get(host.attId)}
            hostEl={host.el}
            kind={host.kind}
            name={host.name}
          />,
          host.el,
          host.attId,
        ),
      )}
      {dragOver
        ? createPortal(
            <div
              aria-hidden
              className="composer-drop-overlay layer-overlay animate-in duration-(--dur-s) fade-in"
            >
              <div className="composer-drop-card">
                <Icon decorative name="add-file" size="lg" />
                松开鼠标添加附件
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
