import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type {
  MediaComposerDocument,
  MediaComposerLibraryMedia,
  MediaComposerReference,
} from '@/shared/composer/media-composer'
import { createMediaComposerReferenceMap } from '@/shared/composer/media-composer'
import type { ComposerFileAttachment } from '@/shared/composer/composer.types'
import { createMediaComposerExtensions } from '@/shared/composer/media-composer-extensions'
import { EditorReferenceProvider, type EditorReference } from '@/shared/editor'
import { cn } from '@/shared/lib/utils'

interface MediaComposerEditorProps {
  ariaLabel: string
  attachments: ComposerFileAttachment[]
  className?: string
  disabled?: boolean
  document: MediaComposerDocument
  focusRequestKey?: number
  libraryMedia?: MediaComposerLibraryMedia[]
  onDocumentChange: (document: MediaComposerDocument) => void
  onFilesSelected: (files: File[]) => void
  onOpenMediaPreview: (reference: MediaComposerReference) => void
  onSubmitRequest: () => void
}

const EMPTY_LIBRARY_MEDIA: MediaComposerLibraryMedia[] = []

/**
 * 渲染只暴露 Media Composer 领域 interface 的 Tiptap 编辑器。
 *
 * @param props - 文档、引用目录与页面 intent。
 * @returns 隐藏 Editor、Suggestion 和 ProseMirror 状态的编辑器组件。
 */
export default function MediaComposerEditor({
  ariaLabel,
  attachments,
  className,
  disabled = false,
  document,
  focusRequestKey = 0,
  libraryMedia = EMPTY_LIBRARY_MEDIA,
  onDocumentChange,
  onFilesSelected,
  onOpenMediaPreview,
  onSubmitRequest,
}: MediaComposerEditorProps) {
  const references = useMemo(
    () => createMediaComposerReferenceMap({ attachments, libraryMedia }),
    [attachments, libraryMedia],
  )
  const runtimeRef = useRef({
    onFilesSelected,
    onOpenMediaPreview,
    onSubmitRequest,
    references,
  })
  const referenceContextValue = useMemo(
    () => ({
      onActivate: (reference: EditorReference) => {
        const currentReference = runtimeRef.current.references.get(reference.id)
        if (!currentReference) throw new Error(`Media Composer 引用不存在：${reference.id}`)
        runtimeRef.current.onOpenMediaPreview(currentReference)
      },
      references,
    }),
    [references],
  )

  useLayoutEffect(() => {
    runtimeRef.current = {
      onFilesSelected,
      onOpenMediaPreview,
      onSubmitRequest,
      references,
    }
  }, [onFilesSelected, onOpenMediaPreview, onSubmitRequest, references])

  const extensions = useMemo(
    () =>
      createMediaComposerExtensions({
        getReferences: () => runtimeRef.current.references,
        onFilesSelected: (files) => runtimeRef.current.onFilesSelected(files),
        onSubmitRequest: () => runtimeRef.current.onSubmitRequest(),
      }),
    [],
  )

  const editor = useEditor(
    {
      content: document,
      editable: !disabled,
      editorProps: {
        attributes: {
          'aria-label': ariaLabel,
          'aria-multiline': 'true',
          class: 'w-full bg-transparent text-[var(--color-on-background)]',
        },
      },
      enableContentCheck: true,
      extensions,
      onUpdate: ({ editor: currentEditor }) => {
        onDocumentChange(currentEditor.getJSON())
      },
    },
    [extensions],
  )

  useEffect(() => {
    editor.setEditable(!disabled, false)
  }, [disabled, editor])

  useEffect(() => {
    editor.view.dom.setAttribute('aria-label', ariaLabel)
  }, [ariaLabel, editor])

  useLayoutEffect(() => {
    const nextDocument = editor.schema.nodeFromJSON(document)

    if (!editor.state.doc.eq(nextDocument)) {
      editor.commands.setContent(document, {
        emitUpdate: false,
        errorOnInvalidContent: true,
      })
    }
  }, [document, editor])

  useEffect(() => {
    if (focusRequestKey === 0) {
      return
    }

    editor.commands.focus('end')
  }, [editor, focusRequestKey])

  return (
    <EditorReferenceProvider {...referenceContextValue}>
      <div className={cn('chat-tiptap-v3 composer-editor relative flex w-full flex-1', className)}>
        <EditorContent className="tiptap-editor w-full" editor={editor} />
      </div>
    </EditorReferenceProvider>
  )
}
