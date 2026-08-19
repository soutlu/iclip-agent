export { PlainTextStarterKit } from '@/shared/editor/plain-text-starter-kit'
export { configureEditorReferenceMention } from '@/shared/editor/configure-editor-reference-mention'
export { hasEditorText, parseStrictEditorDocument } from '@/shared/editor/editor-document'
export { configureEditorFileHandler } from '@/shared/editor/editor-file-handler'
export {
  createEditorMediaReference,
  createEditorReferenceMap,
  EDITOR_REFERENCE_KINDS,
  removeEditorReferencesFromDocument,
  searchEditorReferences,
  type EditorReference,
  type EditorReferenceKind,
  type EditorReferenceMap,
  type EditorReferenceMediaSource,
  type EditorMediaReference,
  type CreateEditorMediaReferenceOptions,
} from '@/shared/editor/editor-reference'
export { EditorReferenceProvider } from '@/shared/editor/editor-reference-provider'
export {
  EditorReferenceChip,
  EditorReferenceSuggestionMenu,
} from '@/shared/editor/editor-reference-ui'
export {
  EditorReferenceIcon,
  type EditorReferenceIconProps,
} from '@/shared/editor/editor-reference-icon'
export { createStableReferenceMention } from '@/shared/editor/stable-reference-mention'
