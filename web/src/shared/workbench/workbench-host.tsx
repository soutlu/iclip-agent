/** 宿主管理布局与渲染分派；壳提供并排条件，不足时在聊天和面板间切换。 */

import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { use, useEffect, useMemo, useState } from 'react'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { useTranscript } from '@/shared/transcript/use-transcript'
import type { TranscriptItem } from '@/shared/transcript/vendor'
import { IconButton } from '@/shared/ui/button'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { cn } from '@/shared/lib/utils'
import type { WorkbenchFrame } from './artifact'
import { composeArtifacts, pickArtifact } from './registry'
import { useWorkbenchRegistry } from './use-workbench-registry'
import { useWorkbenchSelection } from './use-workbench-selection'
import { DEFAULT_WORKBENCH_LAYOUT, WorkbenchLayoutContext } from './workbench-layout-context'
import { useWorkspaceFiles } from './workspace.api'

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

  const artifacts = composeArtifacts(registry, files.data?.files ?? [], frames)
  const selected = pickArtifact(registry, artifacts, search.artifact)
  const entry = selected === undefined ? undefined : registry.resolve(selected.type)
  const collapsed =
    userChoice !== null && userChoice.token === openToken
      ? userChoice.collapsed
      : artifacts.length === 0 || compact
  const setCollapsed = (value: boolean) => setUserChoice({ collapsed: value, token: openToken })
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
      <IconButton
        className="layer-sidebar fixed top-3 right-3 bg-surface-container-lowest shadow-[var(--shadow-1)]"
        label="展开右侧面板"
        name="panel-right"
        onClick={() => setCollapsed(false)}
        size="md"
      />
    )
  }

  const Renderer = entry?.component

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
      <div className="flex h-13 shrink-0 items-center gap-2 border-b-[0.5px] border-chat-hairline px-4">
        {/* 标题始终是标题；多一件产物只多一个切换钮，已有产物的定位方式不变。 */}
        <h2 className="min-w-0 truncate px-2 text-body font-medium text-on-surface">
          {selected?.title ?? '面板'}
        </h2>
        {artifacts.length > 1 ? (
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton label="切换产物" name="expand" size="md" />
            </MenuTrigger>
            <MenuSurface align="start">
              <MenuRadioGroup
                onValueChange={(id) => void navigate({ search: { artifact: id }, to: '.' })}
                value={selected?.id ?? ''}
              >
                {artifacts.map((artifact) => (
                  <MenuRadioItem key={artifact.id} value={artifact.id}>
                    {artifact.title}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSurface>
          </MenuRoot>
        ) : null}

        <span className="flex-1" />

        {covering && !sideBySide ? (
          <IconButton label="回到聊天" name="back" onClick={() => setCollapsed(true)} size="md" />
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

      {selected === undefined || Renderer === undefined ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-body text-on-surface-variant">还没有产物</p>
          <p className="text-body-sm text-on-surface-faint">
            agent 交付分镜之后，它会出现在这里，可以逐组翻看。
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <Renderer artifact={selected} conversationId={conversationId} key={selected.id} />
        </div>
      )}
    </aside>
  )
}
