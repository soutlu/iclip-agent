import { setupWorker } from 'msw/browser'
import {
  addMockCollection,
  addMockConversation,
  addMockUser,
  handlers,
  mockGovernor,
} from './handlers'
import { seedDemoTasks } from './demo-tasks'
import { markMockAwaitingApproval, markMockJustFinished } from './transcript'
import { seedMockReplicaWorkspace, seedMockWorkspace } from './workspace'

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
  awaiting.activity = {
    busy: true,
    lastTurnReason: null,
    pendingInteraction: 'approval',
    videoGeneration: 'none',
  }
  markMockAwaitingApproval(awaiting.id)
}

// 连接后模拟运行结束并更新 lastRunId，用于验证已查看会话的未读标记。
const unseen = seeded[3]
if (unseen !== undefined) {
  unseen.activity = {
    busy: false,
    lastTurnReason: 'completed',
    pendingInteraction: 'none',
    videoGeneration: 'none',
  }
  markMockJustFinished(unseen)
}

// 首个演示会话提供 video_shot.json，供浏览器工作台演示；它的出片记录里有一条还在跑，侧栏行上同步画出来。
const withShots = seeded[0]
if (withShots !== undefined) {
  seedMockWorkspace(withShots.id, { httpFrames: true })
  withShots.activity = { ...withShots.activity, videoGeneration: 'running' }
}

// 「亚麻衬衫二剪」没有工作区，只在侧栏演示「出片还在排队」的角标；放在未分组区，一打开就看得见。
const queuedVideo = seeded[3]
if (queuedVideo !== undefined) {
  queuedVideo.activity = { ...queuedVideo.activity, videoGeneration: 'queued' }
}

// 独立的无图草稿用于演示先编辑正文、再补充第一张图片。
const withoutImages = addMockConversation('无图分镜草稿')
seedMockWorkspace(withoutImages.id, { withoutImages: true })

const replica = addMockConversation('乐福鞋 · 完全复刻')
seedMockReplicaWorkspace(replica.id)

// 两个会话归入示例合集，其余保持未分组。
const linen = addMockCollection('夏季亚麻系列')
seeded.slice(1, 3).forEach((conversation) => {
  conversation.collectionId = linen.id
})

// 治理者自己的对话：用 governor 登录时侧栏不至于是空的，分镜工作台与在途角标也能演示；
// 「全部对话」里连同别人的一起看。
const governorShots = addMockConversation(
  '治理者 · 秋冬企划样片',
  new Date(Date.now() - 30 * 60_000).toISOString(),
  mockGovernor.id,
)
seedMockWorkspace(governorShots.id, { httpFrames: true })
governorShots.activity = { ...governorShots.activity, videoGeneration: 'running' }
const governorDone = addMockConversation(
  '治理者 · 门店陈列参考',
  new Date(Date.now() - 4 * 3600_000).toISOString(),
  mockGovernor.id,
)
governorDone.activity = { ...governorDone.activity, lastTurnReason: 'completed' }
governorDone.lastRunId = 'run-governor-1'

// 别人的对话：测试用户的侧栏看不到，用 governor 登录后在「全部对话」里看，点进去是只读。
const wang = addMockUser('小王')
const wangRunning = addMockConversation('小王 · 秋季新品短片', undefined, wang.id)
wangRunning.activity = {
  busy: true,
  lastTurnReason: null,
  pendingInteraction: 'none',
  videoGeneration: 'none',
}
const wangDone = addMockConversation(
  '小王 · 通勤鞋开箱',
  new Date(Date.now() - 2 * 3600_000).toISOString(),
  wang.id,
)
wangDone.activity = {
  busy: false,
  lastTurnReason: 'completed',
  pendingInteraction: 'none',
  videoGeneration: 'none',
}
wangDone.lastRunId = 'run-wang-1'

seedDemoTasks([
  ...seeded,
  withoutImages,
  replica,
  governorShots,
  governorDone,
  wangRunning,
  wangDone,
])

export const worker = setupWorker(...handlers)
