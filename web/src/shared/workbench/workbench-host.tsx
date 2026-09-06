/** 宿主管理布局与渲染分派；壳提供并排条件，不足时在聊天和面板间切换。收起时是一个菜单钮，列出能打开的产物。 */

import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { use, useEffect, useMemo, useState } from 'react'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { useTranscript } from '@/shared/transcript/use-transcript'
import type { TranscriptItem } from '@/shared/transcript/vendor'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from '@/shared/ui/tabs'
import type { Artifact, ArtifactEntry, WorkbenchFrame } from './artifact'
import { composeArtifacts, isStanding, pickArtifact, type ArtifactRegistry } from './registry'
import { useWorkbenchRegistry } from './use-workbench-registry'
import { useWorkbenchSelection } from './use-workbench-selection'
import { DEFAULT_WORKBENCH_LAYOUT, WorkbenchLayoutContext } from './workbench-layout-context'
import { useWorkspaceFiles, workspaceQueryKeys } from './workspace.api'

/** 主流里的每张工具卡都是候选产物，命不命中由注册表定；view 缺省按协议算 generic。 */
const toolFrames = (items: readonly TranscriptItem[]): WorkbenchFrame[] =>
  items.flatMap((item) =>
    item.kind !== 'turn'
      ? []
      : item.steps.flatMap((step) =>
          step.frames.flatMap((frame) =>
            frame.kind !== 'tool'
              ? []
              : [
                  {
                    toolCallId: frame.toolCallId,
                    view: frame.view ?? 'generic',
                    ...(frame.metadata === undefined ? {} : { metadata: frame.metadata }),
                    ...(frame.display === undefined ? {} : { display: frame.display }),
                    ...(frame.agentRefs === undefined ? {} : { agentRefs: frame.agentRefs }),
                  },
                ],
          ),
        ),
  )

/** 常驻类型与被点开的那张工具卡才占标签位；没点开的派活卡留在菜单里，从卡上「查看」进来。 */
const tabArtifacts = (
  registry: ArtifactRegistry,
  artifacts: readonly Artifact[],
  selected: Artifact | undefined,
): Artifact[] =>
  artifacts.filter((artifact) => {
    const entry = registry.resolve(artifact.type)
    return (entry !== undefined && isStanding(entry)) || artifact.id === selected?.id
  })

type MenuRow = {
  key: string
  label: string
  icon: ArtifactEntry['icon']
  /** 有产物就能打开；常驻类型还没有产物时灰着，detail 说明为什么。 */
  artifactId?: string
  detail?: string
}

/** 常驻类型一行一个，没有产物的也列出来；工具卡产物一件一行。 */
const menuRows = (registry: ArtifactRegistry, artifacts: readonly Artifact[]): MenuRow[] => {
  const standing = registry.standing().map((entry): MenuRow => {
    const artifact = artifacts.find((candidate) => candidate.type === entry.type)
    return artifact === undefined
      ? {
          icon: entry.icon,
          key: entry.type,
          label: entry.label,
          ...(entry.empty ? { detail: entry.empty } : {}),
        }
      : { artifactId: artifact.id, icon: entry.icon, key: artifact.id, label: artifact.title }
  })
  const fromFrames = artifacts.flatMap((artifact): MenuRow[] => {
    const entry = registry.resolve(artifact.type)
    if (entry === undefined || isStanding(entry)) return []
    const detail = entry.detail?.(artifact.source)
    return [
      {
        artifactId: artifact.id,
        icon: entry.icon,
        key: artifact.id,
        label: artifact.title,
        ...(detail === undefined ? {} : { detail }),
      },
    ]
  })
  return [...standing, ...fromFrames]
}

type WorkbenchHostProps = {
  conversationId: string
}

