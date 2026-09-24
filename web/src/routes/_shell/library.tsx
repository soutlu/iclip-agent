import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useRef } from 'react'
import { LibraryRoute, type LibraryScope } from '@/features/library'
import { ensureSessionUser, hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { librarySearchSchema, scopeFromSearch, searchFromScope } from '../-library-search'

// 资料库要登录且能看出片记录；筛选范围与打开着的详情存在查询参数里，退回、刷新与分享链接都还原同一屏。
export const Route = createFileRoute('/_shell/library')({
  beforeLoad: async () => {
    if (!hasPermission(await ensureSessionUser(), PERMISSION.generationRead)) {
      throw redirect({ to: '/' })
    }
  },
  component: LibraryPage,
  validateSearch: librarySearchSchema,
})

function LibraryPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const { data: user } = useUser()
  // 从列表点开详情时压了一条历史，关掉就退回那条，手机上的返回手势也就是关详情。
  const pushedRef = useRef(false)
  const setScope = (next: LibraryScope) =>
    void navigate({ replace: true, search: searchFromScope(next) })
  const setVideo = (id: string | null, replace: boolean) => {
    if (id === null && pushedRef.current) {
      pushedRef.current = false
      router.history.back()
      return
    }
    if (id !== null && !replace) pushedRef.current = true
    void navigate({
      replace: id === null || replace,
      search: (prev) => ({ ...prev, video: id ?? undefined }),
    })
  }
  const shareLinkOf = (id: string) =>
    new URL(
      router.buildLocation({ search: { video: id }, to: '/library' }).href,
      window.location.origin,
    ).href

  return (
    <LibraryRoute
      myUserName={user?.username ?? null}
      onScopeChange={setScope}
      onVideoChange={setVideo}
      scope={scopeFromSearch(search)}
      shareLinkOf={shareLinkOf}
      videoId={search.video ?? null}
    />
  )
}
