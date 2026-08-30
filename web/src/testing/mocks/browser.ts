import { setupWorker } from 'msw/browser'
import { addMockConversation, handlers } from './handlers'

// 原型里没有新建对话的入口，不预置几段就永远搜不出东西。只种在浏览器这一侧：
// 单测每个用例后会清空这份存储，种进 handlers 会让那边的断言凭空多出几行。
const DEMO_CONVERSATIONS = [
  '夜景延时素材生成',
  '夏季亚麻系列广告',
  '通勤背包短视频',
  '亚麻衬衫二剪',
  '产品宣传片 · 分镜生成中',
]

// 越靠后越新：列表与搜索都按最近活动倒序，一小时一档拉开
DEMO_CONVERSATIONS.forEach((title, index) => {
  const hoursAgo = DEMO_CONVERSATIONS.length - index
  addMockConversation(title, new Date(Date.now() - hoursAgo * 3600_000).toISOString())
})

/** 显式 mock profile 使用的完整浏览器 Mock。 */
export const worker = setupWorker(...handlers)
