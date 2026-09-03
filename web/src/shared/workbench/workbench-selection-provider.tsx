import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkbenchRef } from './workbench-selection-context'
import { WorkbenchSelectionContext } from './workbench-selection-context'

/** 上一次 set 报的那份选中的签名：同一份又报一次时认得出来。 */
const signature = (refs: readonly WorkbenchRef[]) => refs.map((ref) => ref.id).join('\n')

/**
 * 把当前选中交给子树。
 *
 * @param props - Provider 属性。
 * @param props.children - 子树。
 * @returns Provider。
 */
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
      // 同一份选中又报了一次（重渲、重拉数据）：用户 × 掉的芯片不补回来。
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

  // 只从 refs 里去掉，签名留着：这样自动那一路再报同一份也不会把它补回来。
  const remove = useCallback((id: string) => {
    setState((current) => ({ ...current, refs: current.refs.filter((ref) => ref.id !== id) }))
  }, [])

  const value = useMemo(
    () => ({ clear, focusToken: state.focusToken, refs: state.refs, remove, set }),
    [clear, remove, set, state.focusToken, state.refs],
  )

  return <WorkbenchSelectionContext value={value}>{children}</WorkbenchSelectionContext>
}
