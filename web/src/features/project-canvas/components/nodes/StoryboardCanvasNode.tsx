import type { NodeProps } from '@xyflow/react'
import { memo, useCallback } from 'react'
import { StoryboardCanvasCard } from '@/features/artifacts'
import CanvasNodeFrame from '@/features/project-canvas/components/nodes/CanvasNodeFrame'
import type { StoryboardProjectCanvasNode } from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import { useProjectCanvasStore } from '@/features/project-canvas/state/project-canvas-store'

/**
 * 渲染动态分镜表画布节点。
 *
 * @param props - React Flow 传入的分镜表节点属性。
 * @returns 可拖拽、可选中、可导出的固定尺寸分镜表节点。
 */
function StoryboardCanvasNode({ id, data, selected }: NodeProps<StoryboardProjectCanvasNode>) {
  const registerExportTarget = useProjectCanvasStore((state) => state.registerExportTarget)
  const selectNode = useProjectCanvasStore((state) => state.selectNode)
  const setExportTargetRef = useCallback(
    (element: HTMLDivElement | null) => {
      registerExportTarget(id, element)
    },
    [id, registerExportTarget],
  )

  return (
    <CanvasNodeFrame
      exportRef={setExportTargetRef}
      highlightToken={data.highlightToken}
      isHighlighted={data.isHighlighted}
      onSelect={() => selectNode(id)}
      selected={selected}
      title={data.title}
    >
      <div className="relative h-full min-h-0 overflow-hidden bg-canvas-card-bg">
        <div className="h-full min-h-0 w-full">
          <StoryboardCanvasCard storyboard={data.storyboard} />
        </div>
      </div>
    </CanvasNodeFrame>
  )
}

export default memo(StoryboardCanvasNode)
