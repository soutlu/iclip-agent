import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { apiFetch } from '@/shared/api/client'
import { zUsersPageOut } from '@/shared/api/generated/zod.gen'
import { drainPages } from '@/shared/api/paging'
import type { PickerSource } from '@/shared/ui/search-picker'

// 不以 auth 开头：这是业务缓存，换人登录时要跟其他业务查询一起清掉。
const USERS_DIRECTORY_KEY = ['users', 'directory'] as const

// 接口单页上限。
const PAGE_SIZE = 200

export interface DirectoryUser {
  id: string
  displayName: string
  /** 账号的登录名；上游按它做归属标签（生成记录的 user_name），没有用户名的账号为空。 */
  username: string | null
}

/** 逐页读取完整名册；任一页失败或查询取消时抛错，不返回部分名单。 */
export const fetchUsersDirectory = (signal?: AbortSignal): Promise<DirectoryUser[]> =>
  drainPages<DirectoryUser, number>(async (token) => {
    const pageNumber = token ?? 1
    const page = await apiFetch(`/users?page=${pageNumber}&pageSize=${PAGE_SIZE}`, zUsersPageOut, {
      fallbackErrorMessage: '读取用户名册失败',
      signal: signal ?? null,
    })
    return {
      items: page.items.map((user) => ({
        displayName: user.displayName || user.username || user.email,
        id: user.id,
        username: user.username,
      })),
      next: pageNumber < Math.ceil(page.total / PAGE_SIZE) ? pageNumber + 1 : null,
    }
  })

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
  const byUsername = useMemo(
    () =>
      new Map(
        (query.data ?? []).flatMap((user) =>
          user.username === null ? [] : [[user.username, user.displayName] as const],
        ),
      ),
    [query.data],
  )
  const users: readonly DirectoryUser[] = query.data ?? []
  return {
    error: query.error?.message,
    isPending: enabled && query.isPending,
    nameOf: (userId: string) => byId.get(userId),
    /** 报表按上游归属的用户名归人，用它把用户名翻成显示名。 */
    nameOfUsername: (username: string) => byUsername.get(username),
    refetch: query.refetch,
    users,
  }
}

export type UsersDirectory = ReturnType<typeof useUsersDirectory>

/**
 * 名册投影成选择器候选。候选 id 按账号 id（筛属主）或按用户名（筛上游归属）；
 * 没有用户名的账号不会出现在报表里，后者就不列它。
 */
export const userPickerSourceOf = (
  directory: UsersDirectory,
  by: 'id' | 'username',
): PickerSource => ({
  error: directory.error,
  isPending: directory.isPending,
  onRetry: () => void directory.refetch(),
  options: directory.users.flatMap((user) => {
    const id = by === 'id' ? user.id : user.username
    return id === null ? [] : [{ id, label: user.displayName }]
  }),
})