export function WorkbenchHost({ conversationId }: WorkbenchHostProps) {
  const registry = useWorkbenchRegistry()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const connection = use(TranscriptConnectionContext)
  const search: { artifact?: string } = useSearch({ strict: false })
  const files = useWorkspaceFiles(conversationId)
  // 与聊天页共用同一个主流读取器（按会话与 agent 登记），这里再订不会踢掉它的订阅。
  const { view } = useTranscript(conversationId)
  const frames = useMemo(() => toolFrames(view.items), [view.items])
  // 用户的折叠选择只在聊天没有新的「打开面板」请求之前有效；点了派活卡的「查看」就按默认重新打开。
  const { openToken } = useWorkbenchSelection()
  const [userChoice, setUserChoice] = useState<{ collapsed: boolean; token: number } | null>(null)
  const [maximized, setMaximized] = useState(false)
  const { compact, onPanelVisible, sideBySide } =
    use(WorkbenchLayoutContext) ?? DEFAULT_WORKBENCH_LAYOUT

  // 重连后重拉文件，补偿断线期间通知丢失（contract/conventions.md §5）。
  useEffect(() => {
    if (connection === null) return undefined
    return connection.watchSessions((update) => {
      if (update.kind !== 'reconnected') return
      void queryClient.invalidateQueries({
        queryKey: ['conversations', conversationId, 'workspace'],
      })
    })
  }, [connection, conversationId, queryClient])

  // 订整个工作区：任何文件变了，列表与那个文件的查询一起失效。分镜标签在 video_shot.json 落地那一刻出现。
  useEffect(() => {
    if (connection === null) return undefined
    return connection.watchFs(
      conversationId,
      [''],
      (changes) => {
        void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.files(conversationId) })
        for (const change of changes) {
          void queryClient.invalidateQueries({
            queryKey: workspaceQueryKeys.file(conversationId, change.path),
          })
        }
      },
      { recursive: true },
    )
  }, [connection, conversationId, queryClient])

  const artifacts = composeArtifacts(registry, files.data?.files ?? [], frames)
  const selected = pickArtifact(registry, artifacts, search.artifact)
  const entry = selected === undefined ? undefined : registry.resolve(selected.type)
  // 只有分镜这类 autoOpen 的产物落地、或地址点名了某件产物，面板才自动展开；其余时候等用户从菜单里点。
  const opensByItself =
    artifacts.some((artifact) => artifact.id === search.artifact) ||
    artifacts.some((artifact) => registry.autoOpens(artifact.type))
  const collapsed =
    userChoice !== null && userChoice.token === openToken
      ? userChoice.collapsed
      : !opensByItself || compact
  const setCollapsed = (value: boolean) => setUserChoice({ collapsed: value, token: openToken })
  const open = (id: string) => {
    setCollapsed(false)
    void navigate({
      search: (previous: Record<string, unknown>) => ({ ...previous, artifact: id }),
      to: '.',
    })
  }
  const covering = maximized || !sideBySide
  // 仅面板占据布局空间时通知壳显示拖柄。
  const occupiesLayout = !collapsed && !covering
  useEffect(() => {
    onPanelVisible?.(occupiesLayout)
    // 面板卸载时通知壳移除拖柄；壳跨路由持续挂载。
    return () => onPanelVisible?.(false)
  }, [occupiesLayout, onPanelVisible])

  if (collapsed) {
    return (
      <div className="layer-sidebar absolute top-2 right-3">
        <MenuRoot>
          <MenuTrigger asChild>
            <IconButton label="打开右侧面板" name="panel-right" size="md" />
          </MenuTrigger>
          <MenuSurface align="end" className="min-w-52">
            {menuRows(registry, artifacts).map((row) => (
              <MenuItem
                disabled={row.artifactId === undefined}
                icon={row.icon}
                key={row.key}
                onSelect={() => {
                  if (row.artifactId !== undefined) open(row.artifactId)
                }}
                {...(row.detail === undefined ? {} : { detail: row.detail })}
              >
                {row.label}
              </MenuItem>
            ))}
          </MenuSurface>
        </MenuRoot>
      </div>
    )
  }

  const Renderer = entry?.component
  const tabs = tabArtifacts(registry, artifacts, selected)

  return (
    <aside
      aria-label="右侧面板"
      className={cn(
        'layer-sidebar flex min-h-0 flex-col border-l-[0.5px] border-border bg-background',
        covering
          ? 'absolute inset-0'
          : 'sticky top-0 h-dvh w-(--layout-app-workbench-width) shrink-0',
      )}
    >
      <TabsRoot
        className="flex min-h-0 flex-1 flex-col"
        onValueChange={open}
        value={selected?.id ?? ''}
      >
        <div className="flex h-13 shrink-0 items-stretch gap-2 border-b-[0.5px] border-chat-hairline pr-2 pl-3">
          <TabsList aria-label="面板内容" className="min-w-0 flex-1">
            {tabs.map((artifact) => (
              <TabsTrigger className="max-w-64" key={artifact.id} value={artifact.id}>
                {artifact.title}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="flex shrink-0 items-center gap-1">
            {covering && !sideBySide ? (
              <IconButton
                label="回到聊天"
                name="back"
                onClick={() => setCollapsed(true)}
                size="md"
              />
            ) : (
              <>
                <IconButton
                  label={maximized ? '缩小面板' : '放大面板'}
                  name={maximized ? 'minimize-panel' : 'maximize-panel'}
                  onClick={() => setMaximized(!maximized)}
                  size="md"
                />
                <IconButton
                  label="折叠右侧面板"
                  name="panel-right"
                  onClick={() => setCollapsed(true)}
                  size="md"
                />
              </>
            )}
          </div>
        </div>

        {selected === undefined || Renderer === undefined ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-body text-on-surface-variant">还没有产物</p>
            <p className="text-body-sm text-on-surface-faint">
              agent 写下第一份文件之后，它会出现在这里。
            </p>
          </div>
        ) : (
          <TabsContent className="flex min-h-0 flex-1 flex-col" value={selected.id}>
            <Renderer artifact={selected} conversationId={conversationId} key={selected.id} />
          </TabsContent>
        )}
      </TabsRoot>
    </aside>
  )
}
