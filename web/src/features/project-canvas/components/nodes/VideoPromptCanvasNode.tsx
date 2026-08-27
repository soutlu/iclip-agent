import type { NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { VideoPromptCanvasCard } from '@/features/artifacts'
import { useProjectChatVideoGeneration } from '@/features/chat'
import CanvasNodeFrame from '@/features/project-canvas/components/nodes/CanvasNodeFrame'
import type { VideoPromptProjectCanvasNode } from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import { useProjectCanvasStore } from '@/features/project-canvas/state/project-canvas-store'

/**
 * 渲染视频提示词画布节点。
 *
 * @param props - React Flow 节点属性。
 * @param props.id - 当前节点 id。
 * @param props.data - 当前节点携带的视频提示词数据。
 * @param props.selected - 当前节点是否被选中。
 * @returns 视频提示词画布节点元素。
 */
function VideoPromptCanvasNode({ id, data, selected }: NodeProps<VideoPromptProjectCanvasNode>) {
  const selectNode = useProjectCanvasStore((state) => state.selectNode)
  const { isInteractionLocked, saveVideoPrompt, submitVideoGenerations, submitVideoGeneration } =
    useProjectChatVideoGeneration()

  return (
    <CanvasNodeFrame
      highlightToken={data.highlightToken}
      isHighlighted={data.isHighlighted}
      onSelect={() => selectNode(id)}
      selected={selected}
      title={data.title}
    >
      <div className="relative h-full min-h-0 overflow-hidden bg-background">
        <div className="h-full min-h-0 w-full">
          <VideoPromptCanvasCard
            generatedVideo={data.generatedVideo}
            isVideoGenerationDisabled={isInteractionLocked}
            onSavePrompt={saveVideoPrompt}
            onSubmitVideoGenerations={submitVideoGenerations}
            onSubmitVideoGeneration={submitVideoGeneration}
            videoPrompt={data.videoPrompt}
          />
        </div>
      </div>
    </CanvasNodeFrame>
  )
}

export default memo(VideoPromptCanvasNode)
