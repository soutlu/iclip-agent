import { generateText, getSchema, type JSONContent, type TextSerializer } from '@tiptap/core'
import {
  toStoryboardEditorReference,
  type StoryboardInstructionReference,
} from '@/features/storyboards/components/storyboard-instruction-reference'
import {
  createEditorReferenceMap,
  createStableReferenceMention,
  hasEditorText,
  parseStrictEditorDocument,
  PlainTextStarterKit,
} from '@/shared/editor'

export const STORYBOARD_INSTRUCTION_REFERENCE_NODE_NAME = 'storyboardInstructionReference'

export const StoryboardInstructionReferenceMention = createStableReferenceMention(
  STORYBOARD_INSTRUCTION_REFERENCE_NODE_NAME,
)

export const STORYBOARD_INSTRUCTION_SCHEMA_EXTENSIONS = [
  PlainTextStarterKit,
  StoryboardInstructionReferenceMention,
]

const STORYBOARD_INSTRUCTION_SCHEMA = getSchema(STORYBOARD_INSTRUCTION_SCHEMA_EXTENSIONS)

export type StoryboardInstructionDocument = JSONContent

export type StoryboardInstructionSubmission = {
  instruction: string
}

/**
 * 表示 Storyboard 修改指令引用无法从当前目录解析。
 *
 * @param referenceId - 无法解析的稳定引用 ID。
 */
export class InvalidStoryboardInstructionReferenceError extends Error {
  constructor(referenceId: string) {
    super(`Storyboard 修改指令引用不存在：${referenceId || 'unknown'}`)
    this.name = 'InvalidStoryboardInstructionReferenceError'
  }
}

/**
 * 表示 Storyboard 修改指令只包含结构化引用，没有用户文字说明。
 */
export class MentionOnlyStoryboardInstructionError extends Error {
  constructor() {
    super('Storyboard 修改指令不能只包含引用。')
    this.name = 'MentionOnlyStoryboardInstructionError'
  }
}

type CreateStoryboardInstructionSubmissionOptions = {
  document: StoryboardInstructionDocument
  references: StoryboardInstructionReference[]
}

/**
 * 创建可直接交给 Tiptap 的空 Storyboard 修改指令文档。
 *
 * @returns 只包含一个空段落且符合当前 schema 的文档。
 */
export const createEmptyStoryboardInstructionDocument = (): StoryboardInstructionDocument => ({
  content: [{ type: 'paragraph' }],
  type: 'doc',
})

/**
 * 以稳定 ID 建立当前镜头的引用目录，并拒绝含糊的提交别名。
 *
 * @param references - 当前镜头可引用的媒体与画面标注。
 * @returns 供 Editor、NodeView 和提交投影共同读取的引用目录。
 */
export const createStoryboardInstructionReferenceMap = (
  references: StoryboardInstructionReference[],
) => createEditorReferenceMap(references.map(toStoryboardEditorReference))

/**
 * 在提交 seam 把 TipTap JSON 投影为业务层纯文本，不向页面或后端泄漏 Editor。
 *
 * @param options - 当前前端草稿文档与最新引用目录。
 * @returns Storyboard 本地版本记录使用的纯文本修改指令。
 * @throws JSON 不符合当前 schema、别名重复或引用已经失效时抛出错误。
 */
export const createStoryboardInstructionSubmission = ({
  document,
  references,
}: CreateStoryboardInstructionSubmissionOptions): StoryboardInstructionSubmission => {
  const parsedDocument = parseStrictEditorDocument(
    document,
    STORYBOARD_INSTRUCTION_SCHEMA,
    'Storyboard 修改指令文档',
  )
  const referencesById = createStoryboardInstructionReferenceMap(references)

  const referenceSerializer: TextSerializer = ({ node }) => {
    const referenceId = typeof node.attrs.id === 'string' ? node.attrs.id : ''
    const reference = referencesById.get(referenceId)

    if (!reference) {
      throw new InvalidStoryboardInstructionReferenceError(referenceId)
    }

    return `@${reference.label}`
  }

  const instruction = generateText(parsedDocument, STORYBOARD_INSTRUCTION_SCHEMA_EXTENSIONS, {
    blockSeparator: '\n',
    textSerializers: {
      [STORYBOARD_INSTRUCTION_REFERENCE_NODE_NAME]: referenceSerializer,
    },
  }).trim()

  if (instruction.length > 0 && !hasEditorText(parsedDocument)) {
    throw new MentionOnlyStoryboardInstructionError()
  }

  return { instruction }
}
