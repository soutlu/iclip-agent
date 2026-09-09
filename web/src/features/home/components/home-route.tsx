import { HeroAnimation } from '@/shared/ui/hero'
import type { ComposerSubmission } from '@/shared/ui/composer'
import { HomeComposer } from './home-composer'

type HomeRouteProps = {
  /** 未登录时由路由层连接登录弹窗。 */
  onSend?: ((input: { agentId: string; parts: ComposerSubmission['parts'] }) => void) | undefined
  sending?: boolean
}

/** 参考 design-system.html 的 HOME 模板；侧栏由应用壳提供，合集选择尚未接入后端。 */
export function HomeRoute({ onSend, sending }: HomeRouteProps) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--layout-home-read-max) flex-1 flex-col justify-center px-6 pb-[8vh]">
        <div className="flex flex-col items-center pb-10 text-center">
          <HeroAnimation className="w-[min(440px,84vw)] animate-in duration-(--dur-l) fade-in" />
          <h1 className="pt-2 font-home-display text-display-sm font-semibold tracking-[-0.035em] text-on-surface italic sm:text-display sm:tracking-[-0.04em]">
            Cue
          </h1>
        </div>
        <HomeComposer onSend={onSend} sending={sending} />
      </div>
    </main>
  )
}
