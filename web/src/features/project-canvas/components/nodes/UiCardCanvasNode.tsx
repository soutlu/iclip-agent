import type { NodeProps } from '@xyflow/react'
import { memo, useCallback } from 'react'
import type {
  UiCardArtifactOutput,
  UiCardKeyValueRow,
  UiCardMetricItem,
  UiCardSection,
} from '@/features/artifacts'
import CanvasNodeFrame from '@/features/project-canvas/components/nodes/CanvasNodeFrame'
import type { UiCardProjectCanvasNode } from '@/features/project-canvas/components/nodes/project-canvas-node.types'
import { useProjectCanvasStore } from '@/features/project-canvas/state/project-canvas-store'

const createStableTextKeys = (items: string[]) => {
  const occurrenceCountByText = new Map<string, number>()

  return items.map((item) => {
    const occurrenceCount = (occurrenceCountByText.get(item) ?? 0) + 1
    occurrenceCountByText.set(item, occurrenceCount)

    return {
      key: `${item}:${occurrenceCount}`,
      text: item,
    }
  })
}

const createStableLabelValueKeys = <T extends UiCardKeyValueRow | UiCardMetricItem>(items: T[]) => {
  const occurrenceCountBySignature = new Map<string, number>()

  return items.map((item) => {
    const signature = `${item.label}:${item.value}`
    const occurrenceCount = (occurrenceCountBySignature.get(signature) ?? 0) + 1
    occurrenceCountBySignature.set(signature, occurrenceCount)

    return {
      item,
      key: `${signature}:${occurrenceCount}`,
    }
  })
}

const createStableSectionKeys = (sections: UiCardSection[]) => {
  const occurrenceCountBySignature = new Map<string, number>()

  return sections.map((section) => {
    let signature: string

    switch (section.type) {
      case 'paragraph':
        signature = `${section.type}:${section.text}`
        break
      case 'keyValue':
        signature = `${section.type}:${section.rows.map((row) => `${row.label}:${row.value}`).join('|')}`
        break
      case 'list':
      case 'tagRow':
        signature = `${section.type}:${section.items.join('|')}`
        break
      case 'metricGrid':
        signature = `${section.type}:${section.items.map((item) => `${item.label}:${item.value}`).join('|')}`
        break
      case 'media':
        signature = `${section.type}:${section.src}:${section.alt}`
        break
      default: {
        const exhaustiveCheck: never = section
        return exhaustiveCheck
      }
    }

    const occurrenceCount = (occurrenceCountBySignature.get(signature) ?? 0) + 1
    occurrenceCountBySignature.set(signature, occurrenceCount)

    return {
      key: `${signature}:${occurrenceCount}`,
      section,
    }
  })
}

