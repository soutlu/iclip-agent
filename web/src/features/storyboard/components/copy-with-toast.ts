import { copyText } from '@/shared/lib/clipboard'
import { toast } from '@/shared/ui/toast'

/** 复制到剪贴板并用 toast 报结果；提示词与镜头组的复制入口共用。 */
export const copyWithToast = async (text: string, message: string) => {
  try {
    await copyText(text)
    toast(message)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '复制失败')
  }
}
