/** 编辑器的交互数据；引用用稳定 ID，编号仅作显示。HTTP 边界由生成合同校验。 */
export type AnnotationPoint = { x: number; y: number }
export type AnnotationKind = 'rectangle' | 'ellipse' | 'arrow' | 'pen'
export type ImageAnnotation = {
  id: string
  number: number
  kind: AnnotationKind
  points: AnnotationPoint[]
}
export type EditInstruction =
  | { kind: 'text'; text: string }
  | { kind: 'annotation'; id: string }
  | { kind: 'referenceImage'; id: string }
export type EditReference = {
  id: string
  kind: 'image' | 'annotated'
  url: string
  label: string
}
export type FrameEditTarget = {
  conversationId: string
  artifactPath: string
  shotIndex: number
  frameNumber: number
  sourceUrl: string
}
export type FrameEditDraft = {
  annotations: ImageAnnotation[]
  instructions: EditInstruction[]
  references: EditReference[]
}
