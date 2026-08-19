import { ProducerUserMenu } from '@/features/auth'

/**
 * 渲染项目页右侧 Header 操作区。
 * 只保留实际可用的用户菜单。
 */
export default function ProjectHeaderRight() {
  return (
    <div className="flex items-center gap-1">
      <ProducerUserMenu className="ml-1" />
    </div>
  )
}
