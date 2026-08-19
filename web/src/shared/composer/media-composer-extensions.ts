import type { Extensions } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import type { MediaComposerReferenceMap } from '@/shared/composer/media-composer'
import { MediaComposerStarterKit } from '@/shared/composer/media-composer-schema'
import { configureMediaReferenceMention } from '@/shared/composer/media-reference.extension'
import { ComposerSubmitExtension } from '@/shared/composer/composer-submit.extension'
import { configureEditorFileHandler } from '@/shared/editor'

interface CreateMediaComposerExtensionsOptions {
  getReferences: () => MediaComposerReferenceMap
  onFilesSelected: (files: File[]) => void
  onSubmitRequest: () => void
}

const MEDIA_COMPOSER_PLACEHOLDER = '上传参考图片、视频或音频，输入文字描述，或输入 @ 引用已上传媒体'

/**
 * 创建 Media Composer 唯一的 Tiptap extension 集合。
 *
 * @param options - 当前 Editor 的 catalog、UI intent 和文案依赖。
 * @returns 严格 schema、官方 Mention/Suggestion/FileHandler 与提交 keymap。
 */
export const createMediaComposerExtensions = ({
  getReferences,
  onFilesSelected,
  onSubmitRequest,
}: CreateMediaComposerExtensionsOptions): Extensions => [
  MediaComposerStarterKit,
  Placeholder.configure({ placeholder: MEDIA_COMPOSER_PLACEHOLDER }),
  configureMediaReferenceMention({ getReferences }),
  configureEditorFileHandler({ onFilesSelected }),
  ComposerSubmitExtension.configure({ onSubmitRequest }),
]
