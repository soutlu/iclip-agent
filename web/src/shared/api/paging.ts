/** 一页一页取完再拼起来的共用循环；翻页令牌的形状由调用方决定。 */

/** 一页的结果：这页的条目，加取下一页要带的令牌；没有下一页时为 null。 */
export interface DrainedPage<Item, Token> {
  items: readonly Item[]
  next: Token | null
}

/**
 * 反复调用 `fetchPage` 直到它给出 `next: null`，按页序拼成一个数组。
 *
 * 首次调用传 `undefined`，之后传上一页的 `next`。取消与错误都由 `fetchPage` 决定：
 * 任何一页抛错就整体抛出，不返回已取到的部分。
 */
export const drainPages = async <Item, Token>(
  fetchPage: (token: Token | undefined) => Promise<DrainedPage<Item, Token>>,
): Promise<Item[]> => {
  const items: Item[] = []
  let token: Token | undefined

  for (;;) {
    const page = await fetchPage(token)
    items.push(...page.items)
    if (page.next === null) return items
    token = page.next
  }
}
