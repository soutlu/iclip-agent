/**
 * 清洗登录后的跳转路径，只允许同源相对路径。
 *
 * @param nextPath - URL 查询参数或组件属性中读取到的 next 值。
 * @returns 安全的站内跳转路径，非法值统一回到首页。
 */
export const sanitizeCueAuthNextPath = (nextPath: string | null | undefined) => {
  const trimmedPath = nextPath?.trim() ?? ''

  if (!trimmedPath.startsWith('/') || trimmedPath.startsWith('//')) {
    return '/'
  }

  return trimmedPath
}
