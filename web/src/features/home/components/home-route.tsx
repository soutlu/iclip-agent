import { HeroAnimation } from '@/shared/ui/hero'
import { HomeComposer } from './home-composer'

type HomeRouteProps = {
  /** 点发送时做什么；未登录时路由层把它接到登录弹窗上 */
  onSend?: (() => void) | undefined
}

/**
 * 首页内容区：侧栏由应用壳提供，这里只放页面自己的东西。
 *
 * 结构对齐 Kimi Code Web 的首页空态（design-system.html 04 · HOME 模板）：
 * 760 阅读列垂直居中偏上，hero 动画 + 品牌字标 + 输入卡 + 卡下沿项目条。
 * 输入卡只做外观，项目选择还没接后端。
 *
 * @param props - 首页属性。
 * @param props.onSend - 发送动作。
 * @returns 首页内容。
 */
export function HomeRoute({ onSend }: HomeRouteProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* pb-[8vh] 把整块从正中往上抬一点：模板要求阅读列垂直居中偏上 */}
      <div className="mx-auto flex w-full max-w-(--layout-home-read-max) flex-1 flex-col justify-center px-6 pb-[8vh]">
        <div className="flex flex-col items-center pb-10 text-center">
          <HeroAnimation className="w-[min(440px,84vw)] animate-in duration-(--dur-l) fade-in" />
          <h1 className="pt-2 font-home-display text-display-sm font-semibold tracking-[-0.035em] text-on-surface italic sm:text-display sm:tracking-[-0.04em]">
            Producer
          </h1>
        </div>
        <HomeComposer onSend={onSend} />
      </div>
    </main>
  )
}
