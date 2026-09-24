import { describe, expect, it } from 'vitest'
import { DEFAULT_LIBRARY_SCOPE, librarySearchParams } from './library.api'

const NOW = new Date('2026-09-23T12:00:00Z')

describe('librarySearchParams', () => {
  it('sends only the page size for the default scope', () => {
    expect(librarySearchParams(DEFAULT_LIBRARY_SCOPE, null, NOW).toString()).toBe('limit=24')
  })

  it('turns the scope into the contract query and keeps the cursor opaque', () => {
    const params = librarySearchParams(
      {
        orientation: 'landscape',
        q: '  滑板 ',
        range: '7d',
        since: null,
        until: null,
        userName: 'Nina.He',
      },
      '2026-09-20T10:00:00+00:00|abc',
      NOW,
    )

    expect(Object.fromEntries(params)).toEqual({
      cursor: '2026-09-20T10:00:00+00:00|abc',
      limit: '24',
      orientation: 'landscape',
      q: '滑板',
      since: '2026-09-16T12:00:00.000Z',
      userName: 'Nina.He',
    })
  })

  it('sends both ends of a custom day range', () => {
    const params = librarySearchParams(
      { ...DEFAULT_LIBRARY_SCOPE, range: 'custom', since: '2026-09-14', until: '2026-09-14' },
      null,
      NOW,
    )

    const since = new Date(params.get('since') ?? '')
    const until = new Date(params.get('until') ?? '')
    expect(until.getTime() - since.getTime()).toBe(24 * 60 * 60_000 - 1)
  })
})
