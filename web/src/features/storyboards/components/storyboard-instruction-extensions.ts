import type { Extensions } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import { createStoryboardInstructionMention } from '@/features/storyboards/components/storyboard-instruction-reference.extension'
import {
  configureEditorFileHandler,
  PlainTextStarterKit,
  type EditorReferenceMap,
} from '@/shared/editor'

interface CreateStoryboardInstructionExtensionsOptions {
  getReferences: () => EditorReferenceMap
  onFilesSelected: (files: File[]) => void
  placeholder: string
}

/**
 * 创建 Storyboard 修改指令编辑器唯一的 Tiptap extension 集合。
 *
 * @param options - 当前 Editor 的引用目录、文件接入与占位文案依赖。
 * @returns 严格 schema、共享 Mention 与官方 FileHandler 的 extension 集合。
 */
export const createStoryboardInstructionExtensions = ({
  getReferences,
  onFilesSelected,
  placeholder,
}: CreateStoryboardInstructionExtensionsOptions): Extensions => [
  PlainTextStarterKit,
  Placeholder.configure({ placeholder }),
  createStoryboardInstructionMention({ getReferences }),
  configureEditorFileHandler({ onFilesSelected }),
]
