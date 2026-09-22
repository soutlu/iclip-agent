/** 需求单的封面与预览：封面规则只有这一条，卡片、参考图条与审计列表都取这里的结果。 */

import type { TaskPreview } from '@/shared/lib/task-preview'
import type { Task } from './tasks.api'

type TaskProduct = Task['inputs']['products'][number]

/**
 * 封面是第一款有商品图的首图，不用参考图替代商品。
 *
 * 地址不再过滤：后端写入与读出都校验商品图必须是带主机名的 http(s) 地址，空白地址到不了这里。
 */
export function taskCoverOf(
  products: readonly TaskProduct[],
): { product: TaskProduct; url: string } | null {
  for (const product of products) {
    const url = product.image_oss_urls[0]
    if (url !== undefined) return { product, url }
  }
  return null
}

export function taskPreviewOf(task: Task): TaskPreview {
  return {
    title: task.title,
    requirement: task.inputs.creative_requirement,
    imageUrl: taskCoverOf(task.inputs.products)?.url ?? null,
  }
}
