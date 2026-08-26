import type { Conversation } from '@/features/conversations'
import type { VideoTask, VideoTaskAsset, VideoTaskOverviewField } from '@/features/tasks'
import type {
  StoryboardCreativeInput,
  StoryboardInputImage,
  StoryboardInputVideo,
  Storyboard,
  StoryboardWorkspace,
} from '@/features/storyboards/model/storyboard-workspace'

const EMPTY_BRIEF_VALUE = '未填写'

/**
 * 读取 Task Brief 中的字符串字段，并把未填写状态显式呈现给用户。
 *
 * @param task - Storyboard 来源 Task。
 * @param key - 需要读取的稳定 Brief 键。
 * @returns 已填写的字符串，或明确的未填写文案。
 */
const readBriefValue = (task: VideoTask, key: VideoTaskOverviewField) => {
  const value = task.brief[key]
  return typeof value === 'string' && value.trim() ? value.trim() : EMPTY_BRIEF_VALUE
}

/**
 * 读取 Brief 中的可选文本字段；空白视为未填写。
 *
 * @param value - Task Brief 中的原始字符串。
 * @returns 去除首尾空白的文本，未填写时返回 undefined。
 */
const trimmedBriefText = (value: string | undefined) => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * 读取 Task 引用的全局素材；缺失时直接暴露数据完整性错误。
 *
 * @param assetsById - Task 快照中的素材索引。
 * @param assetId - Task 保存的稳定素材 ID。
 * @returns 对应的全局素材记录。
 * @throws Task 引用了不存在的素材时抛出错误。
 */
const requireTaskAsset = (
  assetsById: Record<string, VideoTaskAsset>,
  assetId: string,
): VideoTaskAsset => {
  const asset = assetsById[assetId]
  if (!asset) {
    throw new Error(`Task 引用的素材不存在：${assetId}`)
  }
  return asset
}

/**
 * 校验素材 MIME 与业务角色一致，并返回可发送给 Agent 的 MIME。
 *
 * @param asset - Task 引用的全局素材。
 * @param expectedPrefix - 当前角色要求的 MIME 前缀。
 * @returns 已校验的非空 MIME。
 * @throws 后端素材缺少 MIME 或类型不匹配时抛出错误。
 */
const requireAssetMimeType = (asset: VideoTaskAsset, expectedPrefix: 'image/' | 'video/') => {
  if (!asset.mimeType || !asset.mimeType.startsWith(expectedPrefix)) {
    throw new Error(`素材 ${asset.id} 缺少有效的 ${expectedPrefix.slice(0, -1)} MIME 类型`)
  }

  return asset.mimeType
}

/**
 * 把指定图片角色的素材 ID 转换为 Storyboard 输入图片。
 *
 * @param assetIds - Task 中按业务顺序保存的素材 ID。
 * @param assetsById - Task 快照中的素材索引。
 * @param label - 用户可见的素材角色。
 * @returns 保持 Task 顺序的 Storyboard 图片输入。
 */
const createInputImages = (
  assetIds: string[],
  assetsById: Record<string, VideoTaskAsset>,
  label: string,
): StoryboardInputImage[] =>
  assetIds.map((assetId, index) => {
    const asset = requireTaskAsset(assetsById, assetId)
    if (asset.assetType !== 'image') {
      throw new Error(`${label}必须是图片素材：${assetId}`)
    }

    return {
      aspectRatio: '4:3',
      id: asset.id,
      mimeType: requireAssetMimeType(asset, 'image/'),
      previewUrl: asset.url,
      title: `${label} ${index + 1}`,
    }
  })

/**
 * 把 Task 参考视频转换为 Storyboard 视频输入。
 *
 * @param assetIds - Task 中按业务顺序保存的参考视频素材 ID。
 * @param assetsById - Task 快照中的素材索引。
 * @returns 保持 Task 顺序的 Storyboard 视频输入。
 */
const createInputVideos = (
  assetIds: string[],
  assetsById: Record<string, VideoTaskAsset>,
): StoryboardInputVideo[] =>
  assetIds.map((assetId, index) => {
    const asset = requireTaskAsset(assetsById, assetId)
    if (asset.assetType !== 'video') {
      throw new Error(`参考视频必须是视频素材：${assetId}`)
    }

    return {
      aspectRatio: '16:9',
      id: asset.id,
      mimeType: requireAssetMimeType(asset, 'video/'),
      previewUrl: asset.url,
      title: `参考视频 ${index + 1}`,
    }
  })

/**
 * 把一张需求单的历次尝试映射为 Storyboard 工作台。
 *
 * 一次尝试就是一段对话；顺序由后端给（按开始时间正序），左侧书签的编号就是第几次。
 * Task 只提供创作输入，所以这里不包含镜头——不把产品图或参考视频伪装成 Agent 已经
 * 生成的 Storyboard 帧。
 *
 * @param task - 这个页面对应的需求单。
 * @param conversations - 这张单下自己开过的对话，按开始时间正序。
 * @param assetsById - 快照中按地址索引的真实素材。
 * @returns 这张单的 Storyboard 工作台。
 */
export const createStoryboardWorkspace = (
  task: VideoTask,
  conversations: Conversation[],
  assetsById: Record<string, VideoTaskAsset>,
): StoryboardWorkspace => ({
  storyboards: conversations.map((conversation) =>
    createStoryboardFromTask(conversation, task, assetsById),
  ),
})

/**
 * 把 Task Brief 与素材映射为 Storyboard Agent 消费的创作输入。
 *
 * @param task - Storyboard 来源 Task。
 * @param assetsById - 快照中按 ID 索引的真实素材。
 * @returns 含参考图 / 参考视频的创作输入。
 */
export const createStoryboardCreativeInputFromTask = (
  task: VideoTask,
  assetsById: Record<string, VideoTaskAsset>,
): StoryboardCreativeInput => ({
  audience: readBriefValue(task, 'audience'),
  durationSeconds: task.brief.durationSeconds,
  purpose: readBriefValue(task, 'purpose'),
  ratio: trimmedBriefText(task.brief.ratio),
  referenceImages: createInputImages(task.brief.referenceImages, assetsById, '参考图'),
  referenceVideos: createInputVideos(task.brief.referenceVideos, assetsById),
  requirementDescription: trimmedBriefText(task.brief.requirementDescription),
  scene: readBriefValue(task, 'scene'),
  selling: readBriefValue(task, 'selling'),
  styleNo: task.style.styleNo,
  theme: readBriefValue(task, 'theme'),
})

/**
 * 把一段对话映射为左侧书签上的一次尝试。
 *
 * @param conversation - 这次尝试的对话。
 * @param task - 这段对话所属的需求单。
 * @param assetsById - 列表快照中按地址索引的真实素材。
 * @param title - 可选的展示标题，默认用需求单标题。
 * @returns 尚未运行 Agent 的 Storyboard 视图。
 */
export const createStoryboardFromTask = (
  conversation: Conversation,
  task: VideoTask,
  assetsById: Record<string, VideoTaskAsset>,
  title = task.title,
): Storyboard => {
  const creativeInput = createStoryboardCreativeInputFromTask(task, assetsById)

  return {
    confirmedAt: null,
    conversationId: conversation.id,
    creativeInput,
    modelLabel: 'Nano Banana',
    shots: [],
    // published 与 confirmed 都是可创作来源，Brief 即已确认。
    status: task.status === 'published' || task.status === 'confirmed' ? 'confirmed' : 'draft',
    title,
    videoTaskId: task.id,
  }
}
