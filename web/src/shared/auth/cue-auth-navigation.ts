/** 仅允许同源相对路径，非法登录跳转目标返回首页。 */
export const sanitizeCueAuthNextPath = (nextPath: string | null | undefined) => {
  const trimmedPath = nextPath?.trim() ?? ''

  if (!trimmedPath.startsWith('/') || trimmedPath.startsWith('//')) {
    return '/'
  }

  return trimmedPath
}
