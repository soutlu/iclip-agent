import { HeroAnimation } from '@/shared/ui/hero'
import { HomeComposer } from './home-composer'
import type { HomeComposerProps } from './home-composer'

/** 参考 design-system.html 的 HOME 模板；侧栏与业务控件由路由装配。 */
export function HomeRoute(props: HomeComposerProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--layout-home-read-max) flex-1 flex-col justify-center px-6 pb-[8vh]">
        <div className="flex flex-col items-center pb-10 text-center">
          <HeroAnimation className="w-[min(440px,84vw)] animate-in duration-(--dur-l) fade-in" />
          <h1 className="pt-2 font-home-display text-display-sm font-semibold tracking-[-0.035em] text-on-surface italic sm:text-display sm:tracking-[-0.04em]">
            Cue
          </h1>
        </div>
        <HomeComposer {...props} />
      </div>
    </main>
  )
}
