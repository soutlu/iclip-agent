import type {
  CreativeBriefAdaptationMapping,
  CreativeBriefAVGuardrails,
  CreativeBriefExecutionRules,
  CreativeBriefFABTranslation,
  CreativeBriefFormulaAdaptation,
  CreativeBriefNarrativeNode,
  CreativeBriefOutput,
  CreativeBriefStrategicAlignment,
} from '@/features/artifacts/types/creative-brief.types'
import { isRecord } from '@/shared/lib/guards'

const getNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

const getStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const normalized = getNonEmptyString(item)

        return normalized ? [normalized] : []
      })
    : []

const hasValue = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return value.trim().length > 0
  }

  if (Array.isArray(value)) {
    return value.length > 0
  }

  if (isRecord(value)) {
    return Object.values(value).some((item) => hasValue(item))
  }

  return false
}

const normalizeFABTranslation = (value: unknown): CreativeBriefFABTranslation | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const fabTranslation: CreativeBriefFABTranslation = {
    advantage: getNonEmptyString(value.advantage),
    benefit: getNonEmptyString(value.benefit),
    feature: getNonEmptyString(value.feature),
  }

  return hasValue(fabTranslation) ? fabTranslation : undefined
}

const normalizeStrategicAlignment = (
  value: unknown,
): CreativeBriefStrategicAlignment | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const strategicAlignment: CreativeBriefStrategicAlignment = {
    coreClaim: getNonEmptyString(value.coreClaim),
    fabTranslation: normalizeFABTranslation(value.fabTranslation),
    stateShift: getNonEmptyString(value.stateShift),
  }

  return hasValue(strategicAlignment) ? strategicAlignment : undefined
}

const normalizeFormulaAdaptation = (value: unknown): CreativeBriefFormulaAdaptation | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const formulaAdaptation: CreativeBriefFormulaAdaptation = {
    hookMatch: getNonEmptyString(value.hookMatch),
    proofMatch: getNonEmptyString(value.proofMatch),
  }

  return hasValue(formulaAdaptation) ? formulaAdaptation : undefined
}

const normalizeNarrativeNode = (value: unknown): CreativeBriefNarrativeNode | null => {
  if (!isRecord(value)) {
    return null
  }

  const narrativeNode: CreativeBriefNarrativeNode = {
    adaptedTechnique: getNonEmptyString(value.adaptedTechnique),
    dialogueDirection: getNonEmptyString(value.dialogueDirection),
    duration: getNonEmptyString(value.duration),
    newNodeFunction: getNonEmptyString(value.newNodeFunction),
    nodeName: getNonEmptyString(value.nodeName),
    originalFunction: getNonEmptyString(value.originalFunction),
    originalTechnique: getNonEmptyString(value.originalTechnique),
    recommendedShot: getNonEmptyString(value.recommendedShot),
    shootingConcept: getNonEmptyString(value.shootingConcept),
  }

  return hasValue(narrativeNode) ? narrativeNode : null
}

const normalizeAdaptationMapping = (value: unknown): CreativeBriefAdaptationMapping | null => {
  if (!isRecord(value)) {
    return null
  }

  const adaptationMapping: CreativeBriefAdaptationMapping = {
    actionMapping: getNonEmptyString(value.actionMapping),
    dialogueDirectionMap: getNonEmptyString(value.dialogueDirectionMap),
    mechanismMapping: getNonEmptyString(value.mechanismMapping),
    nodeName: getNonEmptyString(value.nodeName),
    sceneMapping: getNonEmptyString(value.sceneMapping),
  }

  return hasValue(adaptationMapping) ? adaptationMapping : null
}

const normalizeAVGuardrails = (value: unknown): CreativeBriefAVGuardrails | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const colorPalette = getStringArray(value.colorPalette)
  const avGuardrails: CreativeBriefAVGuardrails = {
    colorPalette: colorPalette.length > 0 ? colorPalette : undefined,
    interactionBait: getNonEmptyString(value.interactionBait),
    onCameraPersona: getNonEmptyString(value.onCameraPersona),
    soundEngineering: getNonEmptyString(value.soundEngineering),
    visualArtDirection: getNonEmptyString(value.visualArtDirection),
  }

  return hasValue(avGuardrails) ? avGuardrails : undefined
}

const normalizeExecutionRules = (value: unknown): CreativeBriefExecutionRules | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const donts = getStringArray(value.donts)
  const mustHaves = getStringArray(value.mustHaves)
  const executionRules: CreativeBriefExecutionRules = {
    donts: donts.length > 0 ? donts : undefined,
    mustHaves: mustHaves.length > 0 ? mustHaves : undefined,
  }

  return hasValue(executionRules) ? executionRules : undefined
}

export const normalizeCreativeBriefOutput = (value: unknown): CreativeBriefOutput | null => {
  if (!isRecord(value)) {
    return null
  }

  const adaptationMappings = Array.isArray(value.adaptationMappings)
    ? value.adaptationMappings.flatMap((item) => {
        const normalized = normalizeAdaptationMapping(item)

        return normalized ? [normalized] : []
      })
    : []
  const narrativeAdaptation = Array.isArray(value.narrativeAdaptation)
    ? value.narrativeAdaptation.flatMap((item) => {
        const normalized = normalizeNarrativeNode(item)

        return normalized ? [normalized] : []
      })
    : []
  const brief: CreativeBriefOutput = {
    adaptationMappings: adaptationMappings.length > 0 ? adaptationMappings : undefined,
    avGuardrails: normalizeAVGuardrails(value.avGuardrails),
    executionRules: normalizeExecutionRules(value.executionRules),
    formulaAdaptation: normalizeFormulaAdaptation(value.formulaAdaptation),
    narrativeAdaptation: narrativeAdaptation.length > 0 ? narrativeAdaptation : undefined,
    strategicAlignment: normalizeStrategicAlignment(value.strategicAlignment),
  }

  return hasValue(brief) ? brief : null
}
