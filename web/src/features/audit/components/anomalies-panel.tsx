/** 异常列表：按种类筛，一条一行，说清是谁、哪段对话、越了哪条线。 */

import { Link } from '@tanstack/react-router'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { formatDateTime } from '@/shared/lib/date-time'
import { cn } from '@/shared/lib/utils'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { ListEmpty, ListError, ListPending, LoadMoreFooter } from '@/shared/ui/list-state'
import { ANOMALY_KINDS, ANOMALY_META, type AnomalyTone } from '../anomaly-kinds'
import { useAuditAnomalies, type Anomaly, type AnomalyKind, type AuditScope } from '../audit.api'

type AnomaliesPanelProps = {
  scope: AuditScope
  /** 选中的异常种类，空即全部；由上层持有，好让它按同一份列表去取需求单标题。 */
  kinds: AnomalyKind[]
  onKindsChange: (kinds: AnomalyKind[]) => void
  nameOf: (userName: string) => string | undefined
  taskTitleOf: (taskId: string) => string | undefined
}

const TONE_DOT: Record<AnomalyTone, string> = {
  bad: 'bg-error',
  warn: 'bg-warning',
  info: 'bg-outline',
}

const isKind = (value: string): value is AnomalyKind => value in ANOMALY_META

export function AnomaliesPanel({
  scope,
  kinds,
  onKindsChange,
  nameOf,
  taskTitleOf,
}: AnomaliesPanelProps) {
  const query = useAuditAnomalies(scope, kinds)
  const rows = query.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="flex flex-col gap-4">
      <ChipGroup
        aria-label="异常种类"
        className="flex-wrap gap-1"
        onValueChange={(values: string[]) => onKindsChange(values.filter(isKind))}
        type="multiple"
        value={kinds}
      >
        {ANOMALY_KINDS.map((kind) => (
          <FilterChip key={kind} value={kind}>
            <span
              aria-hidden
              className={cn('size-1.5 rounded-full', TONE_DOT[ANOMALY_META[kind].tone])}
            />
            {ANOMALY_META[kind].label}
          </FilterChip>
        ))}
      </ChipGroup>

      <p className="text-body-sm text-on-surface-variant">
        「交付过慢」与「消耗离群」的门槛按当前筛选范围现算 P90 / P95，范围小时几乎不会报。
      </p>

      {query.isPending ? (
        <ListPending label="正在读取异常" />
      ) : query.isError ? (
        <ListError
          message={errorMessageOf(query.error, '读取异常列表失败')}
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <ListEmpty icon="success">这个范围里没有异常</ListEmpty>
      ) : (
        <section
          aria-label="异常列表"
          className="flex flex-col rounded-lg bg-surface-container-lowest shadow-[var(--shadow-1)]"
        >
          <ul className="flex flex-col">
            {rows.map((anomaly) => (
              <AnomalyRow
                anomaly={anomaly}
                key={`${anomaly.kind}:${anomaly.at}:${anomaly.generationId ?? anomaly.conversationId ?? anomaly.taskId ?? ''}:${anomaly.shot ?? ''}`}
                nameOf={nameOf}
                taskTitleOf={taskTitleOf}
              />
            ))}
          </ul>
          {query.hasNextPage ? (
            <LoadMoreFooter
              isFetching={query.isFetchingNextPage}
              label="显示更多异常"
              onMore={() => void query.fetchNextPage()}
            />
          ) : null}
        </section>
      )}
    </div>
  )
}

type AnomalyRowProps = {
  anomaly: Anomaly
  nameOf: (userName: string) => string | undefined
  taskTitleOf: (taskId: string) => string | undefined
}

function AnomalyRow({ anomaly, nameOf, taskTitleOf }: AnomalyRowProps) {
  const meta = ANOMALY_META[anomaly.kind]
  const person = anomaly.userName === null ? null : (nameOf(anomaly.userName) ?? anomaly.userName)
  const task = anomaly.taskId === null ? null : (taskTitleOf(anomaly.taskId) ?? '需求单')
  return (
    <li className="flex items-start gap-3 border-t-[0.5px] border-border/70 px-5 py-3 first:border-t-0">
      <span aria-hidden className={cn('mt-2 size-2 shrink-0 rounded-full', TONE_DOT[meta.tone])} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-body text-on-surface">
          <span className="font-medium">{meta.label}</span>
          <span className="min-w-0 text-on-surface-variant">{meta.describe(anomaly)}</span>
        </p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-on-surface-variant">
          <time dateTime={anomaly.at}>{formatDateTime(anomaly.at)}</time>
          {person === null ? null : (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{person}</span>
            </>
          )}
          {task === null ? null : (
            <>
              <span aria-hidden>·</span>
              <span className="truncate" title={task}>
                {task}
              </span>
            </>
          )}
        </p>
      </div>
      {anomaly.conversationId === null ? null : (
        <Link
          aria-label="打开这段对话"
          className="grid size-8 shrink-0 ui-state place-items-center rounded-full text-on-surface-variant ui-focus"
          params={{ conversationId: anomaly.conversationId }}
          to="/c/$conversationId"
        >
          <Icon decorative name="next" size="sm" />
        </Link>
      )}
    </li>
  )
}
