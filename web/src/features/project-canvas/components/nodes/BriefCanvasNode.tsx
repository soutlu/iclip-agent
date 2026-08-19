import type { NodeProps } from '@xyflow/react'
import { memo, useCallback } from 'react'
import { CreativeBriefCanvasCard } from '@/features/artifacts'
import CanvasNodeFrame from '@/features/project-canvas/components/nodes/CanvasNodeFrame'
import type { BriefProjectCanvasNode } from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import { useProjectCanvasStore } from '@/features/project-canvas/state/project-canvas-store'

/**
 * 渲染创意策略简报画布节点。
 *
 * @param props - React Flow 传入的创意策略简报节点属性。
 * @returns 可拖拽、可选中、可导出的固定尺寸简报节点。
 */
function BriefCanvasNode({ id, data, selected }: NodeProps<BriefProjectCanvasNode>) {
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
      <div className="relative h-full min-h-0 overflow-hidden bg-[var(--color-canvas-card-bg)]">
        <div className="h-full min-h-0 w-full">
          <CreativeBriefCanvasCard brief={data.brief} />
        </div>
      </div>
    </CanvasNodeFrame>
  )
}

export default memo(BriefCanvasNode)
