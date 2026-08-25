export type VideoTaskStatus = 'confirmed' | 'draft' | 'published' | 'withdrawn'

export type ProductInfoImage = {
  /** 图片所属颜色（与 colors 的 name 同一取值域），源数据缺失时为 null。 */
  color: string | null
  id: string
  url: string
}

/** ERP 中该 Style 的一个最新有效颜色。 */
export type ProductInfoColor = {
  id: string
  name: string
}

export type ProductInfo = {
  brand: string
  category: string
  colors: ProductInfoColor[]
  images: ProductInfoImage[]
  styleNo: string
}

/** Task Brief 中“概述”分组的规范字段。 */
export type VideoTaskOverview = {
  audience: string
  purpose: string
  scene: string
  selling: string
  theme: string
}

export type VideoTaskOverviewField = keyof VideoTaskOverview

/** Task Brief 中“关键元素”分组的规范字段。 */
export type VideoTaskKeyElements = {
  department: string
  /** 成片目标时长，单位秒。 */
  durationSeconds: number
  language: string
  platform: string
  ratio: string
  /** 广告片形态：品牌视频 / 产品视频 / 短视频 等。 */
  videoType: string
}

export type VideoTaskKeyElementField = keyof VideoTaskKeyElements

/** 下发 Task 需求简报新增的规范字段。 */
export type VideoTaskRequirement = {
  /** 颜色要求。 */
  color: string
  /** 内容类型：穿搭、开箱等。 */
  contentType: string
  /** 需求人（飞书用户名）。 */
  requester: string
  /** 需求描述：按段落换行的纯文本。 */
  requirementDescription: string
}

/** 创建阶段允许只填写部分字段，关键元素由页面提供默认选择。 */
export type VideoTaskBriefFields = Partial<
  VideoTaskKeyElements & VideoTaskOverview & VideoTaskRequirement
> & {
  /** 多选 Style 号全集（含主 Style，主 Style 排首位）。 */
  styleNos?: string[]
}

export type VideoTaskBrief = VideoTaskBriefFields & {
  referenceImages: string[]
  referenceVideos: string[]
}

export type VideoTask = {
  brief: VideoTaskBrief
  createdAt: string
  /** 提这张需求单的人。草稿只有本人或治理者能改，前端靠它决定按钮给不给点。 */
  creatorUserId: string
  deadline: null | string
  id: string
  priority: number
  status: VideoTaskStatus
  style: {
    brand: string
    category: string
    previewImageUrl: string
    styleNo: string
  }
  title: string
  updatedAt: string
}

/**
 * 任务引用的一份参考素材。
 *
 * `id` 就是 `url`：brief 里存的是地址，这份索引也按地址建（见 `video-task.api.ts` 的
 * `indexTaskAssets`）。`mimeType` 从地址的扩展名读，认不出来是 `null`。
 */
export type VideoTaskAsset = {
  assetType: 'image' | 'video'
  id: string
  mimeType: null | string
  url: string
}

export type VideoTaskSnapshot = {
  assetsById: Record<string, VideoTaskAsset>
  tasks: VideoTask[]
}

export type CreateVideoTaskInput = {
  brief: VideoTaskBriefFields
  deadline: string
  referenceImages: File[]
  referenceVideos: File[]
  styleNo: string
}
