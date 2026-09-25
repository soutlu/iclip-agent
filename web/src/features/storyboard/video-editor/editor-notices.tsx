import { InlineAlert } from '@/shared/ui/inline-alert'

type Props = {
  /** 当前这一版不足最短选段长度。 */
  tooShort: boolean
  /** 正在看某条编辑预览时它的名字；看着版本时为空。 */
  previewing: string | undefined
  modelsError: string | undefined
  onReloadModels: () => void
  chainError: string | undefined
  onReloadChain: () => void
  operationError: string | null
  /** 等着合成，却因为读不到时长按不下去：按钮只会灰着，原因得另外说一句。 */
  composeBlocked: boolean
}

/** 编辑选段面板下方的提示与错误，按事实逐条列出，互不覆盖。 */
export function EditorNotices({
  tooShort,
  previewing,
  modelsError,
  onReloadModels,
  chainError,
  onReloadChain,
  operationError,
  composeBlocked,
}: Props) {
  return (
    <>
      {tooShort ? (
        <p className="video-editor-muted" role="status">
          视频不足 1 秒，无法选择编辑片段。
        </p>
      ) : null}
      {previewing === undefined ? null : (
        <p className="video-editor-muted">
          正在看的是 {previewing} 的预览；要继续编辑，先切回某一版。
        </p>
      )}
      {modelsError === undefined ? null : (
        <InlineAlert
          action={{ label: '重新加载模型', onClick: onReloadModels }}
          message={modelsError}
        />
      )}
      {chainError === undefined ? null : (
        <InlineAlert action={{ label: '重试', onClick: onReloadChain }} message={chainError} />
      )}
      {operationError === null ? null : <InlineAlert message={operationError} />}
      {composeBlocked ? (
        <InlineAlert message="读不到编辑结果的时长，无法合成；关掉编辑器重开可再试一次" />
      ) : null}
    </>
  )
}
