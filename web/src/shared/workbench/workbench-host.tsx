/** 宿主管理布局与渲染分派；壳提供并排条件，不足时在聊天和面板间切换。 */

import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { use, useEffect, useState } from 'react'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { IconButton } from '@/shared/ui/button'
import { MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { cn } from '@/shared/lib/utils'
import type { WorkbenchFrame } from './artifact'
import { composeArtifacts, pickArtifact } from './registry'
import { useWorkbenchRegistry } from './use-workbench-registry'
import { DEFAULT_WORKBENCH_LAYOUT, WorkbenchLayoutContext } from './workbench-layout-context'
import { useWorkspaceFiles } from './workspace.api'

/** 暂不接工具帧：同会话的 subscribe 会覆盖现有 reader，面板另建订阅将中断聊天推送。 */
const NO_FRAMES: readonly WorkbenchFrame[] = []

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
  // 用户选择优先；尚未手动切换时根据是否存在产物决定折叠状态。
  const [collapsedByUser, setCollapsedByUser] = useState<boolean | null>(null)
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

  const artifacts = composeArtifacts(registry, files.data?.files ?? [], NO_FRAMES)
  const selected = pickArtifact(registry, artifacts, search.artifact)
  const entry = selected === undefined ? undefined : registry.resolve(selected.type)
  const collapsed = collapsedByUser ?? (artifacts.length === 0 || compact)
  const setCollapsed = setCollapsedByUser
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
        {artifacts.length > 1 ? (
          <MenuRoot>
            <MenuTrigger asChild>
              <button
                className="flex ui-state cursor-pointer items-center gap-1 rounded-sm px-2 py-1 text-body font-medium text-on-surface ui-focus"
                type="button"
              >
                {selected?.title}
              </button>
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
        ) : (
          <h2 className="px-2 text-body font-medium text-on-surface">
            {selected?.title ?? '面板'}
          </h2>
        )}

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
