import { useMemo, type PropsWithChildren } from 'react'
import {
  EditorReferenceContext,
  type EditorReferenceContextValue,
} from '@/shared/editor/editor-reference-context'

/**
 * 为 Tiptap React NodeView 提供当前引用目录与可选激活行为。
 *
 * @param props - 子树、只读引用目录和可选的媒体预览回调。
 * @returns 稳定 Context value 包裹的编辑器子树。
 */
export function EditorReferenceProvider({
  children,
  onActivate,
  references,
}: PropsWithChildren<EditorReferenceContextValue>) {
  const value = useMemo(() => ({ onActivate, references }), [onActivate, references])

  return <EditorReferenceContext.Provider value={value}>{children}</EditorReferenceContext.Provider>
}
