/** mock 列表的排序、游标翻页与建立时刻；对话、合集、需求单和审计报表共用，口径同合同 §3。 */

/** 排序键：时刻加一个唯一的尾键；游标就是上一页末行的「时刻|尾键」。 */
export type SortKey = readonly [at: string, tail: string]

/** 倒序比较：时刻按时间值比（夹具里 `…:00Z` 与 `…:00.000Z` 混用），同一时刻按尾键原样比。 */
const newestFirst = ([atA, tailA]: SortKey, [atB, tailB]: SortKey) =>
  Date.parse(atB) - Date.parse(atA) || (tailB > tailA ? 1 : tailB < tailA ? -1 : 0)

const createdKey = (row: { createdAt: string; id: string }): SortKey => [row.createdAt, row.id]

/** 建立时间倒序、同一时刻按 id 倒序；不翻页的列表直接拿它排序。 */
export const byCreatedDesc = (
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
) => newestFirst(createdKey(a), createdKey(b))

/**
 * 按排序键倒序切一页：只取排在游标之后的行，与后端的 keyset 翻页同一口径，游标那一行被删了也续得上。
 * 满页就给下一页游标，最后一页恰好满额时下一页为空。
 */
export const pageBy = <T>(
  rows: readonly T[],
  keyOf: (row: T) => SortKey,
  cursor: string | null,
  limit: number,
) => {
  const sorted = [...rows].sort((a, b) => newestFirst(keyOf(a), keyOf(b)))
  const separator = cursor?.indexOf('|') ?? -1
  const rest =
    cursor === null
      ? sorted
      : sorted.filter(
          (row) =>
            newestFirst(keyOf(row), [cursor.slice(0, separator), cursor.slice(separator + 1)]) > 0,
        )
  const items = rest.slice(0, limit)
  const last = items.at(-1)
  return { items, nextCursor: items.length === limit && last ? keyOf(last).join('|') : null }
}

/** 对话、合集与需求单的列表页：排序键是 `createdAt|id`。 */
export const pageByCreated = <T extends { createdAt: string; id: string }>(
  rows: readonly T[],
  cursor: string | null,
  limit: number,
) => pageBy(rows, createdKey, cursor, limit)

let lastCreatedMs = 0

/** 新建行的建立时刻：同一毫秒里连着建也往后错一毫秒，先后次序不落到随机 id 上。 */
export const mockCreatedAt = (): string => {
  lastCreatedMs = Math.max(Date.now(), lastCreatedMs + 1)
  return new Date(lastCreatedMs).toISOString()
}

/** 每例清空，假时钟拨回过去的用例不会接着上一例的时刻往后排。 */
export const resetMockClock = () => {
  lastCreatedMs = 0
}
