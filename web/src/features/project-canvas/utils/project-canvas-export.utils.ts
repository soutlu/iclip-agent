import { toBlob } from 'html-to-image'
import type { ProjectCanvasNodeSummary } from '@/features/project-canvas/components/nodes/project-canvas-node.types'

const EXPORTABLE_CANVAS_NODE_KINDS = ['brief', 'storyboard', 'ui-card', 'markdown'] as const
const WHITESPACE_PATTERN = /\s+/g
const HYPHEN_PATTERN = /-+/g
const TRAILING_DOTS_OR_SPACES_PATTERN = /[. ]+$/g
const MAX_FILENAME_BASENAME_LENGTH = 120

type ExportableCanvasNodeKind = (typeof EXPORTABLE_CANVAS_NODE_KINDS)[number]

export type ExportableProjectCanvasNodeSummary = ProjectCanvasNodeSummary & {
  kind: ExportableCanvasNodeKind
}

const FALLBACK_EXPORT_FILENAME_PREFIX = {
  brief: 'brief',
  markdown: 'markdown',
  storyboard: 'storyboard',
  'ui-card': 'ui-card',
} as const satisfies Record<ExportableCanvasNodeKind, string>

const replaceIllegalFilenameCharacters = (value: string, replacement: string) =>
  Array.from(value, (character) => {
    const characterCode = character.charCodeAt(0)

    if (characterCode <= 31 || '<>:"/\\|?*'.includes(character)) {
      return replacement
    }

    return character
  }).join('')

const sanitizeFilenameSegment = (value: string) =>
  replaceIllegalFilenameCharacters(value, ' ')
    .replace(WHITESPACE_PATTERN, ' ')
    .trim()
    .replace(TRAILING_DOTS_OR_SPACES_PATTERN, '')
    .slice(0, MAX_FILENAME_BASENAME_LENGTH)
    .trim()

const createNodeIdSuffix = (nodeId: string) => {
  const sanitizedId = replaceIllegalFilenameCharacters(nodeId, '-')
    .replace(WHITESPACE_PATTERN, '-')
    .replace(HYPHEN_PATTERN, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-24)

  return sanitizedId || 'node'
}

const waitForDocumentFonts = async () => {
  if (typeof document === 'undefined' || !('fonts' in document)) {
    return
  }

  await document.fonts.ready
}

const downloadBlob = (blob: Blob, filename: string) => {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

export const isCanvasNodeExportable = (
  node: ProjectCanvasNodeSummary | null | undefined,
): node is ExportableProjectCanvasNodeSummary =>
  node !== null &&
  node !== undefined &&
  EXPORTABLE_CANVAS_NODE_KINDS.includes(node.kind as ExportableCanvasNodeKind)

export const buildCanvasExportFilename = (
  node: Pick<ProjectCanvasNodeSummary, 'id' | 'kind' | 'title'>,
) => {
  const titleBasename = sanitizeFilenameSegment(node.title)

  if (titleBasename.length > 0) {
    return `${titleBasename}.png`
  }

  const fallbackPrefix = FALLBACK_EXPORT_FILENAME_PREFIX[node.kind as ExportableCanvasNodeKind]
  const idSuffix = createNodeIdSuffix(node.id)

  return `${fallbackPrefix}-${idSuffix}.png`
}

export const exportCanvasNodeElementAsPng = async ({
  element,
  filename,
}: {
  element: HTMLElement
  filename: string
}) => {
  await waitForDocumentFonts()

  const blob = await toBlob(element, {
    cacheBust: true,
    pixelRatio: 1,
  })

  if (!blob) {
    throw new Error('导出 PNG 失败：未生成有效的图片数据。')
  }

  downloadBlob(blob, filename)
}
