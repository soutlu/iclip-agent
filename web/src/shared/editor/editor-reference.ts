import type { JSONContent } from '@tiptap/core'

export const EDITOR_REFERENCE_KINDS = [
  'image',
  'video',
  'audio',
  'note',
  'arrow',
  'brush',
  'frame',
] as const

export type EditorReferenceKind = (typeof EDITOR_REFERENCE_KINDS)[number]

export type EditorReferenceMediaSource = {
  displayName: string
  kind: 'audio' | 'image' | 'video'
  previewUrl?: string
  url: string
}

export type EditorReference = {
  id: string
  kind: EditorReferenceKind
  label: string
  source?: EditorReferenceMediaSource
}

export type EditorReferenceMap = ReadonlyMap<string, EditorReference>

export type EditorMediaReference<
  Kind extends EditorReferenceMediaSource['kind'] = EditorReferenceMediaSource['kind'],
> = Omit<EditorReference, 'kind' | 'source'> & {
  kind: Kind
  source: EditorReferenceMediaSource & { kind: Kind }
}

export type CreateEditorMediaReferenceOptions<
  Kind extends EditorReferenceMediaSource['kind'] = EditorReferenceMediaSource['kind'],
> = {
  id: string
  kind: Kind
  label: string
  previewUrl?: string
  sourceDisplayName: string
  url: string
}

const MAX_EDITOR_REFERENCE_SUGGESTIONS = 20
const EDITOR_REFERENCE_KIND_RANK = new Map(
  EDITOR_REFERENCE_KINDS.map((kind, index) => [kind, index]),
)

/**
 * 读取引用类型的统一排序权重，并拒绝绕过 TypeScript 的外部非法值。
 *
 * @param kind - 待排序的引用类型。
 * @returns 类型在统一目录中的排序权重。
 * @throws 当运行时类型不在引用合同内时抛出错误。
 */
const getEditorReferenceKindRank = (kind: EditorReferenceKind): number => {
  const rank = EDITOR_REFERENCE_KIND_RANK.get(kind)
  if (rank === undefined) throw new Error(`未知的编辑器引用类型：${String(kind)}`)
  return rank
}

/**
 * 把任意媒体来源转换成所有输入框共用的引用合同。
 *
 * @param options - 稳定身份、统一标签，以及媒体来源信息。
 * @returns 可直接进入共享目录、chip 与候选菜单的媒体引用。
 */
export const createEditorMediaReference = <Kind extends EditorReferenceMediaSource['kind']>({
  id,
  kind,
  label,
  previewUrl,
  sourceDisplayName,
  url,
}: CreateEditorMediaReferenceOptions<Kind>): EditorMediaReference<Kind> => ({
  id,
  kind,
  label,
  source: {
    displayName: sourceDisplayName,
    kind,
    ...(previewUrl ? { previewUrl } : {}),
    url,
  },
})

/**
 * 校验引用目录的稳定身份与统一标签，并建立只读索引。
 *
 * @param references - 当前输入框允许引用的领域目录。
 * @returns 以稳定引用 ID 为键的只读目录。
 * @throws 当引用 ID、标签为空或重复，或引用类型不受支持时抛出错误。
 */
export const createEditorReferenceMap = <Reference extends EditorReference>(
  references: readonly Reference[],
): ReadonlyMap<string, Reference> => {
  const referenceMap = new Map<string, Reference>()
  const labels = new Set<string>()

  for (const reference of references) {
    if (reference.id.trim().length === 0) {
      throw new Error('编辑器引用 id 不能为空。')
    }

    getEditorReferenceKindRank(reference.kind)

    if (referenceMap.has(reference.id)) {
      throw new Error(`编辑器引用 id 重复：${reference.id}`)
    }

    if (reference.label.trim().length === 0) {
      throw new Error('编辑器引用 label 不能为空。')
    }

    if (labels.has(reference.label)) {
      throw new Error(`编辑器引用 label 重复：${reference.label}`)
    }

    referenceMap.set(reference.id, reference)
    labels.add(reference.label)
  }

  return referenceMap
}

/**
 * 以统一类型优先级搜索引用；同类型保留调用方 catalog 顺序。
 *
 * @param references - 当前输入框可用的共享引用目录。
 * @param query - 用户在 @ 后输入的 canonical label。
 * @returns 按统一类型顺序筛选后的候选，最多返回 20 项。
 * @throws 当目录包含不受支持的引用类型时抛出错误。
 */
export const searchEditorReferences = (
  references: Iterable<EditorReference>,
  query: string,
): EditorReference[] => {
  const normalizedQuery = query.trim().toLowerCase()

  return Array.from(references)
    .map((reference, catalogIndex) => ({
      catalogIndex,
      kindRank: getEditorReferenceKindRank(reference.kind),
      reference,
    }))
    .filter(({ reference }) =>
      normalizedQuery.length === 0 ? true : reference.label.toLowerCase().includes(normalizedQuery),
    )
    .sort((left, right) => left.kindRank - right.kindRank || left.catalogIndex - right.catalogIndex)
    .slice(0, MAX_EDITOR_REFERENCE_SUGGESTIONS)
    .map(({ reference }) => reference)
}

/**
 * 用户主动删除来源时，从 Tiptap JSON 中同步删除对应稳定 Mention。
 * 外部 catalog 变化不应调用本函数，从而保留可见的失效引用。
 *
 * @param document - 需要更新的 Tiptap JSON 文档。
 * @param nodeName - 当前输入框使用的共享 Mention 节点名称。
 * @param referenceIds - 用户已主动删除的稳定引用 ID 集合。
 * @returns 移除目标 Mention 并合并相邻纯文本后的新文档。
 * @throws 当文档节点非法、引用缺少稳定 ID 或根节点本身是引用时抛出错误。
 */
export const removeEditorReferencesFromDocument = (
  document: JSONContent,
  nodeName: string,
  referenceIds: ReadonlySet<string>,
): JSONContent => {
  const visit = (node: JSONContent): JSONContent | null => {
    if (typeof node.type !== 'string' || node.type.length === 0) {
      throw new Error('编辑器文档节点缺少有效 type。')
    }

    if (node.type === nodeName) {
      const referenceId = node.attrs?.id

      if (typeof referenceId !== 'string' || referenceId.length === 0) {
        throw new Error(`编辑器引用节点缺少稳定 id：${nodeName}`)
      }

      if (referenceIds.has(referenceId)) return null
    }

    if (node.content === undefined) return node
    if (!Array.isArray(node.content)) throw new Error(`编辑器文档节点 content 无效：${node.type}`)

    const nextContent = node.content
      .flatMap((child) => {
        const nextChild = visit(child)
        return nextChild ? [nextChild] : []
      })
      .reduce<JSONContent[]>((content, child) => {
        const previous = content.at(-1)
        if (
          previous?.type === 'text' &&
          child.type === 'text' &&
          typeof previous.text === 'string' &&
          typeof child.text === 'string' &&
          previous.attrs === undefined &&
          child.attrs === undefined &&
          previous.marks === undefined &&
          child.marks === undefined
        ) {
          return [...content.slice(0, -1), { ...previous, text: previous.text + child.text }]
        }

        return [...content, child]
      }, [])

    const { content: _removedContent, ...nodeWithoutContent } = node
    return nextContent.length > 0
      ? { ...nodeWithoutContent, content: nextContent }
      : nodeWithoutContent
  }

  const nextDocument = visit(document)
  if (!nextDocument) throw new Error('编辑器根文档不能是引用节点。')
  return nextDocument
}
