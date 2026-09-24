/** SSO 落地页经 `?ssoError=` 交给应用壳的错误码与用户可读文案（SSO 通道即飞书登录）；码只从这张表取。 */
const SSO_ERROR_MESSAGES = {
  forbidden: '账号已停用，请联系管理员开通',
  invalid: '飞书登录会话无效或已过期，请重新登录',
  missing: '缺少飞书登录凭证，请重新发起登录',
  unavailable: '飞书登录暂不可用，请稍后重试或使用账号密码登录',
} as const

export type SsoErrorCode = keyof typeof SSO_ERROR_MESSAGES

const isSsoErrorCode = (code: string): code is SsoErrorCode =>
  Object.hasOwn(SSO_ERROR_MESSAGES, code)

/** 地址栏里的码可能是旧链接或手改的，不认识的给通用文案。 */
export const ssoErrorMessageOf = (code: string): string =>
  isSsoErrorCode(code) ? SSO_ERROR_MESSAGES[code] : 'SSO 登录失败，请重试'
