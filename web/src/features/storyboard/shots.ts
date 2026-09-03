/**
 * `video_shot.json` 的读法：解析、组名、每组的成片与状态。
 *
 * 键名照 `write_video_shots` 落文件那一份（`aspectRatio` / `shots[].imageUrls`，其余 camelCase），
 * 不是接口合同的一部分——它是工作区里的一份 JSON，形状由交付它的工具定。
 */

import { z } from 'zod'
import type { WorkbenchRef } from '@/shared/workbench'

export const SHOTS_PATH = 'video_shot.json'

const shotSchema = z.object({
  imageUrls: z.array(z.string()),
  index: z.int(),
  prompt: z.string(),
  seconds: z.number(),
})

const shotsDocumentSchema = z.object({
  aspectRatio: z.string(),
  shots: z.array(shotSchema),
})

export type Shot = z.infer<typeof shotSchema>
export type ShotsDocument = z.infer<typeof shotsDocumentSchema>

/**
 * 解析一份 `video_shot.json`。
 *
 * @param content - 文件正文。
 * @returns 解析结果；不是 JSON 或形状对不上时为 null（界面据此显示「文件格式不对」）。
 */
export const parseShotsDocument = (content: string): ShotsDocument | null => {
  const parsed = shotsDocumentSchema.safeParse(
    ((): unknown => {
      try {
        return JSON.parse(content)
      } catch {
        return null
      }
    })(),
  )
  return parsed.success ? parsed.data : null
}

/** 画幅换成 CSS 的写法：`9:16` → `9 / 16`。 */
export const aspectRatioStyle = (aspectRatio: string) => aspectRatio.replace(':', ' / ')

const FRAME_REF = /@Image(\d+)/g

/** 组名只取到第一个句末标点：一句话就是名字，放不下由界面按省略号截，不在这里硬砍字数。 */
const SENTENCE_END = /[。；！？!?;]/

/** `id` 是这一段在原文里的起始位置，渲染时当 key 用——正文可能逐字重复，位置不会。 */
export type PromptSegment =
  { id: string; kind: 'text'; text: string } | { id: string; kind: 'frame'; number: number }

/**
 * 把 prompt 切成正文与帧记号两种段落，`@ImageN` 在界面上画成芯片。
 *
 * @param prompt - 一个镜头组的 prompt 原文。
 * @returns 按原次序排好的段落；换行留在正文里。
 */
export const splitPrompt = (prompt: string): PromptSegment[] => {
  const segments: PromptSegment[] = []
  let cursor = 0
  for (const match of prompt.matchAll(FRAME_REF)) {
    const at = match.index
    if (at > cursor) {
      segments.push({ id: `t${cursor}`, kind: 'text', text: prompt.slice(cursor, at) })
    }
    segments.push({ id: `f${at}`, kind: 'frame', number: Number(match[1]) })
    cursor = at + match[0].length
  }
  if (cursor < prompt.length) {
    segments.push({ id: `t${cursor}`, kind: 'text', text: prompt.slice(cursor) })
  }
  return segments
}

/**
 * 时间线行的头：`[0–3秒｜镜头1]`。
 *
 * 半角 `-` 与全角破折号 `–` 都收——两种写法在模型产出里都出现过，只认一种会把整组时间线读成
 * 一大段。秒数保留小数：切分是 0.5 秒一档的事。
 */
const SCENE_HEADER =
  /^[ \t]*[[【][ \t]*(\d+(?:\.\d+)?)[ \t]*[–-][ \t]*(\d+(?:\.\d+)?)[ \t]*秒?[ \t]*[|｜][ \t]*镜头[ \t]*(\d+)[ \t]*[\]】][ \t]*$/

/** 这一行是不是时间线的头。编辑模型与只读拆分共用同一条判据，两边才不会各认一套。 */
export const isSceneHeader = (line: string): boolean => SCENE_HEADER.test(line)

/**
 * 读出时间线头里的三个数。
 *
 * @param line - 一行原文。
 * @returns 起止秒与镜头号；不是头就是 undefined。
 */
export const parseSceneHeader = (
  line: string,
): { startSeconds: number; endSeconds: number; scene: number } | undefined => {
  const header = SCENE_HEADER.exec(line)
  if (header === null) return undefined
  return {
    endSeconds: Number(header[2]),
    scene: Number(header[3]),
    startSeconds: Number(header[1]),
  }
}

export interface ShotScene {
  /** 渲染时当 key 用：镜头号可能重复（模型写错），行号不会。 */
  id: string
  scene: number
  startSeconds: number
  endSeconds: number
  /** 本镜正文（不含头部那一行）切好的段。 */
  segments: PromptSegment[]
  /** 本镜正文里出现过的帧编号，按出现次序、去重。 */
  frameNumbers: number[]
}

export interface ShotTimeline {
  /** 时间线开始之前的那几行（参考锁定、剪辑形式之类），界面里折叠在顶部。 */
  preamble: string
  scenes: ShotScene[]
}

/**
 * 把一组的 prompt 按时间线行拆成镜头。
 *
 * 一行头 `[起–止秒｜镜头N]` 起一个镜头，到下一行头为止都是它的正文。一行头都没有时整段算
 * 前言、一个镜头都没有——界面据此退回「整段当描述」的画法。
 *
 * @param shot - 一个镜头组。
 * @returns 前言与拆好的镜头。
 */
