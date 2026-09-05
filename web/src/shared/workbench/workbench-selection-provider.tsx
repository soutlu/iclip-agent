import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkbenchRef } from './workbench-selection-context'
import { WorkbenchSelectionContext } from './workbench-selection-context'

const signature = (refs: readonly WorkbenchRef[]) => refs.map((ref) => ref.id).join('\n')

export function WorkbenchSelectionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({
    focusToken: 0,
    ids: '',
    refs: [] as readonly WorkbenchRef[],
  })

  const set = useCallback((refs: readonly WorkbenchRef[], options?: { focus?: boolean }) => {
    const ids = signature(refs)
    const deliberate = options?.focus === true
    setState((current) => {
      // 同一选中项的自动同步不恢复用户已移除的芯片。
      if (!deliberate && ids === current.ids) return current
      return { focusToken: current.focusToken + (deliberate ? 1 : 0), ids, refs }
    })
  }, [])

  const clear = useCallback(() => {
    setState((current) =>
      current.ids === '' && current.refs.length === 0
        ? current
        : { focusToken: current.focusToken, ids: '', refs: [] },
    )
  }, [])

  // 移除芯片时保留选中签名，防止后续自动同步将其恢复。
  const remove = useCallback((id: string) => {
    setState((current) => ({ ...current, refs: current.refs.filter((ref) => ref.id !== id) }))
  }, [])

  const value = useMemo(
    () => ({ clear, focusToken: state.focusToken, refs: state.refs, remove, set }),
    [clear, remove, set, state.focusToken, state.refs],
  )

  return <WorkbenchSelectionContext value={value}>{children}</WorkbenchSelectionContext>
}
