export type EditorSegment = Readonly<{
  id: string
  duration: number
  sourceStart: number | null
  sourceEnd: number | null
  changeKind: 'original' | 'modify' | 'extend'
  originVersionId: string
  prompt?: string
}>

export type EditorVersion = Readonly<{
  id: string
  label: string
  parentId: string | null
  segments: readonly EditorSegment[]
}>

export type TimelineSegment = EditorSegment & {
  currentStart: number
  currentEnd: number
}

export type VideoEdit = {
  id: string
  label: string
  kind: 'modify' | 'extend'
  start: number
  end: number
  extension?: number
  prompt: string
}

function freezeVersion(version: EditorVersion): EditorVersion {
  const segments: EditorSegment[] = []
  for (const segment of version.segments) {
    const previous = segments.at(-1)
    if (
      previous &&
      previous.changeKind === segment.changeKind &&
      previous.originVersionId === segment.originVersionId &&
      previous.prompt === segment.prompt &&
      previous.sourceEnd === segment.sourceStart
    ) {
      segments[segments.length - 1] = {
        ...previous,
        duration: previous.duration + segment.duration,
        sourceEnd: segment.sourceEnd,
      }
    } else {
      segments.push(segment)
    }
  }
  return Object.freeze({
    ...version,
    segments: Object.freeze(
      segments.map((segment, index) =>
        Object.freeze({
          id: `${version.id}:segment:${index}`,
          duration: segment.duration,
          sourceStart: segment.sourceStart,
          sourceEnd: segment.sourceEnd,
          changeKind: segment.changeKind,
          originVersionId: segment.originVersionId,
          ...(segment.prompt === undefined ? {} : { prompt: segment.prompt }),
        }),
      ),
    ),
  })
}

export function createOriginalVersion(duration: number): EditorVersion {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError('原片时长必须大于 0')
  }
  return freezeVersion({
    id: 'original',
    label: '原片',
    parentId: null,
    segments: [
      {
        id: 'original:segment:0',
        duration,
        sourceStart: 0,
        sourceEnd: duration,
        changeKind: 'original',
        originVersionId: 'original',
      },
    ],
  })
}

export function durationOf(version: EditorVersion): number {
  return version.segments.reduce((total, segment) => total + segment.duration, 0)
}

/** Project a version onto its playback clock while retaining original-video coordinates. */
export function timelineSegments(version: EditorVersion): TimelineSegment[] {
  let currentStart = 0
  return version.segments.map((segment) => {
    const projected = {
      ...segment,
      currentStart,
      currentEnd: currentStart + segment.duration,
    }
    currentStart = projected.currentEnd
    return projected
  })
}

function sliceSegment(segment: EditorSegment, start: number, end: number): EditorSegment {
  if (segment.sourceStart === null || segment.sourceEnd === null) {
    return { ...segment, duration: end - start, sourceStart: null, sourceEnd: null }
  }
  const sourceDuration = segment.sourceEnd - segment.sourceStart
  return {
    ...segment,
    duration: end - start,
    sourceStart: segment.sourceStart + (start / segment.duration) * sourceDuration,
    sourceEnd: segment.sourceStart + (end / segment.duration) * sourceDuration,
  }
}

function modifySegments(
  parent: EditorVersion,
  edit: VideoEdit,
  start: number,
  end: number,
): EditorSegment[] {
  return timelineSegments(parent).flatMap((segment) => {
    const overlapStart = Math.max(start, segment.currentStart)
    const overlapEnd = Math.min(end, segment.currentEnd)
    if (overlapStart >= overlapEnd) return [segment]

    const parts: EditorSegment[] = []
    if (segment.currentStart < overlapStart) {
      parts.push(sliceSegment(segment, 0, overlapStart - segment.currentStart))
    }
    parts.push({
      ...sliceSegment(
        segment,
        overlapStart - segment.currentStart,
        overlapEnd - segment.currentStart,
      ),
      changeKind: 'modify',
      originVersionId: edit.id,
      prompt: edit.prompt,
    })
    if (overlapEnd < segment.currentEnd) {
      parts.push(sliceSegment(segment, overlapEnd - segment.currentStart, segment.duration))
    }
    return parts
  })
}

/** Apply one local draft edit; range coordinates always refer to the parent version. */
export function applyEdit(parent: EditorVersion, edit: VideoEdit): EditorVersion {
  if (!edit.id.trim() || edit.id === parent.id) {
    throw new RangeError('新版本必须使用独立标识')
  }
  if (!Number.isFinite(edit.start) || !Number.isFinite(edit.end) || edit.start > edit.end) {
    throw new RangeError('片段范围无效')
  }
  const duration = durationOf(parent)
  const start = Math.max(0, Math.min(duration, edit.start))
  const end = Math.max(0, Math.min(duration, edit.end))
  let segments: EditorSegment[]

  if (edit.kind === 'modify') {
    if (start >= end) throw new RangeError('请选择需要修改的片段')
    segments = modifySegments(parent, edit, start, end)
  } else {
    const extension = edit.extension
    if (extension === undefined || !Number.isFinite(extension) || extension < 1 || extension > 10) {
      throw new RangeError('延长时长须为 1–10 秒')
    }
    const before: EditorSegment[] = []
    const after: EditorSegment[] = []
    for (const segment of timelineSegments(parent)) {
      if (segment.currentEnd <= end) before.push(segment)
      else if (segment.currentStart >= end) after.push(segment)
      else {
        const offset = end - segment.currentStart
        before.push(sliceSegment(segment, 0, offset))
        after.push(sliceSegment(segment, offset, segment.duration))
      }
    }
    segments = [
      ...before,
      {
        id: `${edit.id}:extension`,
        duration: extension,
        sourceStart: null,
        sourceEnd: null,
        changeKind: 'extend',
        originVersionId: edit.id,
        prompt: edit.prompt,
      },
      ...after,
    ]
  }

  return freezeVersion({
    id: edit.id,
    label: edit.label,
    parentId: parent.id,
    segments,
  })
}

export function makeDemoVersions(): readonly [EditorVersion, EditorVersion, EditorVersion] {
  const original = createOriginalVersion(15)
  const v2 = applyEdit(original, {
    id: 'v2',
    label: 'V2',
    kind: 'modify',
    start: 4,
    end: 8,
    prompt: '换成浅灰背景，保留鞋款与运镜。',
  })
  const extended = applyEdit(v2, {
    id: 'v3',
    label: 'V3',
    kind: 'extend',
    start: 8,
    end: 8,
    extension: 2,
    prompt: '延续当前镜头，展示鞋底细节。',
  })
  const v3 = freezeVersion({
    ...extended,
    segments: modifySegments(
      extended,
      {
        id: 'v3',
        label: 'V3',
        kind: 'modify',
        start: 13,
        end: 15,
        prompt: '按参考图调整背景和光线，保留鞋款与运镜。',
      },
      13,
      15,
    ),
  })
  return Object.freeze([original, v2, v3])
}
