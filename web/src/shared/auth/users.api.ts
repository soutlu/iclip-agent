import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { apiFetch } from '@/shared/api/client'
import { zUsersPageOut } from '@/shared/api/generated/zod.gen'

// 不以 auth 开头：这是业务缓存，换人登录时要跟其他业务查询一起清掉。
const USERS_DIRECTORY_KEY = ['users', 'directory'] as const

// 接口单页上限。
const PAGE_SIZE = 200

export interface DirectoryUser {
  id: string
  displayName: string
}

/** 逐页读取完整名册；任一页失败或查询取消时抛错，不返回部分名单。 */
export const fetchUsersDirectory = async (signal?: AbortSignal): Promise<DirectoryUser[]> => {
  const users: DirectoryUser[] = []
  let pageNumber = 1
  let pageCount: number

  do {
    const page = await apiFetch(`/users?page=${pageNumber}&pageSize=${PAGE_SIZE}`, zUsersPageOut, {
      fallbackErrorMessage: '读取用户名册失败',
      signal: signal ?? null,
    })
    users.push(
      ...page.items.map((user) => ({
        displayName: user.displayName || user.username || user.email,
        id: user.id,
      })),
    )
    pageCount = Math.ceil(page.total / PAGE_SIZE)
    pageNumber += 1
  } while (pageNumber <= pageCount)

  return users
}

/** 全平台用户名册，把 ownerUserId 翻成人名。接口要 users:manage，调用方只在治理场景下打开。 */
export const useUsersDirectory = (enabled: boolean) => {
  const query = useQuery({
    enabled,
    queryFn: ({ signal }) => fetchUsersDirectory(signal),
    queryKey: USERS_DIRECTORY_KEY,
    staleTime: 5 * 60_000,
  })
  const byId = useMemo(
    () => new Map((query.data ?? []).map((user) => [user.id, user.displayName])),
    [query.data],
  )
  const users: readonly DirectoryUser[] = query.data ?? []
  return {
    error: query.error?.message,
    isPending: enabled && query.isPending,
    nameOf: (userId: string) => byId.get(userId),
    refetch: query.refetch,
    users,
  }
}
