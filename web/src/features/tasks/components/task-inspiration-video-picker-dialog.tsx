import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Check, ExternalLink, Eye, Play, Search } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  enrichWebInspirationVideos,
  type InspirationMatchLevel,
  type InspirationSortKey,
  type InspirationVideo,
  inspirationVideoSelectionKey,
  searchInspirationVideos,
  searchWebInspirationVideos,
  type SelectedInspirationVideo,
  type WebInspirationSearchPlatform,
  type WebInspirationSearchResult,
  type WebInspirationMetrics,
} from '@/features/tasks/api/inspiration.api'
import type { SettingsChoiceOption } from '@/shared/composer'
import { cn } from '@/shared/lib/utils'
import TaskOptionDropdown from './task-option-dropdown'
import TaskPickerDialog, { togglePicked } from './task-picker-dialog'
import TaskWebVideoPreviewDialog from './task-web-video-preview-dialog'
import { webInspirationPlatformLabel } from './task-web-video-preview'

const SORT_OPTIONS: readonly SettingsChoiceOption<InspirationSortKey>[] = [
  { label: '按成交量', value: 'orders' },
  { label: '按播放量', value: 'views' },
  { label: '按曝光量', value: 'impressions' },
  { label: '按点击量', value: 'clicks' },
  { label: '按 GMV', value: 'revenueAmount' },
]

const MATCH_LEVEL_LABELS: Record<InspirationMatchLevel, string> = {
  exact: '同款',
  none: '无匹配',
  sameBrandCategory: '同品牌品类替代',
  sameCategory: '同品类替代',
}

type WebPlatformSearchState =
  | { status: 'error'; message: string }
  | { status: 'idle' }
  | { status: 'pending' }
  | {
      enrichment:
        { status: 'error'; message: string } | { status: 'pending' } | { status: 'success' }
      items: Array<
        WebInspirationSearchResult['items'][number] & { metrics?: WebInspirationMetrics }
      >
      query: string
      status: 'success'
    }

type WebSearchState = Record<WebInspirationSearchPlatform, WebPlatformSearchState>

const WEB_PLATFORMS = [
  'tiktok',
  'instagram',
  'youtube',
] as const satisfies readonly WebInspirationSearchPlatform[]

const INITIAL_WEB_SEARCH_STATE: WebSearchState = {
  instagram: { status: 'idle' },
  tiktok: { status: 'idle' },
  youtube: { status: 'idle' },
}

type WebSearchPreset = {
  category: { english: string; chinese: string }
  scene: { english: string; chinese: string }
  sellingPoint: { english: string; chinese: string }
}

const WEB_SEARCH_PRESETS: Readonly<Record<string, WebSearchPreset>> = {
  军事用靴: {
    category: { chinese: '军事用靴', english: 'tactical boots' },
    scene: { chinese: '溪流', english: 'creek' },
    sellingPoint: { chinese: '速干', english: 'quick-drying' },
  },
}

const bilingualPresetLabel = ({ chinese, english }: WebSearchPreset['category']) =>
  `${chinese} / ${english}`

/** 把大数指标压缩为中文万/亿简写（Intl 自身不产出多余的 .0）。 */
const metricFormatter = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 1,
  notation: 'compact',
})

/** 推荐池单次拉取上限；返回条数小于它说明候选池已完整，切排序只需本地重排。 */
const INSPIRATION_POOL_LIMIT = 50

const metricValue = (video: InspirationVideo, key: InspirationSortKey): number =>
  key === 'revenueAmount' ? Number(video.metrics.revenueAmount) : video.metrics[key]

/** 完整候选池的本地重排，与服务端排序同构：主指标降序，成交、播放依次决胜。 */
const sortInspirationVideos = (videos: InspirationVideo[], key: InspirationSortKey) =>
  [...videos].sort(
    (a, b) =>
      metricValue(b, key) - metricValue(a, key) ||
      b.metrics.orders - a.metrics.orders ||
      b.metrics.views - a.metrics.views ||
      a.videoId.localeCompare(b.videoId),
  )

