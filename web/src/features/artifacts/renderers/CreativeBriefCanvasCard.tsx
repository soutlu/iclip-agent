import { type ReactNode, useState } from 'react'
import { buildPaletteBoardBackground } from '@/features/artifacts/renderers/creative-brief-canvas-card.utils'
import type {
  CreativeBriefAdaptationMapping,
  CreativeBriefNarrativeNode,
  CreativeBriefOutput,
} from '@/features/artifacts/types/creative-brief.types'

interface CreativeBriefCanvasCardProps {
  brief: CreativeBriefOutput
}

interface DetailCardProps {
  label: string
  tone?: 'amber' | 'neutral' | 'sage'
  value?: string
}

interface FieldStackItem {
  label: string
  tone?: 'amber' | 'neutral' | 'sage'
  value?: string
}

interface LongFormCardProps {
  footer?: ReactNode
  eyebrow: string
  title: string
  value?: string
}

interface MappingCardProps {
  index: number
  mapping: CreativeBriefAdaptationMapping
}

interface NarrativeNodeCardProps {
  index: number
  node: CreativeBriefNarrativeNode
}

interface RulePanelProps {
  items: string[]
  title: string
  tone: 'danger' | 'success'
}

interface SegmentedToggleProps {
  onSelect: (value: 'mapping' | 'narrative') => void
  selected: 'mapping' | 'narrative'
}

interface SectionHeaderProps {
  eyebrow: string
  title: string
}

const PALETTE = {
  amber: 'var(--color-brief-amber)',
  amberSoft: 'var(--color-brief-amber-soft)',
  background: 'var(--color-brief-surface)',
  border: 'var(--color-brief-border)',
  danger: 'var(--color-brief-danger)',
  dangerSoft: 'var(--color-brief-danger-soft)',
  sage: 'var(--color-brief-sage)',
  sageSoft: 'var(--color-brief-sage-soft)',
  surface: 'var(--color-brief-surface-bright)',
  surfaceMuted: 'var(--color-brief-surface-muted)',
  textPrimary: 'var(--color-brief-ink)',
  textSecondary: 'var(--color-brief-ink-secondary)',
  textSoft: 'var(--color-brief-ink-soft)',
  white: 'var(--color-brief-board-white)',
} as const

const SERIF_FONT_FAMILY = '"Literata", Georgia, Cambria, "Times New Roman", serif'
const BODY_FONT_FAMILY = '"Google Sans Text", "Google Sans", "Inter", system-ui, sans-serif'

const hasText = (value: string | undefined | null): value is string =>
  typeof value === 'string' && value.trim().length > 0

const createKeyedTextItems = (items: string[]) => {
  const occurrenceCountByText = new Map<string, number>()

  return items.map((item) => {
    const normalizedItem = item.trim()
    const nextCount = (occurrenceCountByText.get(normalizedItem) ?? 0) + 1
    occurrenceCountByText.set(normalizedItem, nextCount)

    return {
      key: `${normalizedItem}:${nextCount}`,
      text: normalizedItem,
    }
  })
}

const createOccurrenceKeyedItems = <T,>(items: T[], getSignature: (item: T) => string) => {
  const occurrenceCountBySignature = new Map<string, number>()

  return items.map((item) => {
    const signature = getSignature(item).trim() || 'item'
    const nextCount = (occurrenceCountBySignature.get(signature) ?? 0) + 1
    occurrenceCountBySignature.set(signature, nextCount)

    return {
      item,
      key: `${signature}:${nextCount}`,
    }
  })
}

const getToneStyle = (tone: DetailCardProps['tone']) => {
  switch (tone) {
    case 'amber':
      return {
        accentColor: PALETTE.amber,
        backgroundColor: PALETTE.amberSoft,
      }
    case 'sage':
      return {
        accentColor: PALETTE.sage,
        backgroundColor: PALETTE.sageSoft,
      }
    default:
      return {
        accentColor: PALETTE.textPrimary,
        backgroundColor: PALETTE.surfaceMuted,
      }
  }
}

