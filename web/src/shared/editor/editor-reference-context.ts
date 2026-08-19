import { createContext } from 'react'
import type { EditorReference, EditorReferenceMap } from '@/shared/editor/editor-reference'

export type EditorReferenceContextValue = {
  onActivate?: (reference: EditorReference) => void
  references: EditorReferenceMap
}

/** Tiptap React NodeView 读取的共享引用运行时；缺失时由 NodeView 明确报错。 */
export const EditorReferenceContext = createContext<EditorReferenceContextValue | null>(null)
