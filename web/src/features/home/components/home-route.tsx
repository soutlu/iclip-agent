/**
 * 首页内容区：页头由 /_authed 布局提供，这里只放页面自己的东西。
 *
 * 前端重写从这里往外长——新页面按 design-system.html 的结构模板搭，
 * 组件从 @/shared/ui 取，不在 feature 里另起一套 CSS。
 *
 * @returns 首页内容。
 */
export function HomeRoute() {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center p-6">
      <p className="text-body text-on-surface-variant">首页待重建</p>
    </main>
  )
}
