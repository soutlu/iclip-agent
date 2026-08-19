interface RouteBootShellProps {
  variant: 'home' | 'project'
}

const SHIMMER_BLOCK = 'animate-pulse bg-[var(--color-hover)]'

/**
 * 渲染路由挂载前的轻量骨架屏。
 *
 * @param props - 骨架屏属性。
 * @param props.variant - 需要展示的路由骨架类型。
 * @returns 首页或项目页的骨架屏元素。
 */
export default function RouteBootShell({ variant }: RouteBootShellProps) {
  if (variant === 'home') {
    return (
      <div
        className="home-workspace relative flex h-dvh max-h-dvh flex-col overflow-hidden"
        aria-hidden="true"
      >
        <div className="hide-scrollbar flex min-h-0 flex-1 justify-center overflow-y-auto px-4 pt-8 pb-16 sm:px-8 sm:pt-8 sm:pb-28">
          <div className="flex w-full max-w-[var(--layout-home-content-max)] flex-col gap-8">
            <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-8">
              <div
                className={`${SHIMMER_BLOCK} mx-auto h-14 w-3/4 max-w-[760px] rounded-full md:h-16`}
              />
              <div className={`${SHIMMER_BLOCK} h-44 w-full rounded-2xl`} />
            </div>

            <div className="flex flex-col gap-6">
              <div className="flex gap-8">
                <div className={`${SHIMMER_BLOCK} h-10 w-28 rounded-full`} />
                <div className={`${SHIMMER_BLOCK} h-10 w-36 rounded-full`} />
                <div className={`${SHIMMER_BLOCK} h-10 w-36 rounded-full`} />
              </div>
              <div className="grid grid-cols-1 gap-[22px] sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-5">
                <div className={`${SHIMMER_BLOCK} aspect-[16/10] rounded-md`} />
                <div className={`${SHIMMER_BLOCK} aspect-[16/10] rounded-md`} />
                <div className={`${SHIMMER_BLOCK} aspect-[16/10] rounded-md`} />
                <div className={`${SHIMMER_BLOCK} aspect-[16/10] rounded-md`} />
                <div className={`${SHIMMER_BLOCK} aspect-[16/10] rounded-md`} />
              </div>
            </div>
          </div>
        </div>

        <div className="absolute right-4 bottom-4">
          <div className={`${SHIMMER_BLOCK} h-10 w-10 rounded-full`} />
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative flex h-svh max-h-svh flex-col overflow-hidden bg-[var(--color-background)]"
      aria-hidden="true"
    >
      <div className="flex h-[var(--layout-project-header-height)] shrink-0 items-center justify-between border-b border-[var(--color-header-divider)] bg-[var(--color-top-layer)] px-[var(--layout-project-header-inline-start)] py-4 md:pr-[var(--layout-project-header-inline-end)]">
        <div className="flex items-center gap-3">
          <div className={`${SHIMMER_BLOCK} h-8 w-12 rounded-full`} />
          <div className={`${SHIMMER_BLOCK} h-4 w-40 rounded-full`} />
        </div>
        <div className="flex items-center gap-2">
          <div className={`${SHIMMER_BLOCK} h-8 w-8 rounded-full`} />
          <div className={`${SHIMMER_BLOCK} h-8 w-8 rounded-full`} />
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="layer-sidebar absolute top-[calc(var(--layout-project-header-height)+var(--layout-project-stage-padding))] left-[var(--layout-project-stage-padding)]">
          <div className="flex h-[65px] w-[65px] rounded-lg border border-[var(--color-border)] bg-[var(--color-glass-surface)] backdrop-blur-[40px]">
            <div className="m-auto h-4 w-10 rounded-full bg-[var(--color-hover)]" />
          </div>
        </div>

        <div className="layer-sidebar absolute top-1/2 right-[var(--layout-project-stage-padding)] flex -translate-y-1/2 flex-col gap-2">
          <div className={`${SHIMMER_BLOCK} h-10 w-10 rounded-full`} />
          <div className={`${SHIMMER_BLOCK} h-10 w-10 rounded-full`} />
          <div className={`${SHIMMER_BLOCK} h-10 w-10 rounded-full`} />
        </div>

        <div className="layer-panel absolute bottom-[var(--layout-project-stage-padding)] left-[var(--layout-project-stage-padding)]">
          <div className={`${SHIMMER_BLOCK} h-10 w-24 rounded-full`} />
        </div>

        <div className="layer-panel absolute right-[var(--layout-project-stage-padding)] bottom-[var(--layout-project-stage-padding)] flex gap-2">
          <div className={`${SHIMMER_BLOCK} h-10 w-10 rounded-full`} />
          <div className={`${SHIMMER_BLOCK} h-10 w-20 rounded-full`} />
        </div>

        <div className="layer-header absolute bottom-[var(--layout-project-stage-padding)] left-1/2 flex w-[min(50vw,582px)] min-w-[300px] -translate-x-1/2 flex-col items-center px-4">
          <div className="mb-2 flex w-full gap-2 overflow-hidden px-2">
            <div className={`${SHIMMER_BLOCK} h-8 w-28 rounded-full`} />
            <div className={`${SHIMMER_BLOCK} h-8 w-32 rounded-full`} />
            <div className={`${SHIMMER_BLOCK} h-8 w-24 rounded-full`} />
          </div>
          <div className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-surface)] p-4 backdrop-blur-[40px]">
            <div className={`${SHIMMER_BLOCK} mb-6 h-14 w-full rounded-lg`} />
            <div className="flex items-center gap-2">
              <div className={`${SHIMMER_BLOCK} h-7 w-7 rounded-full`} />
              <div className={`${SHIMMER_BLOCK} h-7 w-24 rounded-full`} />
              <div className="flex-1" />
              <div className={`${SHIMMER_BLOCK} h-7 w-16 rounded-full`} />
              <div className={`${SHIMMER_BLOCK} h-8 w-8 rounded-full`} />
              <div className={`${SHIMMER_BLOCK} h-8 w-8 rounded-full`} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
