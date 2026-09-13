import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { apiFetch } from '@/shared/api/client'
import { zUsersPageOut } from '@/shared/api/generated/zod.gen'

// 不以 auth 开头：这是业务缓存，换人登录时要跟其他业务查询一起清掉。
const USERS_DIRECTORY_KEY = ['users', 'directory'] as const

// 接口单页上限；名册只取第一页，超过这个人数的组织要再翻页。
const PAGE_SIZE = 200

export interface DirectoryUser {
  id: string
  displayName: string
}

const listUsers = async (): Promise<DirectoryUser[]> => {
  const page = await apiFetch(`/users?pageSize=${PAGE_SIZE}`, zUsersPageOut, {
    fallbackErrorMessage: '读取用户名册失败',
  })
  return page.items.map((user) => ({
    displayName: user.displayName || user.username || user.email,
    id: user.id,
  }))
}

/** 全平台用户名册，把 ownerUserId 翻成人名。接口要 users:manage，调用方只在治理场景下打开。 */
export const useUsersDirectory = (
  enabled: boolean,
): { nameOf: (userId: string) => string | undefined; users: readonly DirectoryUser[] } => {
  const query = useQuery({
    enabled,
    queryFn: listUsers,
    queryKey: USERS_DIRECTORY_KEY,
    staleTime: 5 * 60_000,
  })
  const byId = useMemo(
    () => new Map((query.data ?? []).map((user) => [user.id, user.displayName])),
    [query.data],
  )
  return { nameOf: (userId) => byId.get(userId), users: query.data ?? [] }
}
