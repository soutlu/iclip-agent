import HomeHeaderActions from '@/features/home/components/HomeHeaderActions'
import HomeWorkspaceSections from '@/features/home/components/HomeWorkspaceSections'
import { HOME_HERO_TITLE } from '@/features/home/utils/create-home.constants'
import useHasMounted from '@/shared/hooks/useHasMounted'
import RouteBootShell from '@/shared/ui/RouteBootShell'

/**
 * 渲染首页主工作区。
 *
 * @returns Producer 首页路由内容。
 */
export default function HomeRoute() {
  const hasMounted = useHasMounted()

  if (!hasMounted) {
    return <RouteBootShell variant="home" />
  }

  return (
    <div className="home-workspace relative flex h-dvh max-h-dvh flex-col overflow-hidden">
      <header className="layer-header pointer-events-none absolute inset-x-0 top-0 flex h-[var(--layout-project-header-height)] items-center justify-end px-4 sm:px-8">
        <HomeHeaderActions />
      </header>
      <main className="hide-scrollbar relative isolate flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="layer-content relative flex min-h-0 flex-1 overflow-hidden">
          <section
            id="create-scroll-container"
            className="hide-scrollbar layer-content relative flex min-h-0 max-w-full flex-1 flex-col items-center sm:overflow-y-auto"
          >
            <div className="flex w-full shrink-0 flex-col items-center bg-transparent px-4 pt-8 pb-16 sm:px-8 sm:pt-8 sm:pb-28">
              <div className="flex w-full max-w-[var(--layout-home-content-max)] flex-col gap-[var(--home-section-gap)]">
                <section className="mx-auto w-full max-w-[var(--layout-home-hero-max)] text-center">
                  <div className="mx-auto max-w-[var(--layout-home-title-max)]">
                    <h1 className="home-title text-center">{HOME_HERO_TITLE}</h1>
                  </div>
                  <p className="mt-5 text-body font-medium text-[var(--home-text-muted)]">
                    Agent 与 Canvas 创作工作区当前已停用
                  </p>
                </section>
                <HomeWorkspaceSections />
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
