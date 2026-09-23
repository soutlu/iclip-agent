/**
 * 把一帧落到各份会话缓存里的行上。
 *
 * 拓扑、额外分页、搜索结果、全部对话页的无限查询、需求单关联列表形状各不相同，行却都是同一个
 * ``ConversationOut``。这里不认形状，只认行：深遍历整份数据，id 相同且带 activity 与 ownerUserId
 * 的对象就是要改的那一行。拓扑里的合集节点也带 id，只凭 id 会把它当成行、不再往它名下的对话里找。
 */

import type { Conversation } from './conversations.api'

/** 活动帧只带轮次那三件事实，视频出片的一项保留行上原值，由重拉刷新。 */
export type ActivityPatch = Omit<Conversation['activity'], 'videoGeneration'>

/** 出片帧算不出行上的汇总，能确定的只有「这活儿又动起来了」这一件。 */
export type RowPatch = { title: string } | { activity: ActivityPatch } | { completedAt: null }

const isConversationRow = (node: unknown): node is Conversation =>
  typeof node === 'object' &&
  node !== null &&
  'id' in node &&
  'activity' in node &&
  'ownerUserId' in node

/** 一帧改不了什么就原样交回，调用方据此保持引用，无关列表不重渲。 */
export const applyPatch = (row: Conversation, patch: RowPatch): Conversation => {
  if ('title' in patch) return row.title === patch.title ? row : { ...row, title: patch.title }
  if ('completedAt' in patch) {
    return row.completedAt === null ? row : { ...row, completedAt: null }
  }
  const { activity } = patch
  // 开跑与收尾互斥，后端 touch_run 抹标记不发帧，这里照同一条不变量补上。
  const completedAt = activity.busy ? null : row.completedAt
  const same =
    completedAt === row.completedAt &&
    row.activity.busy === activity.busy &&
    row.activity.pendingInteraction === activity.pendingInteraction &&
    (row.activity.lastTurnReason ?? null) === (activity.lastTurnReason ?? null)
  return same ? row : { ...row, completedAt, activity: { ...row.activity, ...activity } }
}

/** 在一份缓存数据里找这段对话的行；没有就 undefined。 */
export const findConversationRow = (
  data: unknown,
  conversationId: string,
): Conversation | undefined => {
  if (isConversationRow(data)) return data.id === conversationId ? data : undefined
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findConversationRow(item, conversationId)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (data === null || typeof data !== 'object') return undefined
  for (const value of Object.values(data)) {
    const found = findConversationRow(value, conversationId)
    if (found !== undefined) return found
  }
  return undefined
}

/** 把补丁落到一份缓存数据里这段对话的每一行上；没有一行变化时返回原引用。 */
export const patchConversationRows = (
  data: unknown,
  conversationId: string,
  patch: RowPatch,
): unknown =>
  mapDeep(data, (node) =>
    isConversationRow(node) && node.id === conversationId ? applyPatch(node, patch) : undefined,
  )

/**
 * 深遍历数组与对象：``replace`` 给出新值的节点整个换掉、不再往里走，其余节点继续往下找。
 * 任何一层底下都没变化时保持这一层的原引用。
 */
const mapDeep = (node: unknown, replace: (node: object) => unknown): unknown => {
  if (Array.isArray(node)) {
    const next = node.map((item) => mapDeep(item, replace))
    return next.some((item, index) => item !== node[index]) ? next : node
  }
  if (node === null || typeof node !== 'object') return node
  const replaced = replace(node)
  if (replaced !== undefined) return replaced
  const fields = node as Record<string, unknown>
  const entries = Object.entries(fields).map(
    ([key, value]) => [key, mapDeep(value, replace)] as const,
  )
  return entries.some(([key, value]) => value !== fields[key]) ? Object.fromEntries(entries) : node
}
