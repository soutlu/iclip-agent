import { useMemo } from 'react'
import { useProjectChatResources } from '@/features/chat'
import {
  createCanvasVideoStoryboardNodesFromGenerationFacts,
  type ProjectCanvasFlowNode,
  type StoryboardWorkbenchProjectCanvasNode,
  type StoryboardWorkbenchRedoShotInput,
  useProjectCanvasStore,
  type VideoPromptProjectCanvasNode,
} from '@/features/project-canvas'
import ProjectCanvasStage from '@/features/project-workspace/components/ProjectCanvasStage'

type CanvasVideoStoryboardNodeCandidate = ReturnType<
  typeof createCanvasVideoStoryboardNodesFromGenerationFacts
>[number]

const isStoryboardWorkbenchNode = (
  node: CanvasVideoStoryboardNodeCandidate,
): node is StoryboardWorkbenchProjectCanvasNode => node.type === 'storyboard-workbench-node'

const isVideoPromptNode = (node: ProjectCanvasFlowNode): node is VideoPromptProjectCanvasNode =>
  node.type === 'video-prompt-node'

const getLatestVideoPromptNodeId = (nodes: ProjectCanvasFlowNode[]) =>
  nodes.findLast(isVideoPromptNode)?.id ?? null

export default function ProjectDesktopShell() {
  const { assets, generationRecords } = useProjectChatResources()
  const canvasNodes = useProjectCanvasStore((state) => state.nodes)
  const selectNode = useProjectCanvasStore((state) => state.selectNode)
  const latestVideoPromptNodeId = useMemo(
    () => getLatestVideoPromptNodeId(canvasNodes),
    [canvasNodes],
  )
  const handleRedoShot = useMemo<((input: StoryboardWorkbenchRedoShotInput) => void) | undefined>(
    () => (latestVideoPromptNodeId ? () => selectNode(latestVideoPromptNodeId) : undefined),
    [latestVideoPromptNodeId, selectNode],
  )
  const storyboardNodes = useMemo(
    () =>
      createCanvasVideoStoryboardNodesFromGenerationFacts({
        assets,
        generations: generationRecords,
        onRedoShot: handleRedoShot,
      }).filter(isStoryboardWorkbenchNode),
    [assets, generationRecords, handleRedoShot],
  )

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <ProjectCanvasStage
        extraCanvasNodes={storyboardNodes}
        showExtraCanvasNodes={false}
        showProjectNodes={false}
      />
    </div>
  )
}
