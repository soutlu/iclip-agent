import { setupWorker } from 'msw/browser'
import { addMockCollection, addMockConversation, handlers } from './handlers'
import { markMockAwaitingApproval } from './transcript'
import { seedMockWorkspace } from './workspace'

// 原型里没有新建对话的入口，不预置几段就永远搜不出东西、侧栏也是空的。只种在浏览器
// 这一侧：单测每个用例后会清空这份存储，种进 handlers 会让那边的断言凭空多出几行。
const DEMO_CONVERSATIONS = [
  '夜景延时素材生成',
  '夏季亚麻系列广告',
  '通勤背包短视频',
  '亚麻衬衫二剪',
  '产品宣传片 · 分镜生成中',
]

// 越靠后越新：列表与搜索都按最近活动倒序，一小时一档拉开
const seeded = DEMO_CONVERSATIONS.map((title, index) =>
  addMockConversation(
    title,
    new Date(Date.now() - (DEMO_CONVERSATIONS.length - index) * 3600_000).toISOString(),
  ),
)

// 末尾那段停在审批上：媒体卡、读规范卡与审批卡都在它的第三轮里。侧栏那一行也跟着标成
// 「等审批」，两处说的是同一件事。
const awaiting = seeded.at(-1)
if (awaiting !== undefined) {
  awaiting.activity = { busy: true, lastTurnReason: null, pendingInteraction: 'approval' }
  markMockAwaitingApproval(awaiting.id)
}

// 第一段对话里有 agent 交付的 video_shot.json：点开它右面板就是分镜工作台。只种在浏览器
// 这一侧，理由同上。
const withShots = seeded[0]
if (withShots !== undefined) {
  seedMockWorkspace(withShots.id)
}

// 一个装了两段对话的合集。没进合集的对话待在「任务」区，不给它们造一个「待归档」
// 之类的口袋——那会让原型看起来像是「所有对话都得挂进某个合集」。
const linen = addMockCollection('夏季亚麻系列')
seeded.slice(1, 3).forEach((conversation) => {
  conversation.collectionId = linen.id
})

/** 显式 mock profile 使用的完整浏览器 Mock。 */
export const worker = setupWorker(...handlers)
