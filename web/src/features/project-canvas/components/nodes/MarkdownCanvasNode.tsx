import type { NodeProps } from '@xyflow/react'
import { memo, useCallback } from 'react'
import { MarkdownCanvasCard } from '@/features/artifacts'
import CanvasNodeFrame from '@/features/project-canvas/components/nodes/CanvasNodeFrame'
import type { MarkdownProjectCanvasNode } from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import { useProjectCanvasStore } from '@/features/project-canvas/state/project-canvas-store'

/**
 * 渲染通用 Markdown artifact 的画布节点。
 *
 * @param props - React Flow 传入的 Markdown 节点属性。
 * @returns 可拖拽、可选中、可导出的 Markdown 画布节点。
 */
function MarkdownCanvasNode({ id, data, selected }: NodeProps<MarkdownProjectCanvasNode>) {
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
      <MarkdownCanvasCard markdown={data.markdown} />
    </CanvasNodeFrame>
  )
}

export default memo(MarkdownCanvasNode)