function SectionHeader({ eyebrow, title }: SectionHeaderProps) {
  return (
    <div className="space-y-2.5">
      <p
        className="text-caption font-semibold tracking-[0.22em] uppercase"
        style={{ color: PALETTE.sage, fontFamily: BODY_FONT_FAMILY }}
      >
        {eyebrow}
      </p>
      <h2
        className="text-headline-lg leading-[1.05] font-semibold tracking-[-0.04em]"
        style={{ color: PALETTE.textPrimary, fontFamily: SERIF_FONT_FAMILY }}
      >
        {title}
      </h2>
    </div>
  )
}

function DetailCard({ label, tone = 'neutral', value }: DetailCardProps) {
  if (!hasText(value)) {
    return null
  }

  const toneStyle = getToneStyle(tone)

  return (
    <div
      className="rounded-xl border p-4"
      style={{
        backgroundColor: toneStyle.backgroundColor,
        borderColor: PALETTE.border,
      }}
    >
      <p
        className="mb-2 text-caption font-semibold tracking-[0.16em] uppercase"
        style={{ color: toneStyle.accentColor, fontFamily: BODY_FONT_FAMILY }}
      >
        {label}
      </p>
      <p className="text-body leading-6" style={{ color: PALETTE.textPrimary }}>
        {value}
      </p>
    </div>
  )
}

function FieldStack({ items }: { items: FieldStackItem[] }) {
  const resolvedItems = items.filter((item): item is FieldStackItem & { value: string } =>
    hasText(item.value),
  )

  if (resolvedItems.length === 0) {
    return null
  }

  return (
    <div className="mt-4">
      {resolvedItems.map((item, index) => {
        const toneStyle = getToneStyle(item.tone)

        return (
          <div
            className={index === 0 ? '' : 'mt-4 border-t pt-4'}
            key={`${item.label}:${item.value}`}
            style={index === 0 ? undefined : { borderColor: PALETTE.border }}
          >
            <p
              className="text-caption font-semibold tracking-[0.16em] uppercase"
              style={{ color: toneStyle.accentColor, fontFamily: BODY_FONT_FAMILY }}
            >
              {item.label}
            </p>
            <p
              className="mt-1.5 text-body leading-6 whitespace-pre-wrap"
              style={{ color: PALETTE.textPrimary }}
            >
              {item.value}
            </p>
          </div>
        )
      })}
    </div>
  )
}

function LongFormCard({ eyebrow, footer, title, value }: LongFormCardProps) {
  if (!hasText(value) && !footer) {
    return null
  }

  return (
    <div
      className="rounded-xl border p-5"
      style={{
        backgroundColor: PALETTE.surface,
        borderColor: PALETTE.border,
      }}
    >
      <p
        className="text-caption font-semibold tracking-[0.16em] uppercase"
        style={{ color: PALETTE.sage, fontFamily: BODY_FONT_FAMILY }}
      >
        {eyebrow}
      </p>
      <h3
        className="mt-2 text-canvas-body leading-tight font-semibold"
        style={{ color: PALETTE.textPrimary, fontFamily: SERIF_FONT_FAMILY }}
      >
        {title}
      </h3>
      {hasText(value) ? (
        <p
          className="mt-3 text-body leading-6 whitespace-pre-wrap"
          style={{ color: PALETTE.textSecondary }}
        >
          {value}
        </p>
      ) : null}
      {footer ? (
        <div className="mt-4 border-t pt-4" style={{ borderColor: PALETTE.border }}>
          {footer}
        </div>
      ) : null}
    </div>
  )
}

