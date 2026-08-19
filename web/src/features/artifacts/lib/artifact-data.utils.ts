import { normalizeCreativeBriefOutput } from '@/features/artifacts/lib/creative-brief.utils'
import { normalizeGeneratedVideoOutput } from '@/features/artifacts/lib/generated-video.utils'
import { normalizeImageAnalysisSummaryOutput } from '@/features/artifacts/lib/image-analysis-summary.utils'
import { normalizeMarkdownArtifactOutput } from '@/features/artifacts/lib/markdown.utils'
import { normalizeStoryboardOutput } from '@/features/artifacts/lib/storyboard.utils'
import { normalizeUiCardArtifactOutput } from '@/features/artifacts/lib/ui-card.utils'
import { normalizeVideoPromptOutput } from '@/features/artifacts/lib/video-prompt.utils'
import type { CreativeBriefOutput } from '@/features/artifacts/types/creative-brief.types'
import type { GeneratedVideoOutput } from '@/features/artifacts/types/generated-video.types'
import type { ImageAnalysisSummaryOutput } from '@/features/artifacts/types/image-analysis-summary.types'
import type { MarkdownArtifactOutput } from '@/features/artifacts/types/markdown.types'
import type { StoryboardOutput } from '@/features/artifacts/types/storyboard.types'
import type { UiCardArtifactOutput } from '@/features/artifacts/types/ui-card.types'
import type { VideoPromptOutput } from '@/features/artifacts/types/video-prompt.types'

export interface ProjectCreativeBriefArtifact {
  artifactId: string
  kind: 'brief'
  output: CreativeBriefOutput
}

export interface ProjectStoryboardArtifact {
  artifactId: string
  kind: 'storyboard'
  output: StoryboardOutput
}

export interface ProjectGeneratedVideoArtifact {
  artifactId: string
  kind: 'generated-video'
  output: GeneratedVideoOutput
}

export interface ProjectVideoPromptArtifact {
  artifactId: string
  kind: 'video-prompt'
  output: VideoPromptOutput
}

export interface ProjectUiCardArtifact {
  artifactId: string
  kind: 'ui-card'
  output: UiCardArtifactOutput
}

export interface ProjectMarkdownArtifact {
  artifactId: string
  kind: 'markdown'
  output: MarkdownArtifactOutput
}

export interface ProjectImageAnalysisSummaryArtifact {
  artifactId: string
  kind: 'image-analysis-summary'
  output: ImageAnalysisSummaryOutput
}

export type ProjectArtifactDescriptor =
  | ProjectCreativeBriefArtifact
  | ProjectGeneratedVideoArtifact
  | ProjectImageAnalysisSummaryArtifact
  | ProjectMarkdownArtifact
  | ProjectStoryboardArtifact
  | ProjectVideoPromptArtifact
  | ProjectUiCardArtifact

export type ProjectArtifactPayloadKind =
  | 'brief'
  | 'generated-video'
  | 'image-analysis-summary'
  | 'markdown'
  | 'storyboard'
  | 'ui-card'
  | 'video-prompt'

interface ProjectArtifactPayloadCandidate {
  data?: unknown
  id?: string
  kind?: ProjectArtifactPayloadKind
}

export const IMAGE_ANALYSIS_SUMMARY_ARTIFACT_ID = 'artifact:input:image:image-parser-summary'

/**
 * 获取 artifact 的稳定去重 identity。
 *
 * @param artifact - 需要参与去重的 artifact。
 * @returns 由 artifact 类型和稳定 artifact id 组成的 identity。
 */
export const getProjectArtifactIdentity = (
  artifact: Pick<ProjectArtifactDescriptor, 'artifactId' | 'kind'>,
) => `${artifact.kind}:${artifact.artifactId}`

/**
 * 合并多个图片解析汇总 artifact，避免输入图片解析在画布上分裂成多个节点。
 *
 * @param artifacts - 需要同步到画布或项目状态的 artifact 列表。
 * @returns 图片解析汇总已收敛为单个 artifact 的新列表；其它 artifact 保持原顺序。
 */
