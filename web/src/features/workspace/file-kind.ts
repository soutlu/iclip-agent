/** 工作区是纯文本存储。渲染器按后缀选，不认识任何具体文件名；后缀说不清时再看内容开头。 */

import type { IconName } from '@/shared/icons'

/** 渲染器族：Markdown 排成文档，JSON 排成树，其余按行显示。 */
export type FileKind = 'markdown' | 'json' | 'text'

export type FileKindInfo = {
  kind: FileKind
  /** 类型字样取自后缀本身（MD、JSON、CSV…），没有后缀就叫文本。 */
  label: string
  icon: IconName
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'json5'])

const ICONS: Record<FileKind, IconName> = { json: 'braces', markdown: 'file', text: 'file' }

const extensionOf = (path: string): string => {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** 没有后缀或后缀陌生的文件，内容以 { 或 [ 开头就按 JSON 试着排。 */
const looksLikeJson = (content: string | undefined): boolean => {
  if (content === undefined) return false
  const head = content.trimStart().charAt(0)
  return head === '{' || head === '['
}

export const fileKindOf = (path: string, content?: string): FileKindInfo => {
  const extension = extensionOf(path)
  const kind: FileKind = MARKDOWN_EXTENSIONS.has(extension)
    ? 'markdown'
    : JSON_EXTENSIONS.has(extension) || (extension === '' && looksLikeJson(content))
      ? 'json'
      : 'text'
  return { icon: ICONS[kind], kind, label: extension === '' ? '文本' : extension.toUpperCase() }
}

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** 根目录文件的目录是空串。 */
export const dirName = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export type FileGroup<T extends { path: string }> = {
  dir: string
  files: T[]
}

/** 根目录在前，其余目录按路径排序；同目录内按文件名排序。 */
export const groupByDirectory = <T extends { path: string }>(
  files: readonly T[],
): FileGroup<T>[] => {
  const groups = new Map<string, T[]>()
  for (const file of files) {
    const dir = dirName(file.path)
    groups.set(dir, [...(groups.get(dir) ?? []), file])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left === '' ? -1 : right === '' ? 1 : left.localeCompare(right)))
    .map(([dir, members]) => ({
      dir,
      files: [...members].sort((left, right) => left.path.localeCompare(right.path)),
    }))
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 当天只给时分，往前的日子带上月日；无效时间给空串。 */
export const formatWhen = (iso: string, now = new Date()): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  return sameDay ? time : `${at.getMonth() + 1}月${at.getDate()}日 ${time}`
}
