export interface CreativeBriefFABTranslation {
  advantage?: string
  benefit?: string
  feature?: string
}

export interface CreativeBriefStrategicAlignment {
  coreClaim?: string
  fabTranslation?: CreativeBriefFABTranslation
  stateShift?: string
}

export interface CreativeBriefFormulaAdaptation {
  hookMatch?: string
  proofMatch?: string
}

export interface CreativeBriefNarrativeNode {
  adaptedTechnique?: string
  dialogueDirection?: string
  duration?: string
  newNodeFunction?: string
  nodeName?: string
  originalFunction?: string
  originalTechnique?: string
  recommendedShot?: string
  shootingConcept?: string
}

export interface CreativeBriefAdaptationMapping {
  actionMapping?: string
  dialogueDirectionMap?: string
  mechanismMapping?: string
  nodeName?: string
  sceneMapping?: string
}

export interface CreativeBriefAVGuardrails {
  colorPalette?: string[]
  interactionBait?: string
  onCameraPersona?: string
  soundEngineering?: string
  visualArtDirection?: string
}

export interface CreativeBriefExecutionRules {
  donts?: string[]
  mustHaves?: string[]
}

export interface CreativeBriefOutput {
  adaptationMappings?: CreativeBriefAdaptationMapping[]
  avGuardrails?: CreativeBriefAVGuardrails
  executionRules?: CreativeBriefExecutionRules
  formulaAdaptation?: CreativeBriefFormulaAdaptation
  narrativeAdaptation?: CreativeBriefNarrativeNode[]
  strategicAlignment?: CreativeBriefStrategicAlignment
}

export type CreativeBriefToolOutput = CreativeBriefOutput | Record<string, unknown> | string

export interface CreativeBriefToolInput {
  answers?: Record<string, unknown>
  prompt: string
}
