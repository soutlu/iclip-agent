import type { Root } from 'mdast'
import type { Plugin } from 'unified'

interface MicromarkDisableExtension {
  disable: {
    null: string[]
  }
}

declare module 'unified' {
  interface Data {
    micromarkExtensions?: MicromarkDisableExtension[]
  }
}

/**
 * 创建禁用指定 micromark construct 的 remark 插件。
 *
 * @param constructs - 需要从解析器中禁用的 construct 名称列表。
 * @returns 向 unified processor data 追加禁用扩展的 remark 插件。
 */
export const remarkDisableConstructs = (constructs: string[]): Plugin<[], Root> => {
  /**
   * 将禁用配置写入当前 processor 的 micromark 扩展列表。
   */
  return function disableRemarkConstructs() {
    const data = this.data()
    const micromarkExtensions = data.micromarkExtensions ?? []

    micromarkExtensions.push({ disable: { null: constructs } })
    data.micromarkExtensions = micromarkExtensions
  }
}
