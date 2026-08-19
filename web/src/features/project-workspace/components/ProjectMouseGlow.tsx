import { useEffect, useEffectEvent } from 'react'
import { useProjectCanvasStore } from '@/features/project-canvas'

const WHEEL_LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: false }

/**
 * 项目页专用画布交互包装器。
 * - 拦截浏览器原生缩放（⌘+/⌘-、Ctrl+滚轮、触控板缩放），路由到画布 zoom
 */
export default function ProjectMouseGlow() {
  const zoomIn = useProjectCanvasStore((s) => s.zoomIn)
  const zoomOut = useProjectCanvasStore((s) => s.zoomOut)
  const selectedNodeId = useProjectCanvasStore((s) => s.selectedNodeId)
  const flashHighlights = useProjectCanvasStore((s) => s.flashHighlights)

  const handleWheel = useEffectEvent((e: WheelEvent) => {
    // Ctrl/Meta + 滚轮 = 缩放（拦截浏览器原生缩放 & 触控板捏合）
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      if (e.deltaY < 0) {
        zoomIn()
      } else if (e.deltaY > 0) {
        zoomOut()
      }
      return
    }
  })

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    // 如果焦点在输入框内，不拦截
    const target = e.target as HTMLElement
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) {
      return
    }

    // ⌘+/⌘= → 画布放大（拦截浏览器原生缩放）
    if ((e.metaKey || e.ctrlKey) && (e.key === '+' || e.key === '=')) {
      e.preventDefault()
      zoomIn()
      return
    }

    // ⌘- → 画布缩小（拦截浏览器原生缩放）
    if ((e.metaKey || e.ctrlKey) && e.key === '-') {
      e.preventDefault()
      zoomOut()
      return
    }

    // ⌘0 → 拦截浏览器重置缩放
    if ((e.metaKey || e.ctrlKey) && e.key === '0') {
      e.preventDefault()
      return
    }

    // H → 闪烁高亮当前选中节点（不改变 selection）
    if (e.key === 'h' || e.key === 'H') {
      e.preventDefault()
      if (selectedNodeId) {
        flashHighlights([selectedNodeId])
      }
      return
    }
  })

  useEffect(() => {
    window.addEventListener('wheel', handleWheel, WHEEL_LISTENER_OPTIONS)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('wheel', handleWheel, WHEEL_LISTENER_OPTIONS)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  return null
}
