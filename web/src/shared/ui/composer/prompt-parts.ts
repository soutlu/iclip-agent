/** 把一条消息的 content 翻成输入框的 parts；媒体复用原有公网地址，不重新上传。 */

import { fileNameOfUrl } from '@/shared/lib/media-url'
import type { PromptContentPart } from '@/shared/transcript/vendor'
import { mediaDisplayName } from '@/shared/ui/media-preview'
import { type ComposerPart, readyAttachment } from './use-composer-attachments'

/** 保持 part 顺序；修改已发消息与粘贴复制来的消息共用它。 */
export const composerParts = (content: readonly PromptContentPart[]): ComposerPart[] =>
  content.map((part) =>
    part.type === 'text'
      ? { kind: 'text', text: part.text }
      : {
          kind: 'media',
          media: readyAttachment({
            kind: part.type,
            name: mediaDisplayName({ kind: part.type, name: fileNameOfUrl(part.source.url) }),
            url: part.source.url,
          }),
        },
  )
