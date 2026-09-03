/**
 * 产物面板宿主：只管几何、两个来源的合成、选中态与分派，不认识任何具体产物类型。
 *
 * 几何三态——并排、放大（铺满主区）、折叠（主区右上浮出展开钮）。放不放得下并排由壳算好递进来
 * （侧栏宽度可拖，不是一个断点能定的）；放不下时聊天与面板只显示其一，面板一侧给「回到聊天」。
 */

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

/**
 * 工具帧来源这一期不接线：面板与会话页会各建一个 transcript reader，而 `subscribe` 是覆盖式的，
 * 后挂上的那个会把聊天的推送顶掉。合成逻辑本身按两个来源写全（见 `registry.test.ts`）。
 */
const NO_FRAMES: readonly WorkbenchFrame[] = []

type WorkbenchHostProps = {
  conversationId: string
}

/**
 * 渲染产物面板。
 *
 * @param props - 组件属性。
 * @param props.conversationId - 哪一段对话。
 * @returns 产物面板，折叠时是主区右上的展开钮。
 */
export function WorkbenchHost({ conversationId }: WorkbenchHostProps) {
  const registry = useWorkbenchRegistry()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const connection = use(TranscriptConnectionContext)
  const search: { artifact?: string } = useSearch({ strict: false })
  const files = useWorkspaceFiles(conversationId)
  // 用户点过折叠 / 展开就听他的；没点过按「有没有产物」定：一件都没有的对话不该白占掉 820。
  const [collapsedByUser, setCollapsedByUser] = useState<boolean | null>(null)
  const [maximized, setMaximized] = useState(false)
  const { compact, onPanelVisible, sideBySide } =
    use(WorkbenchLayoutContext) ?? DEFAULT_WORKBENCH_LAYOUT

  // 断线期间文件变了没人通知：重连之后整份重拉一次对齐（contract/conventions.md §5 文件订阅）。
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
  // 并排放不下、或者用户点了放大：面板盖住主区，聊天列这一刻不显示。
  const covering = maximized || !sideBySide
  // 只有真正占着布局位的时候，壳才该在聊天与面板之间画那道拖柄。
  const occupiesLayout = !collapsed && !covering
  useEffect(() => {
    onPanelVisible?.(occupiesLayout)
    // 壳活得比面板久（换路由时它不重挂）：不报一声「我走了」，那道拖柄会留在首页上。
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
