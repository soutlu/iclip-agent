import { HeroAnimation } from '@/shared/ui/hero'
import { HomeComposer } from './home-composer'
import type { HomeComposerProps } from './home-composer'

/** 首页：吉祥物 hero 自带 Cue 字标，标题只保留给读屏；侧栏与业务控件由路由装配。 */
export function HomeRoute(props: HomeComposerProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--layout-home-read-max) flex-1 flex-col justify-center px-6 pb-[8vh]">
        <div className="flex flex-col items-center pb-4">
          <HeroAnimation className="w-[min(640px,92vw)] animate-in duration-(--dur-l) fade-in" />
          <h1 className="sr-only">Cue</h1>
        </div>
        <HomeComposer {...props} />
      </div>
    </main>
  )
}