type TaskInspirationVideoPickerDialogProps = {
  category: string
  onChange: (videos: SelectedInspirationVideo[]) => void
  onClose: () => void
  selectedVideos: SelectedInspirationVideo[]
  styleNos: string[]
  taskId: string
}

/**
 * 按需加载的爆款库参考视频选择器（可选排序）。弹层关闭后由父组件保留已选视频，
 * 主页面不常驻推荐库。
 */
export default function TaskInspirationVideoPickerDialog({
  category,
  onChange,
  onClose,
  selectedVideos,
  styleNos,
  taskId,
}: TaskInspirationVideoPickerDialogProps) {
  const webSearchPreset = WEB_SEARCH_PRESETS[category.trim()]
  const [sortBy, setSortBy] = useState<InspirationSortKey>('orders')
  const [resultSource, setResultSource] = useState<'library' | 'web'>('library')
  const [webSearchOpen, setWebSearchOpen] = useState(false)
  const [webCategory, setWebCategory] = useState(webSearchPreset?.category.english ?? category)
  const [webScene, setWebScene] = useState(webSearchPreset?.scene.english ?? '')
  const [webSellingPoint, setWebSellingPoint] = useState(
    webSearchPreset?.sellingPoint.english ?? '',
  )
  const [webSearchState, setWebSearchState] = useState<WebSearchState>(INITIAL_WEB_SEARCH_STATE)
  const webSearchAbortControllerRef = useRef<AbortController | null>(null)
  const webSearchRequestIdRef = useRef(0)
  const selectedVideosRef = useRef(selectedVideos)
  const [previewCandidate, setPreviewCandidate] = useState<Extract<
    SelectedInspirationVideo,
    { source: 'web' }
  > | null>(null)

  useEffect(
    () => () => {
      webSearchRequestIdRef.current += 1
      webSearchAbortControllerRef.current?.abort()
    },
    [],
  )

  useEffect(() => {
    selectedVideosRef.current = selectedVideos
  }, [selectedVideos])

  // 推荐池只按默认排序拉一次；结果未截断即候选池完整，切排序时本地重排、不再查库。
  const inspirationPoolQuery = useQuery({
    queryFn: ({ signal }) =>
      searchInspirationVideos(
        { limit: INSPIRATION_POOL_LIMIT, sortBy: 'orders', styleNos },
        { signal },
      ),
    queryKey: ['inspiration-videos', taskId, styleNos],
  })
  const poolTruncated = (inspirationPoolQuery.data?.items.length ?? 0) >= INSPIRATION_POOL_LIMIT
  const usesServerSort = poolTruncated && sortBy !== 'orders'
  // 截断池换排序必须回服务端（top-N 取样随排序变化）；保留上一份列表避免闪空加载态。
  const serverSortQuery = useQuery({
    enabled: usesServerSort,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      searchInspirationVideos({ limit: INSPIRATION_POOL_LIMIT, sortBy, styleNos }, { signal }),
    queryKey: ['inspiration-videos', taskId, sortBy, styleNos],
  })
  const inspirationQuery = usesServerSort ? serverSortQuery : inspirationPoolQuery
  const inspirationItems = useMemo(() => {
    const items = inspirationQuery.data?.items ?? []
    if (usesServerSort || sortBy === 'orders') {
      return items
    }
    return sortInspirationVideos(items, sortBy)
  }, [inspirationQuery.data, sortBy, usesServerSort])

  const matchLevelByStyle = new Map(
    inspirationQuery.data?.matches.map((match) => [match.styleNo, match.matchLevel]) ?? [],
  )

  const changeSelection = (videos: SelectedInspirationVideo[]) => {
    selectedVideosRef.current = videos
    onChange(videos)
  }

  // 搜索只返回临时候选：同一次人工提交并发请求三个平台，各自完成、失败和展示。
  const hasWebSearch = WEB_PLATFORMS.some((platform) => webSearchState[platform].status !== 'idle')
  const webSearchPending = WEB_PLATFORMS.some(
    (platform) => webSearchState[platform].status === 'pending',
  )
  const webResultCount = WEB_PLATFORMS.reduce((count, platform) => {
    const state = webSearchState[platform]
    return count + (state.status === 'success' ? state.items.length : 0)
  }, 0)
  const webQuery = WEB_PLATFORMS.reduce<string | null>((query, platform) => {
    const state = webSearchState[platform]
    return query ?? (state.status === 'success' ? state.query : null)
  }, null)
  const webSearchReady = webCategory.trim().length > 0 && webScene.trim().length > 0

  const submitWebSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!webSearchReady || webSearchPending) {
      return
    }

    const sellingPoint = webSellingPoint.trim()
    const input = {
      category: webCategory.trim(),
      scene: webScene.trim(),
      ...(sellingPoint ? { sellingPoint } : {}),
      taskId,
    }
    const requestId = webSearchRequestIdRef.current + 1
    webSearchRequestIdRef.current = requestId
    webSearchAbortControllerRef.current?.abort()
    const abortController = new AbortController()
    webSearchAbortControllerRef.current = abortController
    setWebSearchState({
      instagram: { status: 'pending' },
      tiktok: { status: 'pending' },
      youtube: { status: 'pending' },
    })
    setResultSource('web')

    for (const platform of WEB_PLATFORMS) {
      void searchWebInspirationVideos({ ...input, platform }, { signal: abortController.signal })
        .then((result) => {
          if (webSearchRequestIdRef.current !== requestId) {
            return
          }
          setWebSearchState((current) => ({
            ...current,
            [platform]: {
              enrichment: { status: result.items.length > 0 ? 'pending' : 'success' },
              items: result.items,
              query: result.query,
              status: 'success',
            },
          }))
          if (result.items.length === 0) {
            return
          }
          void enrichWebInspirationVideos(
            { candidates: result.items, platform, taskId },
            { signal: abortController.signal },
          )
            .then((enrichedItems) => {
              if (webSearchRequestIdRef.current !== requestId) {
                return
              }
              const enrichedCandidates = result.items.map((item, index) => {
                const enrichedItem = enrichedItems[index]
                return enrichedItem
                  ? {
                      ...item,
                      durationSeconds: enrichedItem.durationSeconds,
                      metrics: enrichedItem.metrics,
                      thumbnailUrl: enrichedItem.thumbnailUrl,
                    }
                  : item
              })
              setWebSearchState((current) => {
                const platformState = current[platform]
                if (platformState.status !== 'success') {
                  return current
                }
                return {
                  ...current,
                  [platform]: {
                    ...platformState,
                    enrichment: { status: 'success' },
                    items: enrichedCandidates,
                  },
                }
              })
              const enrichedByVideoId = new Map(
                enrichedCandidates.map((candidate) => [candidate.platformVideoId, candidate]),
              )
              let selectionChanged = false
              const updatedSelection = selectedVideosRef.current.map((selectedVideo) => {
                if (selectedVideo.source !== 'web' || selectedVideo.platform !== platform) {
                  return selectedVideo
                }
                const enrichedCandidate = enrichedByVideoId.get(selectedVideo.platformVideoId)
                if (!enrichedCandidate) {
                  return selectedVideo
                }
                selectionChanged = true
                return { ...enrichedCandidate, platform, source: 'web' as const }
              })
              if (selectionChanged) {
                selectedVideosRef.current = updatedSelection
                changeSelection(updatedSelection)
              }
            })
            .catch((error: unknown) => {
              if (abortController.signal.aborted || webSearchRequestIdRef.current !== requestId) {
                return
              }
              setWebSearchState((current) => {
                const platformState = current[platform]
                if (platformState.status !== 'success') {
                  return current
                }
                const errorMessage = error instanceof Error ? error.message : '联网补全详情响应无效'
                const failurePrefix = `联网补全${webInspirationPlatformLabel(platform)}详情失败`
                return {
                  ...current,
                  [platform]: {
                    ...platformState,
                    enrichment: {
                      message: errorMessage.startsWith(failurePrefix)
                        ? errorMessage
                        : `${failurePrefix}：${errorMessage}`,
                      status: 'error',
                    },
                  },
                }
              })
            })
        })
        .catch((error: unknown) => {
          if (abortController.signal.aborted || webSearchRequestIdRef.current !== requestId) {
            return
          }
          setWebSearchState((current) => ({
            ...current,
            [platform]: {
              message: error instanceof Error ? error.message : '联网搜索失败',
              status: 'error',
            },
          }))
        })
    }
  }

  return (
    <TaskPickerDialog
      bodyClassName="home-task-recommended"
      countNoun="视频"
      countUnit="条"
      description="从爆款库选择或主动联网搜索，完成后作为任务的普通参考视频"
      selectedCount={selectedVideos.length}
      title="爆款视频"
      onClose={onClose}
    >
      <div className="home-task-recommended-header">
        <div aria-label="爆款视频来源" className="home-task-inspiration-sources" role="group">
          <button
            aria-pressed={resultSource === 'library'}
            type="button"
            onClick={() => setResultSource('library')}
          >
            爆款库
          </button>
          {hasWebSearch ? (
            <button
              aria-pressed={resultSource === 'web'}
              type="button"
              onClick={() => setResultSource('web')}
            >
              联网结果
              <span>{webResultCount}</span>
            </button>
          ) : null}
        </div>
        <div className="home-task-recommended-actions">
          {resultSource === 'library' ? (
            <TaskOptionDropdown
              label="推荐视频排序"
              name="inspirationSort"
              options={SORT_OPTIONS}
              value={sortBy}
              onValueChange={setSortBy}
            />
          ) : null}
          <button
            aria-expanded={webSearchOpen}
            className="home-task-web-search-trigger"
            type="button"
            onClick={() => setWebSearchOpen((open) => !open)}
          >
            <Search aria-hidden="true" size={14} strokeWidth={2} />
            联网搜索
          </button>
        </div>
      </div>
      {webSearchOpen ? (
        <form
          aria-label="联网搜索爆款视频"
          className="home-task-web-search-form"
          onSubmit={submitWebSearch}
        >
          <label>
            <span>品类</span>
            {webSearchPreset ? (
              <small className="home-task-web-search-bilingual">
                {bilingualPresetLabel(webSearchPreset.category)}
              </small>
            ) : null}
            <input
              aria-label="品类"
              maxLength={200}
              required
              value={webCategory}
              onChange={(event) => setWebCategory(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>使用场景</span>
            {webSearchPreset ? (
              <small className="home-task-web-search-bilingual">
                {bilingualPresetLabel(webSearchPreset.scene)}
              </small>
            ) : null}
            <input
              aria-label="使用场景"
              maxLength={200}
              required
              placeholder="例如：溪流徒步"
              value={webScene}
              onChange={(event) => setWebScene(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>特性 / 卖点（选填）</span>
            {webSearchPreset ? (
              <small className="home-task-web-search-bilingual">
                {bilingualPresetLabel(webSearchPreset.sellingPoint)}
              </small>
            ) : null}
            <input
              aria-label="特性 / 卖点（选填）"
              maxLength={200}
              placeholder="例如：速干"
              value={webSellingPoint}
              onChange={(event) => setWebSellingPoint(event.currentTarget.value)}
            />
          </label>
          <button disabled={!webSearchReady || webSearchPending} type="submit">
            {webSearchPending ? '搜索中…' : '搜索 3 个平台'}
          </button>
        </form>
      ) : null}

      {resultSource === 'library' ? (
        <>
          {inspirationQuery.isLoading ? (
            <p className="home-task-materials-state">正在加载推荐视频…</p>
          ) : null}
          {inspirationQuery.error ? (
            <p className="home-task-materials-state home-task-materials-state--error" role="alert">
              {inspirationQuery.error.message}
            </p>
          ) : null}
          {inspirationQuery.data && inspirationItems.length === 0 ? (
            <p className="home-task-materials-state">暂无可推荐的参考视频。</p>
          ) : null}
          {inspirationItems.length > 0 ? (
            <ul aria-label="推荐参考视频" className="home-task-recommended-list">
              {inspirationItems.map((item) => {
                const matchLevel = matchLevelByStyle.get(item.styleNo)
                const candidate: SelectedInspirationVideo = { ...item, source: 'library' }
                const selected = selectedVideos.some(
                  (video) =>
                    inspirationVideoSelectionKey(video) === inspirationVideoSelectionKey(candidate),
                )
                return (
                  <li key={item.videoId}>
                    <button
                      aria-label={`推荐视频 ${item.videoId}`}
                      aria-pressed={selected}
                      className="home-task-recommended-card"
                      type="button"
                      onClick={() =>
                        changeSelection(
                          togglePicked(selectedVideos, candidate, inspirationVideoSelectionKey),
                        )
                      }
                    >
                      <video
                        className="home-task-recommended-video"
                        muted
                        playsInline
                        preload="metadata"
                        src={item.ossUrl}
                      />
                      <span className="home-task-recommended-info">
                        <span className="home-task-recommended-title">
                          <strong>{item.styleNo}</strong>
                          <span
                            className={cn(
                              'home-task-detail-tag',
                              matchLevel === 'exact' ? 'home-task-detail-tag--primary' : '',
                            )}
                          >
                            {matchLevel ? MATCH_LEVEL_LABELS[matchLevel] : '替代款'}
                          </span>
                        </span>
                        <span className="home-task-recommended-metrics">
                          曝光 {metricFormatter.format(item.metrics.impressions)} · 播放{' '}
                          {metricFormatter.format(item.metrics.views)} · 点击{' '}
                          {metricFormatter.format(item.metrics.clicks)} · 成交{' '}
                          {metricFormatter.format(item.metrics.orders)} · GMV{' '}
                          {metricFormatter.format(Math.round(Number(item.metrics.revenueAmount)))}
                        </span>
                        {item.creatorHandle || item.postedDate ? (
                          <span className="home-task-recommended-meta">
                            {[item.creatorHandle, item.postedDate].filter(Boolean).join(' · ')}
                          </span>
                        ) : null}
                      </span>
                      <span aria-hidden="true" className="home-task-material-check">
                        <Check size={11} strokeWidth={2.4} />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </>
      ) : hasWebSearch ? (
        <section aria-label="联网搜索结果" className="home-task-web-results">
          <header className="home-task-web-results-summary">
            <div>
              <h4>联网结果</h4>
              <p>{webQuery ? `查询：${webQuery}` : '正在构建查询并获取结果…'}</p>
            </div>
            <span>
              {webSearchPending ? `已返回 ${webResultCount} 条` : `三平台共 ${webResultCount} 条`}
            </span>
          </header>
          {WEB_PLATFORMS.map((platform) => {
            const platformState = webSearchState[platform]
            const items = platformState.status === 'success' ? platformState.items : []
            const platformLabel = webInspirationPlatformLabel(platform)
            return (
              <section className="home-task-web-platform" key={platform}>
                <header>
                  <h5>{platformLabel}</h5>
                  <span>
                    {platformState.status === 'success'
                      ? `${items.length} 条`
                      : platformState.status === 'error'
                        ? '失败'
                        : '搜索中'}
                  </span>
                </header>
                {platformState.status === 'pending' ? (
                  <p className="home-task-materials-state" role="status">
                    正在搜索 {platformLabel}…
                  </p>
                ) : platformState.status === 'error' ? (
                  <p
                    className="home-task-materials-state home-task-materials-state--error"
                    role="alert"
                  >
                    {platformState.message}
                  </p>
                ) : platformState.status === 'success' && items.length === 0 ? (
                  <p className="home-task-materials-state">未返回结果。</p>
                ) : platformState.status === 'success' ? (
                  <>
                    {platformState.enrichment.status === 'pending' ? (
                      <p className="home-task-web-enrichment-state" role="status">
                        {platformLabel} 详情获取中…
                      </p>
                    ) : platformState.enrichment.status === 'error' ? (
                      <p
                        className="home-task-web-enrichment-state home-task-materials-state--error"
                        role="alert"
                      >
                        {platformState.enrichment.message}
                      </p>
                    ) : null}
                    <ul
                      aria-label={`${platformLabel} 联网结果`}
                      className="home-task-recommended-list"
                    >
                      {items.map((item) => {
                        const candidate: SelectedInspirationVideo = {
                          ...item,
                          platform,
                          source: 'web',
                        }
                        const selected = selectedVideos.some(
                          (video) =>
                            inspirationVideoSelectionKey(video) ===
                            inspirationVideoSelectionKey(candidate),
                        )
                        return (
                          <li
                            className="home-task-web-result-item"
                            data-layout="uniform-web-result"
                            key={`${item.platformVideoId}:${String(item.responsePosition)}`}
                          >
                            <button
                              aria-label={`${platformLabel} 联网视频 第 ${String(item.responsePosition)} 位`}
                              aria-pressed={selected}
                              className="home-task-recommended-card home-task-web-result-select"
                              type="button"
                              onClick={() =>
                                changeSelection(
                                  togglePicked(
                                    selectedVideos,
                                    candidate,
                                    inspirationVideoSelectionKey,
                                  ),
                                )
                              }
                            >
                              {item.thumbnailUrl ? (
                                <img
                                  alt=""
                                  className="home-task-recommended-video"
                                  loading="lazy"
                                  referrerPolicy="no-referrer"
                                  src={item.thumbnailUrl}
                                />
                              ) : (
                                <span
                                  aria-hidden="true"
                                  className="home-task-recommended-video home-task-web-video-placeholder"
                                >
                                  <Play size={18} strokeWidth={2} />
                                </span>
                              )}
                              <span className="home-task-recommended-info">
                                <span className="home-task-recommended-title">
                                  <strong>{platformLabel}</strong>
                                  <span className="home-task-detail-tag home-task-detail-tag--primary">
                                    #{item.responsePosition}
                                  </span>
                                </span>
                                <span className="home-task-recommended-metrics">
                                  {item.title?.trim() ||
                                    `原始返回顺序第 ${item.responsePosition} 位`}
                                </span>
                                <span className="home-task-recommended-meta">
                                  {[
                                    item.creatorHandle,
                                    item.durationSeconds
                                      ? `${Math.round(item.durationSeconds)} 秒`
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ') || '保存时转存所选视频'}
                                </span>
                                <span
                                  aria-label={`${platformLabel} 联网视频 第 ${String(item.responsePosition)} 位表现指标`}
                                  className="home-task-web-result-metrics"
                                >
                                  {item.metrics
                                    ? [
                                        item.metrics.viewCount === null
                                          ? null
                                          : `播放 ${metricFormatter.format(item.metrics.viewCount)}`,
                                        item.metrics.likeCount === null
                                          ? null
                                          : `点赞 ${metricFormatter.format(item.metrics.likeCount)}`,
                                        item.metrics.commentCount === null
                                          ? null
                                          : `评论 ${metricFormatter.format(item.metrics.commentCount)}`,
                                        item.metrics.shareCount === null
                                          ? null
                                          : `分享 ${metricFormatter.format(item.metrics.shareCount)}`,
                                      ]
                                        .filter(Boolean)
                                        .join(' · ')
                                    : ''}
                                </span>
                              </span>
                              <span aria-hidden="true" className="home-task-material-check">
                                <Check size={11} strokeWidth={2.4} />
                              </span>
                            </button>
                            <span
                              aria-label={`${platformLabel} 联网视频 第 ${String(item.responsePosition)} 位操作`}
                              className="home-task-web-result-actions"
                              role="group"
                            >
                              <button
                                aria-label={`预览${platformLabel} 联网视频 第 ${String(item.responsePosition)} 位`}
                                type="button"
                                onClick={() => setPreviewCandidate(candidate)}
                              >
                                <Eye aria-hidden="true" size={13} strokeWidth={2} />
                                预览
                              </button>
                              <a
                                aria-label={`打开${platformLabel} 联网视频 第 ${String(item.responsePosition)} 位原帖`}
                                href={item.postUrl}
                                rel="noopener noreferrer"
                                target="_blank"
                              >
                                <ExternalLink aria-hidden="true" size={13} strokeWidth={2} />
                                原帖
                              </a>
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  </>
                ) : null}
              </section>
            )
          })}
        </section>
      ) : null}
      {previewCandidate ? (
        <TaskWebVideoPreviewDialog
          candidate={previewCandidate}
          onClose={() => setPreviewCandidate(null)}
        />
      ) : null}
    </TaskPickerDialog>
  )
}