function NarrativeNodeCard({ index, node }: NarrativeNodeCardProps) {
  const metaLine = [
    hasText(node.duration) ? `时长 ${node.duration}` : null,
    hasText(node.recommendedShot) ? `推荐运镜 ${node.recommendedShot}` : null,
  ]
    .filter((item): item is string => hasText(item))
    .join(' · ')

  return (
    <div
      className="relative overflow-hidden rounded-xl border p-5"
      style={{ backgroundColor: PALETTE.surface, borderColor: PALETTE.border }}
    >
      <span
        className="pointer-events-none absolute top-2 right-4 text-display leading-none font-semibold"
        style={{
          color: 'color-mix(in srgb, var(--color-brief-ink-soft) 12%, transparent)',
          fontFamily: SERIF_FONT_FAMILY,
        }}
      >
        {String(index + 1).padStart(2, '0')}
      </span>

      <div className="layer-local-1 relative space-y-4">
        {hasText(node.nodeName) ? (
          <h3
            className="max-w-[80%] text-canvas-body-lg leading-tight font-semibold"
            style={{ color: PALETTE.textPrimary, fontFamily: SERIF_FONT_FAMILY }}
          >
            {node.nodeName}
          </h3>
        ) : null}

        {hasText(metaLine) ? (
          <p className="text-label font-medium" style={{ color: PALETTE.textSoft }}>
            {metaLine}
          </p>
        ) : null}

        <FieldStack
          items={[
            { label: '新节点功能说明', tone: 'sage', value: node.newNodeFunction },
            { label: '原节点功能', value: node.originalFunction },
            { label: '原版手法', tone: 'amber', value: node.originalTechnique },
            { label: '改编后的手法', tone: 'sage', value: node.adaptedTechnique },
            { label: '拍摄画面构想', value: node.shootingConcept },
            { label: '对白方向', tone: 'amber', value: node.dialogueDirection },
          ]}
        />
      </div>
    </div>
  )
}

