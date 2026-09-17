/** 各家视频模型不支持哪些画幅。上游没有接口交代这件事，服务端也不管，按模型名认，
 * 与编辑触发同一套做法（见 video-editor/video-editor.api.ts 的 EDIT_TRIGGERS）。
 *
 * 只记已知不支持的：没列到的一律放行，交上游判（ADR-0018）。 */

const UNSUPPORTED: readonly { matches: RegExp; aspectRatios: readonly string[] }[] = [
  // 万相 3.0 不接受 21:9。
  { matches: /wan3/, aspectRatios: ['21:9'] },
]

export const supportsAspectRatio = (model: string, aspectRatio: string): boolean =>
  !UNSUPPORTED.some(
    (entry) => entry.matches.test(model) && entry.aspectRatios.includes(aspectRatio),
  )
