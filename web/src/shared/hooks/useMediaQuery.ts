import { useSyncExternalStore } from 'react'

const getMediaQueryList = (query: string) =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(query)

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mediaQueryList = getMediaQueryList(query)

      if (!mediaQueryList) {
        return () => undefined
      }

      const handleChange = () => {
        onStoreChange()
      }

      mediaQueryList.addEventListener('change', handleChange)

      return () => {
        mediaQueryList.removeEventListener('change', handleChange)
      }
    },
    () => getMediaQueryList(query)?.matches ?? false,
    () => false,
  )
}
