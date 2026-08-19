import type { VideoTask } from '@/features/tasks'
import type {
  Storyboard,
  StoryboardShot,
  StoryboardWorkspace,
} from '@/features/storyboards/model/storyboard-workspace'

export const SDHS2496W_DEMO_MODE = 'sdhs2496w' as const

export type StoryboardDemoMode = typeof SDHS2496W_DEMO_MODE

const DEMO_STYLE_NO = 'SDHS2496W'
const DEMO_FRAME_ROOT = '/images/storyboards/demo/sdhs2496w/frames'

const createDemoShots = (task: VideoTask): StoryboardShot[] => [
  {
    aspectRatio: '9:16',
    cameraMovement: '侧向跟拍',
    description: '脚步沿露台木板向前，方头与交叉细带在硬朗日光中第一次被看见。',
    dialogue: '旁白：稳稳迈出第一步。',
    durationSeconds: 1,
    id: `${task.id}-demo-shot-01`,
    previewUrl: `${DEMO_FRAME_ROOT}/shot-01.png`,
    sequence: 1,
    shotSize: '鞋部特写',
    title: '步入画面',
    versions: [
      {
        createdAt: '当前',
        id: `${task.id}-demo-shot-01-v1`,
        instruction: '基于参考视频对应脚步镜头帧编辑',
        label: 'v1',
      },
    ],
  },
  {
    aspectRatio: '9:16',
    cameraMovement: '固定微推',
    description: '模特低姿态坐在露台中央，前后脚形成纵深，完整展示上脚比例与稳定粗跟。',
    dialogue: '旁白：利落线条，也可以舒适从容。',
    durationSeconds: 2,
    id: `${task.id}-demo-shot-02`,
    previewUrl: `${DEMO_FRAME_ROOT}/shot-02.png`,
    sequence: 2,
    shotSize: '全身',
    title: '低姿态定格',
    versions: [
      {
        createdAt: '当前',
        id: `${task.id}-demo-shot-02-v1`,
        instruction: '基于参考视频对应坐姿镜头帧编辑',
        label: 'v1',
      },
    ],
  },
  {
    aspectRatio: '9:16',
    cameraMovement: '低机位缓移',
    description: '低机位仰拍模特倚栏而立，黑色凉鞋与宽腿裤共同拉长竖版画面的线条。',
    dialogue: '旁白：从露台到城市，轻松切换。',
    durationSeconds: 2,
    id: `${task.id}-demo-shot-03`,
    previewUrl: `${DEMO_FRAME_ROOT}/shot-03.png`,
    sequence: 3,
    shotSize: '全身低机位',
    title: '挺立露台',
    versions: [
      {
        createdAt: '当前',
        id: `${task.id}-demo-shot-03-v1`,
        instruction: '基于参考视频对应低机位全身镜头帧编辑',
        label: 'v1',
      },
    ],
  },
  {
    aspectRatio: '9:16',
    cameraMovement: '双画面切换',
    description: '上下双画面分别呈现侧面与正面上脚细节，强调方头、细带和稳定粗跟。',
    dialogue: '旁白：方头利落，粗跟更稳。',
    durationSeconds: 2,
    id: `${task.id}-demo-shot-04`,
    previewUrl: `${DEMO_FRAME_ROOT}/shot-04.png`,
    sequence: 4,
    shotSize: '双视角特写',
    title: '双视角细节',
    versions: [
      {
        createdAt: '当前',
        id: `${task.id}-demo-shot-04-v1`,
        instruction: '基于参考视频对应双画面鞋部镜头帧编辑',
        label: 'v1',
      },
    ],
  },
  {
    aspectRatio: '9:16',
    cameraMovement: '固定',
    description: '阳光在木质露台上投下交叉细带的清晰影子，一双黑色凉鞋完成产品收束。',
    dialogue: '旁白：把稳定与利落，穿在脚下。',
    durationSeconds: 1,
    id: `${task.id}-demo-shot-05`,
    previewUrl: `${DEMO_FRAME_ROOT}/shot-05.png`,
    sequence: 5,
    shotSize: '俯拍产品特写',
    title: '产品收束',
    versions: [
      {
        createdAt: '当前',
        id: `${task.id}-demo-shot-05-v1`,
        instruction: '基于参考视频对应产品定帧编辑',
        label: 'v1',
      },
    ],
  },
]

/**
 * 把真实 Task 工作台切换为 SDHS2496W 的显式演示结果。
 *
 * 仅为款号 SDHS2496W 的当前演示 Task 提供稳定结果，刷新或直接访问项目地址时
 * 都由真实 Task 重新构建同一份演示工作台。
 *
 * @param workspace - 由真实 Project、Task 与 Asset 建立的初始工作台。
 * @param task - 当前 Project 绑定的真实来源 Task。
 * @returns 使用对应参考视频帧编辑结果填充后的演示工作台。
 * @throws demo mode 与来源款号不匹配时抛出错误。
 */
export const createSdhs2496wDemoWorkspace = (
  workspace: StoryboardWorkspace,
  task: VideoTask,
): StoryboardWorkspace => {
  if (task.style.styleNo !== DEMO_STYLE_NO) {
    throw new Error(`演示故事板只适用于款号 ${DEMO_STYLE_NO}`)
  }

  const storyboard = workspace.storyboards[0]
  if (!storyboard) {
    throw new Error('演示故事板缺少来源 Task 工作台')
  }

  const demoStoryboard: Storyboard = {
    ...storyboard,
    aspectRatioPlan: '9:16 竖版',
    confirmedAt: '当前',
    durationPlan: '8s',
    kindLabel: '产品短视频',
    modelDescription: '参考视频逐镜图片编辑',
    modelLabel: 'GPT-Image-1',
    shots: createDemoShots(task),
    status: 'submitted',
    styleDescription: '晴日露台 · 都市简约',
    subtitle: '对应参考视频 5 个镜头 · 9:16',
  }

  return { storyboards: [demoStoryboard] }
}