function MappingCard({ index, mapping }: MappingCardProps) {
  return (
    <div
      className="rounded-xl border p-5"
      style={{ backgroundColor: PALETTE.surface, borderColor: PALETTE.border }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p
            className="text-caption font-semibold tracking-[0.16em] uppercase"
            style={{ color: PALETTE.textSoft, fontFamily: BODY_FONT_FAMILY }}
          >
            Mapping {String(index + 1).padStart(2, '0')}
          </p>
          {hasText(mapping.nodeName) ? (
            <h3
              className="mt-2 text-canvas-body leading-tight font-semibold"
              style={{ color: PALETTE.textPrimary, fontFamily: SERIF_FONT_FAMILY }}
            >
              {mapping.nodeName}
            </h3>
          ) : null}
        </div>
      </div>

      <FieldStack
        items={[
          { label: '场景映射', tone: 'sage', value: mapping.sceneMapping },
          { label: '动作映射', value: mapping.actionMapping },
          { label: '心理机制映射', tone: 'amber', value: mapping.mechanismMapping },
          { label: '对白映射', value: mapping.dialogueDirectionMap },
        ]}
      />
    </div>
  )
}

function ColorPaletteBoard({ entries }: { entries: string[] }) {
  const background = buildPaletteBoardBackground(entries)

  return (
    <div
      className="overflow-hidden rounded-xl border"
      style={{ backgroundColor: PALETTE.surface, borderColor: PALETTE.border }}
    >
      <div
        className="aspect-[16/3.6] w-full"
        style={{
          background: background,
        }}
      />
    </div>
  )
}

function SegmentedToggle({ onSelect, selected }: SegmentedToggleProps) {
  const items: Array<{ label: string; value: 'mapping' | 'narrative' }> = [
    { label: '逐节点改编蓝图', value: 'narrative' },
    { label: '逐节点替换映射', value: 'mapping' },
  ]

  return (
    <div
      className="inline-flex rounded-full border p-1"
      style={{ backgroundColor: PALETTE.surfaceMuted, borderColor: PALETTE.border }}
    >
      {items.map((item) => {
        const isSelected = item.value === selected

        return (
          <button
            className="nodrag nopan cursor-pointer rounded-full px-4 py-2 text-label font-semibold transition-colors"
            key={item.value}
            onClick={() => onSelect(item.value)}
            style={{
              backgroundColor: isSelected ? PALETTE.sage : 'transparent',
              color: isSelected ? PALETTE.white : PALETTE.textSecondary,
            }}
            type="button"
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

function RulePanel({ items, title, tone }: RulePanelProps) {
  const keyedItems = createKeyedTextItems(items)
  const accentColor = tone === 'success' ? PALETTE.sage : PALETTE.danger
  const accentSoftColor = tone === 'success' ? PALETTE.sageSoft : PALETTE.dangerSoft

  if (keyedItems.length === 0) {
    return null
  }

  return (
    <div
      className="rounded-xl border p-5"
      style={{
        backgroundColor: PALETTE.surface,
        borderColor: PALETTE.border,
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="inline-flex h-8 w-8 items-center justify-center rounded-full"
          style={{ backgroundColor: accentSoftColor, color: accentColor }}
        >
          <span className="text-body font-semibold">{tone === 'success' ? '✓' : '×'}</span>
        </span>
        <h3
          className="text-canvas-body font-semibold"
          style={{ color: accentColor, fontFamily: SERIF_FONT_FAMILY }}
        >
          {title}
        </h3>
      </div>

      <ul className="mt-4 space-y-2.5">
        {keyedItems.map((item) => (
          <li key={item.key} className="flex items-start gap-3">
            <span
              className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: accentColor }}
            />
            <span className="text-body leading-6" style={{ color: PALETTE.textPrimary }}>
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function CreativeBriefCanvasCard({ brief }: CreativeBriefCanvasCardProps) {
  const [adaptationView, setAdaptationView] = useState<'mapping' | 'narrative'>('narrative')
  const narrativeNodes = brief.narrativeAdaptation ?? []
  const adaptationMappings = brief.adaptationMappings ?? []
  const colorPalette = brief.avGuardrails?.colorPalette ?? []
  const mustHaves = brief.executionRules?.mustHaves ?? []
  const donts = brief.executionRules?.donts ?? []
  const hasStrategicSummary =
    hasText(brief.strategicAlignment?.coreClaim) || hasText(brief.strategicAlignment?.stateShift)
  const hasFABTranslation =
    hasText(brief.strategicAlignment?.fabTranslation?.feature) ||
    hasText(brief.strategicAlignment?.fabTranslation?.advantage) ||
    hasText(brief.strategicAlignment?.fabTranslation?.benefit)
  const hasFormulaAdaptation =
    hasText(brief.formulaAdaptation?.hookMatch) || hasText(brief.formulaAdaptation?.proofMatch)
  const hasAdaptationSection = narrativeNodes.length > 0 || adaptationMappings.length > 0
  const hasAVGuardrails =
    hasText(brief.avGuardrails?.onCameraPersona) ||
    hasText(brief.avGuardrails?.visualArtDirection) ||
    hasText(brief.avGuardrails?.soundEngineering) ||
    hasText(brief.avGuardrails?.interactionBait) ||
    colorPalette.length > 0
  const keyedNarrativeNodes = createOccurrenceKeyedItems(narrativeNodes, (node) =>
    [
      node.nodeName,
      node.duration,
      node.newNodeFunction,
      node.adaptedTechnique,
      node.shootingConcept,
    ].join('::'),
  )
  const keyedAdaptationMappings = createOccurrenceKeyedItems(adaptationMappings, (mapping) =>
    [
      mapping.nodeName,
      mapping.sceneMapping,
      mapping.actionMapping,
      mapping.mechanismMapping,
      mapping.dialogueDirectionMap,
    ].join('::'),
  )
  const resolvedAdaptationView =
    adaptationView === 'mapping' && adaptationMappings.length === 0
      ? 'narrative'
      : adaptationView === 'narrative' && narrativeNodes.length === 0
        ? 'mapping'
        : adaptationView

  return (
    <article
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-canvas-card-bg)] text-[color:var(--color-canvas-card-text)]"
      style={{
        fontFamily: BODY_FONT_FAMILY,
      }}
    >
      <div className="canvas-card-accent-glow pointer-events-none absolute inset-x-0 top-0 h-28" />

      <div className="nodrag nopan nowheel thin-scrollbar relative flex min-h-0 w-full flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-6 py-6">
        <header className="flex items-start justify-between gap-5">
          <div className="min-w-0">
            <p className="text-caption font-medium tracking-[0.16em] text-[color:var(--color-on-surface-variant)] uppercase">
              Creative Brief
            </p>
            <h2 className="mt-1 text-canvas-title leading-tight font-medium text-[color:var(--color-canvas-card-text)]">
              创意策略简报
            </h2>
          </div>
        </header>

        {hasStrategicSummary || hasFABTranslation ? (
          <section
            className="border-t border-[var(--color-outline-variant)] pt-5"
            style={{
              borderColor: PALETTE.border,
            }}
          >
            <SectionHeader eyebrow="Strategic Alignment" title="核心战略盘" />

            {hasStrategicSummary ? (
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <DetailCard
                  label="一句话核心主张"
                  tone="sage"
                  value={brief.strategicAlignment?.coreClaim}
                />
                <DetailCard
                  label="用户状态转移"
                  tone="amber"
                  value={brief.strategicAlignment?.stateShift}
                />
              </div>
            ) : null}

            {hasFABTranslation ? (
              <div className="mt-6 space-y-4">
                <SectionHeader eyebrow="FAB Translation" title="FAB 降维翻译" />

                <div className="grid gap-4 xl:grid-cols-3">
                  <DetailCard
                    label="Feature"
                    tone="neutral"
                    value={brief.strategicAlignment?.fabTranslation?.feature}
                  />
                  <DetailCard
                    label="Advantage"
                    tone="sage"
                    value={brief.strategicAlignment?.fabTranslation?.advantage}
                  />
                  <DetailCard
                    label="Benefit"
                    tone="amber"
                    value={brief.strategicAlignment?.fabTranslation?.benefit}
                  />
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {hasFormulaAdaptation ? (
          <section
            className="border-t border-[var(--color-outline-variant)] pt-5"
            style={{ borderColor: PALETTE.border }}
          >
            <SectionHeader eyebrow="Formula Adaptation" title="爆款基因移植策略" />

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <DetailCard
                label="Hook Match"
                tone="sage"
                value={brief.formulaAdaptation?.hookMatch}
              />
              <DetailCard
                label="Proof Match"
                tone="amber"
                value={brief.formulaAdaptation?.proofMatch}
              />
            </div>
          </section>
        ) : null}

        {hasAdaptationSection ? (
          <section
            className="border-t border-[var(--color-outline-variant)] pt-5"
            style={{ borderColor: PALETTE.border }}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <SectionHeader
                eyebrow="Adaptation Blueprint"
                title={
                  resolvedAdaptationView === 'narrative' ? '逐节点叙事改编蓝图' : '逐节点替换映射'
                }
              />
              {narrativeNodes.length > 0 && adaptationMappings.length > 0 ? (
                <SegmentedToggle onSelect={setAdaptationView} selected={resolvedAdaptationView} />
              ) : null}
            </div>

            {resolvedAdaptationView === 'narrative' ? (
              <div className="mt-6 grid gap-4 xl:grid-cols-2">
                {keyedNarrativeNodes.map(({ item, key }, index) => (
                  <NarrativeNodeCard index={index} key={key} node={item} />
                ))}
              </div>
            ) : (
              <div className="mt-6 grid gap-4 xl:grid-cols-2">
                {keyedAdaptationMappings.map(({ item, key }, index) => (
                  <MappingCard index={index} key={key} mapping={item} />
                ))}
              </div>
            )}
          </section>
        ) : null}

        {hasAVGuardrails ? (
          <section
            className="border-t border-[var(--color-outline-variant)] pt-5"
            style={{ borderColor: PALETTE.border }}
          >
            <SectionHeader eyebrow="A/V Guardrails" title="视听包装与网感护栏" />

            <div className="mt-6 grid gap-4 xl:grid-cols-2">
              <LongFormCard
                eyebrow="On Camera Persona"
                footer={
                  colorPalette.length > 0 ? <ColorPaletteBoard entries={colorPalette} /> : undefined
                }
                title="出镜人设定"
                value={brief.avGuardrails?.onCameraPersona}
              />
              <LongFormCard
                eyebrow="Visual Art Direction"
                title="视觉美术基调"
                value={brief.avGuardrails?.visualArtDirection}
              />
              <LongFormCard
                eyebrow="Sound Engineering"
                title="声音工程规范"
                value={brief.avGuardrails?.soundEngineering}
              />
              <LongFormCard
                eyebrow="Interaction Bait"
                title="互动槽点预埋"
                value={brief.avGuardrails?.interactionBait}
              />
            </div>
          </section>
        ) : null}

        {mustHaves.length > 0 || donts.length > 0 ? (
          <section
            className="border-t border-[var(--color-outline-variant)] pt-5"
            style={{ borderColor: PALETTE.border }}
          >
            <SectionHeader eyebrow="Execution Rules" title="执行铁律" />

            <div className="mt-6 grid gap-4 xl:grid-cols-2">
              <RulePanel items={mustHaves} title="必须包含" tone="success" />
              <RulePanel items={donts} title="绝对禁止" tone="danger" />
            </div>
          </section>
        ) : null}
      </div>
    </article>
  )
}
