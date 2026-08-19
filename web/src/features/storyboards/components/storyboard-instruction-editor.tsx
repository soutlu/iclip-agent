import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { StoryboardInstructionReference } from '@/features/storyboards/components/storyboard-instruction-reference'
import { createStoryboardInstructionExtensions } from '@/features/storyboards/components/storyboard-instruction-extensions'
import {
  createStoryboardInstructionReferenceMap,
  STORYBOARD_INSTRUCTION_REFERENCE_NODE_NAME,
  type StoryboardInstructionDocument,
} from '@/features/storyboards/components/storyboard-instruction'
import { EditorReferenceProvider } from '@/shared/editor'

export type {
  StoryboardAnnotationReference,
  StoryboardImageReference,
} from '@/features/storyboards/components/storyboard-instruction-reference'
export type { StoryboardInstructionReference }

export type StoryboardInstructionInsertRequest = {
  id: string
  requestId: number
}

interface StoryboardInstructionEditorProps {
  ariaLabel: string
  document: StoryboardInstructionDocument
  id?: string
  insertReferenceRequest: StoryboardInstructionInsertRequest | null
  onDocumentChange: (document: StoryboardInstructionDocument) => void
  onFilesSelected: (files: File[]) => void
  placeholder?: string
  references: StoryboardInstructionReference[]
}

const STORYBOARD_INSTRUCTION_PLACEHOLDER = '描述你想怎么改这一镜…'

/**
 * Storyboard 修改指令的领域编辑器。React 持有 JSON 草稿，纯文本只在提交 seam 生成。
 *
 * @param props - JSON 文档、引用目录、文件接入与外部插入请求。
 * @returns 使用共享 Mention、FileHandler 和引用视觉的 Tiptap 编辑器。
 */
export default function StoryboardInstructionEditor({
  ariaLabel,
  document,
  id,
  insertReferenceRequest,
  onDocumentChange,
  onFilesSelected,
  placeholder = STORYBOARD_INSTRUCTION_PLACEHOLDER,
  references,
}: StoryboardInstructionEditorProps) {
  const referenceMap = useMemo(
    () => createStoryboardInstructionReferenceMap(references),
    [references],
  )
  const lastHandledInsertRequestIdRef = useRef<number | null>(null)
  const runtimeRef = useRef({ onDocumentChange, onFilesSelected, referenceMap })

  useLayoutEffect(() => {
    runtimeRef.current = { onDocumentChange, onFilesSelected, referenceMap }
  }, [onDocumentChange, onFilesSelected, referenceMap])

  const extensions = useMemo(
    () =>
      createStoryboardInstructionExtensions({
        getReferences: () => runtimeRef.current.referenceMap,
        onFilesSelected: (files) => runtimeRef.current.onFilesSelected(files),
        placeholder,
      }),
    [placeholder],
  )

  const editor = useEditor(
    {
      content: document,
      editorProps: {
        attributes: {
          'aria-label': ariaLabel,
          'aria-autocomplete': 'list',
          'aria-multiline': 'true',
          class: 'storyboards-instruction-content',
          role: 'textbox',
          ...(id ? { id } : {}),
        },
      },
      enableContentCheck: true,
      extensions,
      onUpdate: ({ editor: currentEditor }) => {
        runtimeRef.current.onDocumentChange(currentEditor.getJSON())
      },
    },
    [extensions],
  )

  useLayoutEffect(() => {
    editor.view.dom.setAttribute('aria-label', ariaLabel)
    if (id) editor.view.dom.setAttribute('id', id)
    else editor.view.dom.removeAttribute('id')
  }, [ariaLabel, editor, id])

  useLayoutEffect(() => {
    const nextDocument = editor.schema.nodeFromJSON(document)
    if (editor.state.doc.eq(nextDocument)) return

    editor.commands.setContent(document, {
      emitUpdate: false,
      errorOnInvalidContent: true,
    })
  }, [document, editor])

  useEffect(() => {
    if (
      !insertReferenceRequest ||
      insertReferenceRequest.requestId === lastHandledInsertRequestIdRef.current
    ) {
      return
    }

    if (!runtimeRef.current.referenceMap.has(insertReferenceRequest.id)) {
      throw new Error(`无法插入不在当前镜头中的引用：${insertReferenceRequest.id}`)
    }

    let cancelled = false
    const request = insertReferenceRequest

    queueMicrotask(() => {
      if (cancelled) return

      lastHandledInsertRequestIdRef.current = request.requestId
      editor
        .chain()
        .focus()
        .insertContent({
          attrs: { id: request.id },
          type: STORYBOARD_INSTRUCTION_REFERENCE_NODE_NAME,
        })
        .insertContent(' ')
        .run()
    })

    return () => {
      cancelled = true
    }
  }, [editor, insertReferenceRequest])

  return (
    <EditorReferenceProvider references={referenceMap}>
      <EditorContent className="storyboards-instruction-editor tiptap-editor" editor={editor} />
    </EditorReferenceProvider>
  )
}
