/** 需求单在别的页面里的预览形状：只有一行标题、一段创作要求和一张封面，不带需求单的其余字段。 */

export type TaskPreview = {
  title: string
  requirement: string
  imageUrl: string | null
}

/** 预览取不到时列表要说出原因，所以读取状态跟着预览一起传。 */
export type TaskPreviewState = 'loading' | 'error' | 'ready' | 'forbidden'