export const splitShotTimeline = (shot: Shot): ShotTimeline => {
  const preamble: string[] = []
  const scenes: ShotScene[] = []
  let body: string[] = []

  const flush = () => {
    const current = scenes.at(-1)
    if (current === undefined) return
    current.segments = splitPrompt(body.join('\n').trim())
    current.frameNumbers = [
      ...new Set(
        current.segments.flatMap((segment) => (segment.kind === 'frame' ? [segment.number] : [])),
      ),
    ]
  }

  for (const [line, text] of shot.prompt.split('\n').entries()) {
    const header = SCENE_HEADER.exec(text)
    if (header === null) {
      if (scenes.length === 0) preamble.push(text)
      else body.push(text)
      continue
    }
    flush()
    body = []
    scenes.push({
      endSeconds: Number(header[2]),
      frameNumbers: [],
      id: `s${line}`,
      scene: Number(header[3]),
      segments: [],
      startSeconds: Number(header[1]),
    })
  }
  flush()

  return { preamble: preamble.join('\n').trim(), scenes }
}

/**
 * 这一帧属于哪个镜头：第一个正文里写到它的镜头算数。
 *
 * @param timeline - 拆好的时间线。
 * @param frameNumber - 帧编号（`@ImageN` 的 N）。
 * @returns 那个镜头；没有镜头写到它就是 undefined。
 */
export const sceneOfFrame = (timeline: ShotTimeline, frameNumber: number): ShotScene | undefined =>
  timeline.scenes.find((scene) => scene.frameNumbers.includes(frameNumber))

/**
 * 组名：第一个镜头正文的前 12 字，取不出就叫「镜头组 N」。
 *
 * 优先取时间线里第一镜的正文，而不是 prompt 的第一行——第一行往往是「参考锁定：…」这类前言，
 * 拿它当组名每一组看起来都一样。
 *
 * @param shot - 一个镜头组。
 * @returns 组名。
 */
export const shotName = (shot: Shot): string => {
  const timeline = splitShotTimeline(shot)
  const source =
    timeline.scenes[0] === undefined
      ? timeline.preamble
      : timeline.scenes[0].segments
          .flatMap((segment) => (segment.kind === 'text' ? [segment.text] : []))
          .join('')
  const firstLine = source
    .split('\n')
    // 抠掉帧记号后会留下「镜头 ，走到」这样的空格，一并收掉
    .map((line) =>
      line
        .replace(FRAME_REF, '')
        .replace(/\s+([，。；！？、,.;!?])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .find((line) => line.length > 0)
  if (firstLine === undefined || firstLine.length === 0) return `镜头组 ${shot.index}`
  const sentence = firstLine.split(SENTENCE_END)[0]?.trim() ?? ''
  return sentence.length === 0 ? firstLine : sentence
}

/** 这个镜头的第一张帧编号；一张都没写就是 undefined，界面画「无帧」。 */
export const firstFrameOfScene = (scene: ShotScene): number | undefined => scene.frameNumbers[0]

/**
 * 选中一组（或组里的某一帧）时给聊天的那条引用。
 *
 * @param index - 第几组。
 * @param frame - 第几帧（`@ImageN` 的 N）；不传就是整组。
 * @returns 一条引用。
 */
export const shotSelectionRef = (index: number, frame?: number): WorkbenchRef =>
  frame === undefined
    ? { id: `shot:${index}`, label: `镜头组 ${index}`, prefix: `针对镜头组 ${index}：` }
    : {
        id: `shot:${index}:frame:${frame}`,
        label: `镜头组 ${index} · 帧 @${frame}`,
        prefix: `针对镜头组 ${index} 的帧 @${frame}：`,
      }

/** 一次生成任务里这个界面用得上的那几列。 */
export interface ShotGeneration {
  createdAt: string
  kind: string
  outputUrl: string | null
  shotIndex: number | null
  status: string
}

/** 还在飞的那几档：排着、正在提交、已提交给 provider。 */
const IN_FLIGHT = new Set(['pending', 'submitting', 'submitted'])

/** 这条任务还在飞吗。轮询开关、状态圆点、记录卡都按这一把尺子。 */
export const isRunningStatus = (status: string): boolean => IN_FLIGHT.has(status)

/**
 * 每组当前显示哪条视频：按 `shotIndex` 分组，取最新一条完成的。
 *
 * @param jobs - 这段对话的生成任务。
 * @returns 组号到视频地址的表。
 */
export const latestShotVideos = (jobs: readonly ShotGeneration[]): Map<number, string> => {
  const latest = new Map<number, { at: string; url: string }>()
  for (const job of jobs) {
    if (job.kind !== 'video' || job.status !== 'completed') continue
    if (job.shotIndex === null || job.outputUrl === null) continue
    const current = latest.get(job.shotIndex)
    if (current === undefined || current.at < job.createdAt) {
      latest.set(job.shotIndex, { at: job.createdAt, url: job.outputUrl })
    }
  }
  return new Map([...latest].map(([index, take]) => [index, take.url]))
}

/** 还在飞的那几组。 */
export const runningShots = (jobs: readonly ShotGeneration[]): Set<number> =>
  new Set(
    jobs.flatMap((job) =>
      job.kind === 'video' && job.shotIndex !== null && isRunningStatus(job.status)
        ? [job.shotIndex]
        : [],
    ),
  )

export type ShotStatus = 'ready' | 'running' | 'idle'

/**
 * 胶片条上那个状态圆点。出过片优先于在飞：已经有成片可看了。
 *
 * @param index - 第几组。
 * @param videos - 每组当前的成片。
 * @param running - 还在飞的那几组。
 * @returns 圆点档位。
 */
export const shotStatus = (
  index: number,
  videos: ReadonlyMap<number, string>,
  running: ReadonlySet<number>,
): ShotStatus => {
  if (videos.has(index)) return 'ready'
  return running.has(index) ? 'running' : 'idle'
}
