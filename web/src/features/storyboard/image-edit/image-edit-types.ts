/** 编辑器的交互数据；引用用稳定 ID，编号仅作显示。HTTP 边界由生成合同校验。 */
export type AnnotationPoint = { x: number; y: number }
export type AnnotationKind = 'point' | 'rectangle' | 'ellipse' | 'arrow' | 'pen'
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
/** 编辑器开在哪一格。底图不在里面：它随选中的图变，应用之后这一格的图也会变。 */
export type FrameEditTarget = {
  conversationId: string
  shotIndex: number
  frameNumber: number
}
export type FrameEditDraft = {
  annotations: ImageAnnotation[]
  instructions: EditInstruction[]
  references: EditReference[]
}
