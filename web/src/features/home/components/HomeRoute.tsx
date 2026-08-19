import HomeHeaderActions from '@/features/home/components/HomeHeaderActions'
import HomeHero from '@/features/home/components/HomeHero'
import HomeWorkspaceSections from '@/features/home/components/HomeWorkspaceSections'
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
                <HomeHero />
                <HomeWorkspaceSections />
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
