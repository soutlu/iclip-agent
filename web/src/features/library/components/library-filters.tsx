/** 资料库的筛选条：全部 / 我出的、按人、时间、竖版 / 横版。人的候选是名下有卡的归属用户名。 */

import { dateRangeLabel } from '@/shared/lib/date-range'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { DateRangeFilter, FilterBarRoot, PickerFilter, useFilterBar } from '@/shared/ui/filter-bar'
import type { PickerSource } from '@/shared/ui/search-picker'
import { isDefaultScope, type LibraryScope, type Orientation } from '../library.api'

type LibraryFiltersProps = {
  scope: LibraryScope
  onChange: (next: LibraryScope) => void
  /** 当前登录账号的用户名；没有用户名的账号不显示「我出的」。 */
  myUserName: string | null
  authors: PickerSource
  /** 右侧的计数，如「共 286 条」。 */
  trailing?: React.ReactNode
}

const orientationOf = (value: string): Orientation | null =>
  value === 'portrait' || value === 'landscape' ? value : null

// 弹层触发器照 chip 的外形，与左右两组 chip 排在一条线上。
const TRIGGER_CLASS =
  'h-(--control-height-sm) rounded-full border border-chip-border bg-chip-bg px-3.5 text-body-sm'

/** 组与组之间的竖线；窄屏会折行，折到行首的竖线没有意义，直接不显示。 */
function Divider() {
  return <span aria-hidden className="mx-1 h-4.5 w-px bg-border max-sm:hidden" />
}

export function LibraryFilters(props: LibraryFiltersProps) {
  return (
    <FilterBarRoot className="gap-2">
      <Filters {...props} />
    </FilterBarRoot>
  )
}

function Filters({ scope, onChange, myUserName, authors, trailing }: LibraryFiltersProps) {
  const { close } = useFilterBar()
  const apply = (patch: Partial<LibraryScope>) => {
    close()
    onChange({ ...scope, ...patch })
  }
  const mine = myUserName !== null && scope.userName === myUserName

  return (
    <>
      <ChipGroup
        aria-label="范围"
        onValueChange={(value) => {
          // 「全部」清掉人、时间与画幅，关键词另由搜索框管；再点一次已选的 chip 等于取消。
          if (value === 'all')
            apply({ orientation: null, range: 'all', since: null, until: null, userName: null })
          else if (value === 'mine') apply({ userName: myUserName })
          else if (mine) apply({ userName: null })
        }}
        type="single"
        value={isDefaultScope({ ...scope, q: '' }) ? 'all' : mine ? 'mine' : ''}
      >
        <FilterChip value="all">全部</FilterChip>
        {myUserName === null ? null : <FilterChip value="mine">我出的</FilterChip>}
      </ChipGroup>

      {/* 选了自己就算「我出的」，这里不重复显示。 */}
      <PickerFilter
        className={TRIGGER_CLASS}
        fallbackLabel={scope.userName ?? '人'}
        icon="user"
        id="user"
        noun="人"
        onChange={(userName) => apply({ userName })}
        source={authors}
        value={mine ? null : scope.userName}
        width="w-60"
        withAvatars
      />

      <Divider />

      <DateRangeFilter
        className={TRIGGER_CLASS}
        label={dateRangeLabel(scope)}
        onChange={(range) => apply(range)}
        popupLabel="选择时间范围"
        triggerLabel={`时间：${dateRangeLabel(scope)}`}
        value={scope}
      />

      <Divider />

      <ChipGroup
        aria-label="画幅"
        onValueChange={(value) => apply({ orientation: orientationOf(value) })}
        type="single"
        value={scope.orientation ?? ''}
      >
        <FilterChip value="portrait">竖版</FilterChip>
        <FilterChip value="landscape">横版</FilterChip>
      </ChipGroup>

      {trailing === undefined ? null : (
        <span className="ml-auto pl-2 text-body-sm text-on-surface-faint">{trailing}</span>
      )}
    </>
  )
}
