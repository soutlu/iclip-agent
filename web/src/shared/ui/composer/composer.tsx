/**
 * 输入卡：32 大圆角卡，ProseMirror 编辑区 + 下工具行。
 *
 * 形状对齐 kimi Code Web 的 composer：0.5px 发丝边框（chat-hairline），常驻 shadow-input；
 * focus-within 只把边框加深到 border-hover（≥3:1 的自定义焦点指示），不抬升阴影；支持的浏览器
 * 用 superellipse 连续曲率（composer.css）。编辑器是 PM（schema 见 editor-schema.ts）：
 * Enter 发送、Shift+Enter 换行、IME 组字期间的 Enter 不触发发送。
 * 深色下卡面用 top-layer（比主区亮一档；浅色都是白）。
 *
 * 附件（attachmentsEnabled 时才有这条线）：`+` 钮开文件选择框、拖文件进窗口（卡片变色 +
 * 全屏虚线遮罩，落在编辑区插目测光标位）、粘贴剪贴板文件——都落成文字流里的内联 pill
 * （attachment-pill）。上传中或失败时发送被禁（照 kimi 的 blocked 语义）；只有附件没有字
 * 也能发。
 *
 * 工具行里放什么由调用方给：首页要 agent 选择与合集条，会话页只要发送。
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ReactNode, Ref } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { Tag } from '@/shared/ui/tag'
import { ComposerAttachmentPill } from './composer-attachment-pill'
import { readComposerText } from './editor-schema'
import type { ComposerPillHost } from './use-composer-editor'
import { useComposerEditor } from './use-composer-editor'
import type { ComposerSubmission } from './use-composer-attachments'
import { useComposerAttachments } from './use-composer-attachments'

/** 输入卡的命令式句柄：发送成败之后调用方用它们收放内容。 */
export type ComposerHandle = {
  /** 清空整篇（文字 + 附件 pill）。 */
  clear: () => void
  /** 发送失败把内容还回来：附件排在文字前。 */
  restore: (submission: ComposerSubmission) => void
  focus: () => void
}

type ComposerProps = {
  /** 按回车或点发送时调用（带上当时的文字与可发送附件）。内容为空或附件未就绪时不会触发。 */
  onSubmit: (submission: ComposerSubmission) => void
  placeholder?: string
  /** 工具行左侧那几个控件（在附件钮之后）。 */
  leading?: ReactNode
  /** 发送钮左边那几个控件。 */
  trailing?: ReactNode
  /** 正在提交这一条：发送钮转圈并禁用。 */
  sending?: boolean
  /** 紧凑形态：单行起步随内容长高（会话页）；缺省三行起步（首页 hero）。 */
  dense?: boolean
  /**
   * 这段对话正在跑：发送钮换成停止钮。
   *
   * 换的是钮而不是禁用态——输入框空着时发送本来就是禁用的，那样就没法停了。
   */
  busy?: boolean
  onStop?: (() => void) | undefined
  /** 附件上传入口（+ 钮 / 拖放 / 粘贴）。调用方按登录态与 assets:write 权限给。 */
  attachmentsEnabled?: boolean
  /**
   * 编辑区上方那排引用芯片（工作台里选中的组 / 帧）。
   *
   * 不塞进 PM 文档：它不是用户打的字，删掉一条也不该进撤销栈；发送时怎么变成文字由调用方定。
   */
  references?: readonly { id: string; label: string; onRemove: () => void }[]
  /** 命令式句柄 ref。 */
  ref?: Ref<ComposerHandle>
  className?: string
}

/**
 * 渲染输入卡。
 *
 * @param props - 组件属性。
 * @returns 输入卡。
 */
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

  /**
   * 当前能不能发：有内容（文字或 pill）且文档引着的附件全部就绪（照 kimi 的 blocked 语义）。
   * useComposerEditor 每次渲染都把这份闭包镜像进它的 ref，PM 事件里读到的永远是最新渲染的值。
   */
  const canSendNow = () => {
    if (sending || editor.empty) return false
    return !editor.attIds.some((attId) => attachments.entries.get(attId)?.status !== 'ready')
  }

  /** 组一份提交内容并交给调用方；能不能发在 Enter 与发送钮两处都已分别把过。 */
  const submit = () => {
    const view = editor.viewRef.current
    if (view === null || !canSendNow()) return
    const text = readComposerText(view.state.doc).trim()
    onSubmit({ media: attachments.takeReady(editor.attIds), text })
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
  // 解构出来再传给 ref=：直接写 ref={editor.mountEditor} 会撞 react-hooks/refs 的启发式
  const { mountEditor } = editor

  // 命令式句柄与 window 级拖放监听器经 ref 读最新的编辑器命令
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

  // 拖放：window 级计数防闪（dragenter/dragleave 在子元素间成对触发），只认 Files
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
      event.preventDefault() // 不拦就不允许 drop
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
      // 文件夹不收（没有 MIME，签名一步也过不了）
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
                // 禁用时 ui-state 把图标压成 disabled-text，灰底灰箭头对齐 kimi 的禁用发送钮
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
            event.target.value = '' // 清掉才允许重选同一份文件（照 kimi）
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
            attId={host.attId}
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
