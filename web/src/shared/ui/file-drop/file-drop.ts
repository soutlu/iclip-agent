/**
 * 本机文件拖放的接管协议，全站只此一份；新增拖放区一律用这里的出口，不自己写 onDrop。
 *
 * 只认本机文件（`dataTransfer.types` 含 `Files`）。页内元素、文字的拖动一概不碰、不 preventDefault，
 * 留给列表重排、编辑器自己处理。
 *
 * - 局部拖放区 {@link useFileDropTarget}：文件的 dragenter / dragover / drop 都 preventDefault，但不 stopPropagation。
 *   preventDefault 让浏览器允许在此落下，同时借 `event.defaultPrevented` 告诉 window 上的兜底接收者「这里已接管」；
 *   保留冒泡是为了让兜底接收者照常计数、收起遮罩。锁定时照样接管，只标成禁止落点。
 * - 拒收面 {@link refuseFileDropProps}（弹窗、灯箱）：同样 preventDefault 并保留冒泡，只是不收文件，
 *   免得落在弹窗上的文件被背后的聊天输入框收走；里面的局部拖放区先接管了的不动。
 * - 兜底接收者 {@link useWindowFileDrop}（聊天输入框）：挂在 window 上，只收没被接管的文件；
 *   自己区域里的 preventDefault（编辑器按落点插入）不算被别处接管。
 *
 * 文件夹没有 MIME、上传签名不收：局部拖放区整批拒收并回调 `onDirectory`，兜底接收者滤掉文件夹收其余的。
 */

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type RefObject,
} from 'react'

const hasDraggedFiles = (event: { dataTransfer: DataTransfer | null }): boolean =>
  event.dataTransfer?.types.includes('Files') === true

const isDirectory = (item: DataTransferItem | undefined): boolean =>
  item?.webkitGetAsEntry?.()?.isDirectory === true

/** 落下的文件去掉文件夹，按原顺序返回。 */
export const filesWithoutDirectories = (dataTransfer: DataTransfer): File[] => {
  const items = [...dataTransfer.items]
  return [...dataTransfer.files].filter((_file, index) => !isDirectory(items[index]))
}

type FileDropTargetOptions = {
  /** 锁定：仍接管文件，但标成禁止落点、不高亮，落下不回调。 */
  blocked: boolean
  /** 落下的本机文件；含文件夹时改调 `onDirectory`。 */
  onFiles: (files: File[]) => void
  /** 落下的内容含文件夹：整批不收，提示由调用方给。 */
  onDirectory: () => void
}

/** 局部拖放区：把 `dragHandlers` 展开到容器上；`dragOver` 表示可落下的文件正悬在区域上方。 */
export const useFileDropTarget = ({ blocked, onFiles, onDirectory }: FileDropTargetOptions) => {
  // 计数吸收子元素之间的 enter / leave，避免落点提示闪烁。
  const depthRef = useRef(0)
  const [over, setOver] = useState(false)
  const claim = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = blocked ? 'none' : 'copy'
  }
  const dragHandlers = {
    onDragEnter: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event)) return
      claim(event)
      depthRef.current += 1
      setOver(true)
    },
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event)) return
      claim(event)
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event)) return
      depthRef.current = Math.max(0, depthRef.current - 1)
      if (depthRef.current === 0) setOver(false)
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event)) return
      event.preventDefault()
      depthRef.current = 0
      setOver(false)
      if (blocked) return
      if ([...event.dataTransfer.items].some((item) => isDirectory(item))) {
        onDirectory()
        return
      }
      onFiles([...event.dataTransfer.files])
    },
  }
  return { dragOver: over && !blocked, dragHandlers }
}

const refuseDraggedFiles = (event: ReactDragEvent<HTMLElement>) => {
  if (!hasDraggedFiles(event) || event.defaultPrevented) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'none'
}

/** 拒收面：展开到弹窗本体与遮罩上，文件落在这里既不收、也不漏给背后的兜底接收者。 */
export const refuseFileDropProps = {
  onDragEnter: refuseDraggedFiles,
  onDragOver: refuseDraggedFiles,
  onDrop: refuseDraggedFiles,
}

type WindowFileDropOptions = {
  /** 为假时不挂监听。 */
  enabled: boolean
  /** 兜底接收者自己的区域；区域里的 preventDefault 不算被别处接管。 */
  ownRef: RefObject<HTMLElement | null>
  /** 没被接管的本机文件，已滤掉文件夹；滤完为空不回调。 */
  onFiles: (files: File[]) => void
}

/** 兜底接收者：挂在 window 上，返回是否该亮出全局落点遮罩。同一页面只该有一个。 */
export const useWindowFileDrop = ({ enabled, ownRef, onFiles }: WindowFileDropOptions): boolean => {
  const [dragOver, setDragOver] = useState(false)
  const receive = useEffectEvent(onFiles)

  useEffect(() => {
    if (!enabled) return
    // window 级计数吸收子元素间的 enter / leave，避免遮罩闪烁。
    let depth = 0
    const claimedElsewhere = (event: DragEvent) =>
      event.defaultPrevented &&
      !(event.target instanceof Node && ownRef.current?.contains(event.target) === true)
    const onDragEnter = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return
      depth += 1
      setDragOver(!claimedElsewhere(event))
      if (!event.defaultPrevented) event.preventDefault()
    }
    const onDragOver = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return
      setDragOver(!claimedElsewhere(event))
      if (!event.defaultPrevented) event.preventDefault() // dragover 不 preventDefault 收不到 drop。
    }
    const onDragLeave = (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragOver(false)
    }
    const onDrop = (event: DragEvent) => {
      depth = 0
      setDragOver(false)
      // 已被接管的不收：局部拖放区、拒收面，以及自己区域里按落点插入的编辑器。
      if (event.defaultPrevented || event.dataTransfer === null || !hasDraggedFiles(event)) return
      event.preventDefault()
      const files = filesWithoutDirectories(event.dataTransfer)
      if (files.length > 0) receive(files)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [enabled, ownRef])

  return dragOver
}
