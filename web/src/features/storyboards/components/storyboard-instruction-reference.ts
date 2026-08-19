import {
  createEditorMediaReference,
  type EditorReference,
  type EditorReferenceKind,
} from '@/shared/editor'

export const STORYBOARD_ANNOTATION_TOOL_DEFINITIONS = [
  {
    controlLabel: '标记点 · 点击打点',
    icon: 'annotation-point',
    label: '标记点',
    referenceKind: 'note',
    referenceLabel: '标注',
    tool: 'point',
  },
  {
    controlLabel: '框选 · 实心色块',
    icon: 'annotation-rect',
    label: '框选',
    referenceKind: 'frame',
    referenceLabel: '线框',
    tool: 'rect',
  },
  {
    controlLabel: '画笔 · 细',
    icon: 'annotation-pen',
    label: '画笔',
    referenceKind: 'brush',
    referenceLabel: '画笔',
    tool: 'pen',
  },
  {
    controlLabel: '箭头 · 细',
    icon: 'annotation-arrow',
    label: '箭头',
    referenceKind: 'arrow',
    referenceLabel: '箭头',
    tool: 'arrow',
  },
] as const satisfies ReadonlyArray<{
  controlLabel: string
  icon: 'annotation-arrow' | 'annotation-pen' | 'annotation-point' | 'annotation-rect'
  label: string
  referenceKind: EditorReferenceKind
  referenceLabel: string
  tool: string
}>

export type StoryboardAnnotationTool =
  (typeof STORYBOARD_ANNOTATION_TOOL_DEFINITIONS)[number]['tool']

export type StoryboardAnnotationReference = {
  id: string
  kind: 'annotation'
  label: string
  sourcePreviewUrl: string
  tool: StoryboardAnnotationTool
}

export type StoryboardImageReference = {
  id: string
  kind: 'image'
  label: string
  sourcePreviewUrl: string
}

export type StoryboardInstructionReference =
  StoryboardAnnotationReference | StoryboardImageReference

/**
 * 读取标注工具的唯一显示、图标和引用类型定义。
 *
 * @param tool - Storyboard 标注工具。
 * @returns 对应的只读工具定义。
 * @throws 当运行时工具不在支持列表中时抛出错误。
 */
export const getStoryboardAnnotationToolDefinition = (tool: StoryboardAnnotationTool) => {
  const definition = STORYBOARD_ANNOTATION_TOOL_DEFINITIONS.find(
    (candidate) => candidate.tool === tool,
  )

  if (!definition) throw new Error(`未知的 Storyboard 标注工具：${tool}`)
  return definition
}

/**
 * 把 Storyboard 领域引用投影为所有输入框共用的编辑器引用合同。
 *
 * @param reference - 当前镜头的媒体或画面标注引用。
 * @returns 只包含共享搜索、排序、显示和提交语义的编辑器引用。
 */
export const toStoryboardEditorReference = (
  reference: StoryboardInstructionReference,
): EditorReference => {
  if (reference.kind === 'image') {
    return createEditorMediaReference({
      id: reference.id,
      kind: reference.kind,
      label: reference.label,
      previewUrl: reference.sourcePreviewUrl,
      sourceDisplayName: reference.label,
      url: reference.sourcePreviewUrl,
    })
  }

  const definition = getStoryboardAnnotationToolDefinition(reference.tool)
  return {
    id: reference.id,
    kind: definition.referenceKind,
    label: reference.label,
    source: {
      displayName: reference.label,
      kind: 'image',
      previewUrl: reference.sourcePreviewUrl,
      url: reference.sourcePreviewUrl,
    },
  }
}
