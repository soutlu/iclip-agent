import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { ComposerHandle, ComposerSubmission } from '@/shared/ui/composer'
import { Composer } from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'

const LOGIN_DRAFT_KEY = 'cue.home.login-draft'

export type HomeComposerProps = {
  agentPicker?: ReactNode
  attachmentsEnabled?: boolean | undefined
  collectionPicker?: ReactNode
  /** 返回 true 后清空输入；失败提示与登录流程由路由负责。 */
  onSend?: ((submission: ComposerSubmission) => Promise<boolean>) | undefined
  /** 游客发送前仅暂存正文，供整页登录返回后恢复。 */
  preserveForLogin?: boolean | undefined
  sending?: boolean | undefined
}

/** 仅装配输入卡；运行目标、合集、权限与发送流程由路由传入。 */
export function HomeComposer({
  agentPicker,
  attachmentsEnabled = false,
  collectionPicker,
  onSend,
  preserveForLogin = false,
  sending = false,
}: HomeComposerProps) {
  const composerRef = useRef<ComposerHandle>(null)
  const submittingRef = useRef(false)

  useEffect(() => {
    try {
      const text = window.sessionStorage.getItem(LOGIN_DRAFT_KEY)
      if (text === null) return
      composerRef.current?.restore({ media: [], parts: [{ kind: 'text', text }], text })
      window.sessionStorage.removeItem(LOGIN_DRAFT_KEY)
    } catch {
      toast.error('浏览器无法读取或清理登录前的草稿，请检查输入内容')
    }
  }, [])

  const send = async (submission: ComposerSubmission) => {
    if (onSend === undefined || sending || submittingRef.current) return
    if (preserveForLogin) {
      try {
        window.sessionStorage.setItem(LOGIN_DRAFT_KEY, submission.text)
      } catch {
        toast.error('浏览器无法暂存输入，请复制内容后再登录')
        return
      }
    }
    submittingRef.current = true
    try {
      if (await onSend(submission)) {
        composerRef.current?.clear()
        try {
          window.sessionStorage.removeItem(LOGIN_DRAFT_KEY)
        } catch {
          toast.error('消息已发送，但浏览器无法清理登录前的草稿')
        }
      }
    } finally {
      submittingRef.current = false
    }
  }

  return (
    <div>
      <Composer
        attachmentsEnabled={attachmentsEnabled}
        onSubmit={(submission) => {
          void send(submission)
        }}
        ref={composerRef}
        sending={sending}
        trailing={agentPicker}
      />
      {collectionPicker}
    </div>
  )
}
