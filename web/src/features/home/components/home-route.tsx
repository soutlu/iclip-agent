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
      <div className="mx-auto flex w-full max-w-(--layout-home-read-max) flex-1 flex-col px-6">
        <div className="flex flex-[2] flex-col items-center justify-end pb-6 text-center">
          <h1 className="sr-only">Producer</h1>
          <HeroAnimation className="w-[min(520px,90vw)] animate-in duration-(--dur-l) fade-in" />
          <p className="pt-3 text-body text-on-surface-variant">还没有对话 —— 在下方输入开始创作</p>
        </div>
        <div className="flex flex-[3] flex-col">
          <HomeComposer />
        </div>
      </div>
    </main>
  )
}
