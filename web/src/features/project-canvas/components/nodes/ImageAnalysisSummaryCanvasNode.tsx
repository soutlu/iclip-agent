import type { NodeProps } from '@xyflow/react'
import { memo, useCallback } from 'react'
import { ImageAnalysisSummaryCanvasCard } from '@/features/artifacts'
import CanvasNodeFrame from '@/features/project-canvas/components/nodes/CanvasNodeFrame'
import type { ImageAnalysisSummaryProjectCanvasNode } from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import { useProjectCanvasStore } from '@/features/project-canvas/state/project-canvas-store'

/**
 * 渲染输入图片解析结果汇总的画布节点。
 *
 * @param props - React Flow 传入的图片解析汇总节点属性。
 * @returns 可拖拽、可选中、可导出的 2×n 图片解析汇总节点。
 */
function ImageAnalysisSummaryCanvasNode({
  id,
  data,
  selected,
}: NodeProps<ImageAnalysisSummaryProjectCanvasNode>) {
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
      <ImageAnalysisSummaryCanvasCard summary={data.imageAnalysisSummary} />
    </CanvasNodeFrame>
  )
}

export default memo(ImageAnalysisSummaryCanvasNode)
