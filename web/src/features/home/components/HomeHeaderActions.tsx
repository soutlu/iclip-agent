import { ProducerUserMenu } from '@/features/auth'

/**
 * 渲染首页右上角操作区。
 *
 * @returns 首页顶部用户菜单入口。
 */
export default function HomeHeaderActions() {
  return (
    <div className="pointer-events-auto flex items-center gap-1">
      <ProducerUserMenu className="ml-1" />
    </div>
  )
}
