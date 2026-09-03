/**
 * 选中即上下文：工作台里选中的组 / 帧，输入框拿它画引用芯片、发送时拼成一行前缀（ADR-0009 决策 6）。
 *
 * 住在 shared/ 是因为两头各在一个 feature——工作台在 `features/storyboard`、输入框在
 * `features/conversations`，两个 feature 互不 import，只经这份上下文见面。
 */

import { createContext } from 'react'

/** 一条引用：`id` 用来认领同一份选中，`label` 画在芯片上，`prefix` 发送时拼在正文前面。 */
export interface WorkbenchRef {
  id: string
  label: string
  prefix: string
}

export interface WorkbenchSelection {
  refs: readonly WorkbenchRef[]
  /**
   * 换成这几条引用。
   *
   * `focus` 表示这是用户的明确动作（点了「在聊天里说」）：连同他删过芯片这件事一起清掉，
   * 并请输入框聚焦。工作台跟着地址自动报的那一路不带它。
   */
  set: (refs: readonly WorkbenchRef[], options?: { focus?: boolean }) => void
  clear: () => void
  remove: (id: string) => void
  /** 每次带 `focus` 的 set 加一：输入框只看它变没变，不看值。 */
  focusToken: number
}

export const WorkbenchSelectionContext = createContext<WorkbenchSelection | null>(null)
