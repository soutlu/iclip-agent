import type { CueAuthUser } from './cue-auth.types'

/** 当前用户在界面上的称呼：SSO 自动建号的用户没有 username，优先用 SSO 同步来的 displayName；都没有叫「用户」。 */
export const userDisplayName = (
  user: Pick<CueAuthUser, 'displayName' | 'username'> | null | undefined,
): string => user?.displayName || user?.username || '用户'
