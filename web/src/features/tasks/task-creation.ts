import type { PromptContentPart } from '@/shared/transcript/vendor'
import type { Task } from './tasks.api'

export type TaskCreationDraft = {
  taskId: string
  title: string
  content: readonly PromptContentPart[]
}

const OPENING = '请基于以下创作要求和参考素材，按创作流程要求生成可执行的 Storyboard，用中文回复。'

/** 预览和提交共享同一份消息；原始需求保持逐字不变，固定开场不算有效创作内容。 */
export function buildTaskCreationDraft(
  task: Pick<Task, 'id' | 'title' | 'inputs'>,
): TaskCreationDraft | null {
  const { inputs } = task
  const spec = inputs.video_spec
  const specs: string[] = []
  if (spec.aspect_ratio) specs.push(`- 目标画幅：${spec.aspect_ratio}`)
  if (spec.duration_seconds !== null) specs.push(`- 目标时长：${spec.duration_seconds} 秒`)
  if (spec.resolution.trim()) specs.push(`- 分辨率：${spec.resolution}`)

  const images = [
    ...new Set([
      ...inputs.products.flatMap((product) => product.image_oss_urls),
      ...inputs.reference_image_oss_urls.model,
    ]),
  ]
  const video = inputs.reference_video_oss_url
  if (!specs.length && !inputs.creative_requirement.trim() && !images.length && !video) return null

  const paragraphs = [OPENING]
  if (specs.length) paragraphs.push(`## 创作要求\n${specs.join('\n')}`)
  if (inputs.creative_requirement !== '') {
    paragraphs.push(`## 需求描述\n${inputs.creative_requirement}`)
  }
  const content: PromptContentPart[] = [
    { type: 'text', text: paragraphs.join('\n\n') },
    ...images.map((url): PromptContentPart => ({ type: 'image', source: { kind: 'url', url } })),
  ]
  if (video) content.push({ type: 'video', source: { kind: 'url', url: video } })
  return { taskId: task.id, title: task.title, content }
}
