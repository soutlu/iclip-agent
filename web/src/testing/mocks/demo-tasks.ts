/** 浏览器演示需求：与单测的数据准备隔离，素材只通过 mock 入口加载。 */
import apparelImage from './assets/apparel.webp'
import backpackImage from './assets/backpack.webp'
import loafersImage from './assets/loafers.webp'
import type { MockConversation } from './conversations'
import { addMockTask, mockGovernor } from './handlers'

type DemoTask = {
  title: string
  product: string
  image: string
  requirement: string
  conversations: readonly string[]
}

const DEMO_TASKS: readonly DemoTask[] = [
  {
    title: '通勤鞋履 · 产品展示',
    product: '黑色乐福鞋',
    image: loafersImage,
    requirement: '复刻参考片的运镜和光线，以开箱、皮革细节与上脚展示突出乐福鞋的轻便和质感。',
    conversations: ['乐福鞋 · 完全复刻', '小王 · 通勤鞋开箱'],
  },
  {
    title: '夏季亚麻系列 · 面料短片',
    product: '亚麻衬衫',
    image: apparelImage,
    requirement:
      '制作 15 秒亚麻衬衫短片，采用自然光与面料特写，缩短开场，保留衣物纹理和松弛的穿搭氛围。',
    conversations: ['夏季亚麻系列广告', '亚麻衬衫二剪'],
  },
  {
    title: '秋季新品 · 穿搭企划',
    product: '奶油色针织衫',
    image: apparelImage,
    requirement: '为秋季针织新品制作上新短片，展示柔软面料、日常穿搭与门店陈列，整体色调温暖自然。',
    conversations: ['小王 · 秋季新品短片', '治理者 · 秋冬企划样片', '治理者 · 门店陈列参考'],
  },
  {
    title: '新品服装 · 分镜方案',
    product: '针织与亚麻服装',
    image: apparelImage,
    requirement:
      '根据商品参考图先整理 8 个镜头的文字分镜，明确景别、运镜和面料细节，确认方案后再生成镜头图片。',
    conversations: ['无图分镜草稿'],
  },
  {
    title: '通勤背包 · 城市宣传片',
    product: '黑色通勤背包',
    image: backpackImage,
    requirement:
      '用白天通勤与城市夜景展示背包的大容量和防泼水细节，先确认分镜节奏，再制作 15 秒竖屏短片。',
    conversations: ['夜景延时素材生成', '通勤背包短视频', '产品宣传片 · 分镜生成中'],
  },
]

/** 对话已有历史及工作区；需求单记载共同要求，认领人与对话属主保持一致。 */
export function seedDemoTasks(conversations: readonly MockConversation[]) {
  for (const [index, demo] of DEMO_TASKS.entries()) {
    // 按标题关联，改了对话标题这里当场报错，不静默少挂一段。
    const attempts = demo.conversations.map((title) => {
      const conversation = conversations.find((one) => one.title === title)
      if (!conversation) {
        throw new Error(`演示需求单「${demo.title}」找不到要关联的对话「${title}」`)
      }
      return conversation
    })
    const task = addMockTask(demo.title)
    task.creatorUserId = mockGovernor.id
    task.status = 'confirmed'
    task.assigneeUserIds = [...new Set(attempts.map((conversation) => conversation.ownerUserId))]
    task.createdAt = new Date(Date.now() - 7 * 86400_000).toISOString()
    task.updatedAt = task.createdAt
    task.inputs.creative_requirement = demo.requirement
    task.inputs.video_spec = {
      platform: 'douyin',
      video_type: 'product_showcase',
      content_type: 'short_video',
      resolution: '1080p',
      aspect_ratio: '9:16',
      duration_seconds: 15,
    }
    task.inputs.products = [
      {
        style_no: `DEMO-${index + 1}`,
        name: demo.product,
        brand: '',
        category: '',
        color_name: '',
        image_oss_urls: [new URL(demo.image, window.location.origin).href],
      },
    ]
    for (const conversation of attempts) {
      conversation.taskId = task.id
      conversation.lastRunId ??= `demo-run-${conversation.id}`
      if (!conversation.activity.busy && conversation.activity.lastTurnReason === null) {
        conversation.activity.lastTurnReason = 'completed'
      }
    }
  }
}
