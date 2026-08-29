import { HeroAnimation } from '@/shared/ui/hero'
import { HomeComposer } from './home-composer'

/**
 * 首页内容区：侧栏由 /_authed 布局提供，这里只放页面自己的东西。
 *
 * 结构对齐 Kimi Code Web 的首页空态（design-system.html 04 · HOME 模板）：
 * 760 阅读列垂直居中偏上，hero 动画 + 副标题 + 输入卡 + 卡下沿项目条。
 * 输入卡只做外观，发送与项目选择都还没接后端。
 *
 * @returns 首页内容。
 */
export function HomeRoute() {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* pb-[8vh] 把整块从正中往上抬一点：模板要求阅读列垂直居中偏上 */}
      <div className="mx-auto flex w-full max-w-(--layout-home-read-max) flex-1 flex-col justify-center px-6 pb-[8vh]">
        <div className="flex flex-col items-center pb-8 text-center">
          <h1 className="sr-only">Producer</h1>
          <HeroAnimation className="w-[min(660px,92vw)] animate-in duration-(--dur-l) fade-in" />
          <p className="pt-4 text-title text-on-surface-variant">
            还没有对话 —— 在下方输入开始创作
          </p>
        </div>
        <HomeComposer />
      </div>
    </main>
  )
}
