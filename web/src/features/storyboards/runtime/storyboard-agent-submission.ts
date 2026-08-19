import type { CreateAppendMessage, ThreadUserMessagePart } from '@assistant-ui/react'
import type {
  StoryboardInputImage,
  StoryboardInputVideo,
  Storyboard,
} from '@/features/storyboards/model/storyboard-workspace'

/** 提交只消费 creativeInput，允许调试页等场景不构造完整 Storyboard。 */
type StoryboardSubmissionSource = Pick<Storyboard, 'creativeInput'>

type IndexedStoryboardMedia = {
  alias: string
  media: StoryboardInputImage | StoryboardInputVideo
}

const indexStoryboardMedia = (storyboard: StoryboardSubmissionSource): IndexedStoryboardMedia[] => [
  ...storyboard.creativeInput.referenceImages.map((media, index) => ({
    alias: `image_${index + 1}`,
    media,
  })),
  ...storyboard.creativeInput.referenceVideos.map((media, index) => ({
    alias: `video_${index + 1}`,
    media,
  })),
]

const createMediaFilePart = ({ alias, media }: IndexedStoryboardMedia): ThreadUserMessagePart => ({
  data: media.previewUrl,
  filename: alias,
  mimeType: media.mimeType,
  type: 'file',
})

const EMPTY_INPUT_VALUE = '未填写'

/** Storyboard Agent 首条消息 prompt 消费的三个表单字段。 */
export type StoryboardBriefPromptInput = Pick<
  Storyboard['creativeInput'],
  'durationSeconds' | 'ratio' | 'requirementDescription'
>

/** 把三字段创作要求构造成 Storyboard Agent 首条消息正文。 */
export const createStoryboardBriefPrompt = (input: StoryboardBriefPromptInput) => {
  const lines = [
    '请基于以下创作要求和参考素材，按创作流程要求生成可执行的 Storyboard，用中文回复。',
    '',
    '## 创作要求',
    `- 目标画幅：${input.ratio ?? EMPTY_INPUT_VALUE}`,
    `- 目标时长：${input.durationSeconds ? `${input.durationSeconds} 秒` : EMPTY_INPUT_VALUE}`,
    '',
    '## 需求描述',
    // 需求描述整段透传；口播旁白按跨仓约定包含在这段文本内，不拆平行字段。
    input.requirementDescription ?? EMPTY_INPUT_VALUE,
  ]

  return lines.join('\n')
}

const createStoryboardAgentPrompt = (storyboard: StoryboardSubmissionSource) =>
  createStoryboardBriefPrompt(storyboard.creativeInput)

/**
 * 把 Storyboard 创作输入构造成 AG-UI 首条 user 消息。
 *
 * 参考素材以媒体 part 直接排在正文之后（媒体只活在 content，attachments
 * 恒空）；服务端按用户账本对 URL 去重，Task 导入素材复用既有身份。
 *
 * @param storyboard - 当前 Storyboard 工作台数据（只消费 creativeInput）。
 * @returns 可直接传给 assistant-ui thread.append 的消息。
 */
export const createStoryboardAgentSubmission = (
  storyboard: StoryboardSubmissionSource,
): CreateAppendMessage => {
  const indexedMedia = indexStoryboardMedia(storyboard)

  return {
    attachments: [],
    content: [
      { text: createStoryboardAgentPrompt(storyboard), type: 'text' },
      ...indexedMedia.map(createMediaFilePart),
    ],
    createdAt: new Date(),
    parentId: null,
    role: 'user',
    sourceId: null,
    startRun: true,
  }
}