function UiCardSectionView({ section }: { section: UiCardSection }) {
  switch (section.type) {
    case 'paragraph':
      return (
        <p className="text-body leading-relaxed text-[var(--color-canvas-card-text)]/78">
          {section.text}
        </p>
      )
    case 'keyValue':
      return (
        <dl className="grid gap-3 sm:grid-cols-2">
          {createStableLabelValueKeys(section.rows).map(({ item, key }) => (
            <div
              key={key}
              className="rounded-xl border border-[var(--color-border)] bg-black/[0.03] px-4 py-3"
            >
              <dt className="text-caption font-medium tracking-[0.16em] text-[var(--color-canvas-label-text)] uppercase">
                {item.label}
              </dt>
              <dd className="mt-2 text-body leading-relaxed text-[var(--color-canvas-card-text)]">
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      )
    case 'list':
      return (
        <ul className="space-y-2 text-body leading-relaxed text-[var(--color-canvas-card-text)]">
          {createStableTextKeys(section.items).map((item) => (
            <li key={item.key} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-canvas-card-border)]"
              />
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      )
    case 'metricGrid':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {createStableLabelValueKeys(section.items).map(({ item, key }) => (
            <div
              key={key}
              className="rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-canvas-card-border)_8%,transparent)] px-4 py-4"
            >
              <p className="text-caption font-medium tracking-[0.16em] text-[var(--color-canvas-label-text)] uppercase">
                {item.label}
              </p>
              <p className="mt-2 text-canvas-title-sm leading-none font-medium text-[var(--color-canvas-card-text)]">
                {item.value}
              </p>
            </div>
          ))}
        </div>
      )
    case 'media':
      return (
        <figure className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-black/[0.04]">
          <div
            aria-hidden="true"
            className="w-full bg-cover bg-center bg-no-repeat"
            style={{
              aspectRatio: section.aspectRatio ?? 16 / 9,
              backgroundImage: `url("${section.src}")`,
            }}
          />
          <figcaption className="px-4 py-3 text-label text-[var(--color-canvas-card-text)]/72">
            {section.alt}
          </figcaption>
        </figure>
      )
    case 'tagRow':
      return (
        <div className="flex flex-wrap gap-2">
          {createStableTextKeys(section.items).map((item) => (
            <span
              key={item.key}
              className="rounded-full border border-[var(--color-border)] bg-black/[0.03] px-3 py-1.5 text-label text-[var(--color-canvas-card-text)]/78"
            >
              {item.text}
            </span>
          ))}
        </div>
      )
    default: {
      const exhaustiveCheck: never = section
      return exhaustiveCheck
    }
  }
}

/**
 * 渲染 UI Card 的完整正文内容。
 *
 * @param props - UI Card 正文属性。
 * @param props.uiCard - 后端归一化后的 UI Card 产物。
 * @returns 可在画布节点和全幅产物视图复用的 UI Card 正文。
 */
export function UiCardCanvasBody({ uiCard }: { uiCard: UiCardArtifactOutput }) {
  return (
    <article className="nodrag nopan nowheel thin-scrollbar h-full min-h-0 w-full overflow-y-auto overscroll-contain px-6 py-6">
      <div className="space-y-5">
        <header className="space-y-3">
          {uiCard.badges && uiCard.badges.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {createStableTextKeys(uiCard.badges).map((badge) => (
                <span
                  key={badge.key}
                  className="rounded-full border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-canvas-card-border)_8%,transparent)] px-3 py-1 text-caption font-medium text-[var(--color-canvas-card-text)]/76"
                >
                  {badge.text}
                </span>
              ))}
            </div>
          ) : null}

          <div className="space-y-1">
            <p className="text-caption font-medium tracking-[0.18em] text-[var(--color-canvas-label-text)] uppercase">
              UI Card
            </p>
            <h2 className="text-canvas-title-lg leading-tight font-medium text-[var(--color-canvas-card-text)]">
              {uiCard.title}
            </h2>
            {uiCard.subtitle ? (
              <p className="text-body leading-relaxed text-[var(--color-canvas-card-text)]/72">
                {uiCard.subtitle}
              </p>
            ) : null}
          </div>
        </header>

        {uiCard.sections.length > 0 ? (
          <div className="space-y-4">
            {createStableSectionKeys(uiCard.sections).map(({ key, section }) => (
              <section
                key={key}
                className="rounded-xl border border-[var(--color-border)] px-5 py-4"
              >
                <UiCardSectionView section={section} />
              </section>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] px-5 py-6 text-body text-[var(--color-canvas-card-text)]/62">
            暂无更多结构化内容。
          </div>
        )}
      </div>
    </article>
  )
}

function UiCardCanvasNode({ id, data, selected }: NodeProps<UiCardProjectCanvasNode>) {
  const registerExportTarget = useProjectCanvasStore((state) => state.registerExportTarget)
  const selectNode = useProjectCanvasStore((state) => state.selectNode)
  const setExportTargetRef = useCallback(
    (element: HTMLDivElement | null) => {
      registerExportTarget(id, element)
    },
    [id, registerExportTarget],
  )

  return (
    <CanvasNodeFrame
      exportRef={setExportTargetRef}
      highlightToken={data.highlightToken}
      isHighlighted={data.isHighlighted}
      onSelect={() => selectNode(id)}
      selected={selected}
      title={data.title}
    >
      <UiCardCanvasBody uiCard={data.uiCard} />
    </CanvasNodeFrame>
  )
}

export default memo(UiCardCanvasNode)
