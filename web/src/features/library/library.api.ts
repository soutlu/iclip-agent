/** 资料库的只读口：筛选翻成查询串，列表用 useInfiniteQuery，作者名单用 useQuery。 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch, errorMessageOf } from '@/shared/api/client'
import {
  zLibraryAuthorsOut,
  zLibraryVideoDetailOut,
  zLibraryVideosOut,
  type zVideosLibraryVideosGetQuery,
} from '@/shared/api/generated/zod.gen'
import { dateRangeBounds, UNBOUNDED_RANGE, type DateRange } from '@/shared/lib/date-range'
import type { PickerSource } from '@/shared/ui/search-picker'

export type LibraryVideosPage = z.output<typeof zLibraryVideosOut>
export type LibraryVideo = LibraryVideosPage['items'][number]
export type LibraryTake = LibraryVideo['take']
export type LibraryScript = NonNullable<LibraryTake['script']>
export type LibraryVideoDetail = z.output<typeof zLibraryVideoDetailOut>
export type LibraryShotGroup = LibraryVideoDetail['groups'][number]
export type LibraryVersionOut = LibraryShotGroup['versions'][number]
export type Orientation = NonNullable<z.output<typeof zVideosLibraryVideosGetQuery>['orientation']>

/** 列表的筛选：人（卡的作者）、时间范围、画幅朝向与关键词。 */
export interface LibraryScope extends DateRange {
  userName: string | null
  orientation: Orientation | null
  q: string
}

export const DEFAULT_LIBRARY_SCOPE: LibraryScope = {
  ...UNBOUNDED_RANGE,
  orientation: null,
  q: '',
  userName: null,
}

/** 一页的卡数：瀑布流五列时约五排。 */
export const LIBRARY_PAGE_SIZE = 24

export const isDefaultScope = (scope: LibraryScope): boolean =>
  scope.userName === null &&
  scope.orientation === null &&
  scope.q.trim() === '' &&
  scope.range === 'all'

/** now 可注入方便测试；预设范围按此刻往前数。 */
export const librarySearchParams = (
  scope: LibraryScope,
  cursor: string | null,
  now: Date = new Date(),
): URLSearchParams => {
  const params = new URLSearchParams()
  const { since, until } = dateRangeBounds(scope, now)
  if (since !== null) params.set('since', since.toISOString())
  if (until !== null) params.set('until', until.toISOString())
  if (scope.userName !== null) params.set('userName', scope.userName)
  if (scope.orientation !== null) params.set('orientation', scope.orientation)
  const keyword = scope.q.trim()
  if (keyword !== '') params.set('q', keyword)
  params.set('limit', String(LIBRARY_PAGE_SIZE))
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

export const libraryQueryKeys = {
  all: ['library'] as const,
  videos: (scope: LibraryScope) => ['library', 'videos', scope] as const,
  video: (id: string) => ['library', 'video', id] as const,
  authors: ['library', 'authors'] as const,
}

/** 缓存留 30 分钟：看完一条详情退回来，已展开的分页不该缩回第一页。 */
export const useLibraryVideos = (scope: LibraryScope) =>
  useInfiniteQuery({
    gcTime: 30 * 60_000,
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/library/videos?${librarySearchParams(scope, pageParam).toString()}`,
        zLibraryVideosOut,
        { fallbackErrorMessage: '读取资料库失败', signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: LibraryVideosPage) => last.nextCursor,
    queryKey: libraryQueryKeys.videos(scope),
  })

/** 一张卡的详情：按镜头组列全部版本。按卡 id 单独取，分享来的链接未必在已读的列表里。 */
export const useLibraryVideo = (id: string) =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch(`/library/videos/${encodeURIComponent(id)}`, zLibraryVideoDetailOut, {
        fallbackErrorMessage: '读取这条片子失败',
        signal,
      }),
    queryKey: libraryQueryKeys.video(id),
  })

/** 按人筛选的候选：名下有卡的作者，候选 id 与显示名都是作者的用户名。 */
export const useLibraryAuthorSource = (): PickerSource => {
  const query = useQuery({
    queryFn: ({ signal }) =>
      apiFetch('/library/authors', zLibraryAuthorsOut, {
        fallbackErrorMessage: '读取作者名单失败',
        signal,
      }),
    queryKey: libraryQueryKeys.authors,
    staleTime: 5 * 60_000,
  })
  return {
    error: query.isError ? errorMessageOf(query.error, '读取作者名单失败') : undefined,
    isPending: query.isPending,
    onRetry: () => void query.refetch(),
    options: (query.data?.items ?? []).map((author) => ({
      id: author.userName,
      label: author.userName,
    })),
  }
}
