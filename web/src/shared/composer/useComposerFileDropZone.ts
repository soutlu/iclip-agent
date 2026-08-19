import type { DragEventHandler } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

interface UseComposerFileDropZoneOptions {
  disabled?: boolean
  onFilesSelected: (files: File[]) => void
}

const hasDragFiles = (types: readonly string[]) => types.includes('Files')

export const useComposerFileDropZone = ({
  disabled = false,
  onFilesSelected,
}: UseComposerFileDropZoneOptions) => {
  const dragDepthRef = useRef(0)
  const [isDragActive, setIsDragActive] = useState(false)

  const resetDragState = useCallback(() => {
    dragDepthRef.current = 0
    setIsDragActive(false)
  }, [])

  useEffect(() => {
    if (!disabled) {
      return
    }

    resetDragState()
  }, [disabled, resetDragState])

  const handleDragEnter = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      if (!hasDragFiles(Array.from(event.dataTransfer.types))) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (disabled) {
        return
      }

      dragDepthRef.current += 1
      setIsDragActive(true)
    },
    [disabled],
  )

  const handleDragOver = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      if (!hasDragFiles(Array.from(event.dataTransfer.types))) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
    },
    [disabled],
  )

  const handleDragLeave = useCallback<DragEventHandler<HTMLDivElement>>((event) => {
    if (dragDepthRef.current === 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

    if (dragDepthRef.current === 0) {
      setIsDragActive(false)
    }
  }, [])

  const handleDropCapture = useCallback<DragEventHandler<HTMLDivElement>>(() => {
    resetDragState()
  }, [resetDragState])

  const handleDrop = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      resetDragState()

      if (!hasDragFiles(Array.from(event.dataTransfer.types))) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (disabled) {
        return
      }

      const files = Array.from(event.dataTransfer.files)
      if (files.length === 0) {
        return
      }

      onFilesSelected(files)
    },
    [disabled, onFilesSelected, resetDragState],
  )

  return {
    isDragActive: disabled ? false : isDragActive,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
    onDropCapture: handleDropCapture,
  }
}
