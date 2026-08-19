import { useMediaQuery } from '@/shared/hooks/useMediaQuery'

/* v15 窗口分级（M3 window size classes）：sm = medium 起点 600、md = expanded 起点 840，
   与 globals.css @theme 的 --breakpoint-sm/md 覆写保持一致；lg 及以上沿用 Tailwind 默认。 */
const BREAKPOINT_QUERIES = {
  sm: '(min-width: 600px)',
  md: '(min-width: 840px)',
  lg: '(min-width: 1024px)',
  xl: '(min-width: 1280px)',
  '2xl': '(min-width: 1536px)',
} as const

export type BreakpointKey = keyof typeof BREAKPOINT_QUERIES

export const useBreakpoint = (breakpoint: BreakpointKey) =>
  useMediaQuery(BREAKPOINT_QUERIES[breakpoint])