export const mergeImageAnalysisSummaryArtifacts = (artifacts: ProjectArtifactDescriptor[]) => {
  const mergedArtifacts: ProjectArtifactDescriptor[] = []
  const imageAnalysisItemsByKey = new Map<string, ImageAnalysisSummaryOutput['items'][number]>()
  let imageAnalysisSummary: ProjectImageAnalysisSummaryArtifact | null = null
  let imageAnalysisSummaryIndex = -1

  for (const artifact of artifacts) {
    if (artifact.kind !== 'image-analysis-summary') {
      mergedArtifacts.push(artifact)
      continue
    }

    if (!imageAnalysisSummary) {
      imageAnalysisSummary = {
        ...artifact,
        artifactId: IMAGE_ANALYSIS_SUMMARY_ARTIFACT_ID,
        output: {
          items: [],
        },
      }
      imageAnalysisSummaryIndex = mergedArtifacts.length
      mergedArtifacts.push(imageAnalysisSummary)
    }

    for (const item of artifact.output.items) {
      imageAnalysisItemsByKey.set(item.key, item)
    }
  }

  if (imageAnalysisSummary && imageAnalysisSummaryIndex >= 0) {
    mergedArtifacts[imageAnalysisSummaryIndex] = {
      ...imageAnalysisSummary,
      output: {
        items: [...imageAnalysisItemsByKey.values()],
      },
    }
  }

  return mergedArtifacts
}

/**
 * 将后端 artifact payload 规范化为前端 artifact 描述。
 *
 * @param candidate - 后端 state 或媒体 store 中恢复出的 artifact payload。
 * @returns 可渲染的 artifact 描述；id 缺失或类型未知时返回 null。
 */
export const projectArtifactFromPayload = (
  candidate: ProjectArtifactPayloadCandidate,
): ProjectArtifactDescriptor | null => {
  if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
    return null
  }

  const candidateId = candidate.id.trim()

  switch (candidate.kind) {
    case 'brief': {
      const normalizedOutput = normalizeCreativeBriefOutput(candidate.data)

      return normalizedOutput
        ? {
            artifactId: candidateId,
            kind: 'brief',
            output: normalizedOutput,
          }
        : null
    }
    case 'storyboard': {
      const normalizedOutput = normalizeStoryboardOutput(candidate.data)

      return normalizedOutput
        ? {
            artifactId: candidateId,
            kind: 'storyboard',
            output: normalizedOutput,
          }
        : null
    }
    case 'generated-video': {
      const normalizedOutput = normalizeGeneratedVideoOutput(candidate.data)

      return normalizedOutput
        ? {
            artifactId: candidateId,
            kind: 'generated-video',
            output: normalizedOutput,
          }
        : null
    }
    case 'video-prompt': {
      const normalizedOutput = normalizeVideoPromptOutput(candidate.data)

      return normalizedOutput
        ? {
            artifactId: candidateId,
            kind: 'video-prompt',
            output: normalizedOutput,
          }
        : null
    }
    case 'ui-card': {
      const normalizedOutput = normalizeUiCardArtifactOutput(candidate.data)

      return normalizedOutput
        ? {
            artifactId: candidateId,
            kind: 'ui-card',
            output: normalizedOutput,
          }
        : null
    }
    case 'markdown': {
      const normalizedOutput = normalizeMarkdownArtifactOutput(candidate.data)

      return normalizedOutput
        ? {
            artifactId: candidateId,
            kind: 'markdown',
            output: normalizedOutput,
          }
        : null
    }
    case 'image-analysis-summary': {
      const normalizedOutput = normalizeImageAnalysisSummaryOutput(candidate.data)

      return normalizedOutput
        ? {
            artifactId: IMAGE_ANALYSIS_SUMMARY_ARTIFACT_ID,
            kind: 'image-analysis-summary',
            output: normalizedOutput,
          }
        : null
    }
    default:
      return null
  }
}
