import { setupWorker } from 'msw/browser'
import { addMockCollection, addMockConversation, handlers } from './handlers'
import { markMockAwaitingApproval, markMockJustFinished } from './transcript'
import { seedMockWorkspace } from './workspace'

// 演示数据仅在浏览器侧初始化，避免影响每例清空存储的单测。
const DEMO_CONVERSATIONS = [
  '夜景延时素材生成',
  '夏季亚麻系列广告',
  '通勤背包短视频',
  '亚麻衬衫二剪',
  '产品宣传片 · 分镜生成中',
]

const seeded = DEMO_CONVERSATIONS.map((title, index) =>
  addMockConversation(
    title,
    new Date(Date.now() - (DEMO_CONVERSATIONS.length - index) * 3600_000).toISOString(),
  ),
)

// 末个会话的 transcript 和侧栏同时设为等待审批。
const awaiting = seeded.at(-1)
if (awaiting !== undefined) {
  awaiting.activity = { busy: true, lastTurnReason: null, pendingInteraction: 'approval' }
  markMockAwaitingApproval(awaiting.id)
}

// 连接后模拟运行结束并更新 lastRunId，用于验证已查看会话的未读标记。
const unseen = seeded[3]
if (unseen !== undefined) {
  unseen.activity = { busy: false, lastTurnReason: 'completed', pendingInteraction: 'none' }
  markMockJustFinished(unseen)
}

// 首个演示会话提供 video_shot.json，供浏览器工作台演示。
const withShots = seeded[0]
if (withShots !== undefined) {
  seedMockWorkspace(withShots.id)
}

// 两个会话归入示例合集，其余保持未分组。
const linen = addMockCollection('夏季亚麻系列')
seeded.slice(1, 3).forEach((conversation) => {
  conversation.collectionId = linen.id
})

export const worker = setupWorker(...handlers)
