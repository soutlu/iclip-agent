/**
 * 需求单字段上限，逐项对应后端 server/src/iclip/domains/tasks/schemas.py 的同名常量；
 * 生成的 zod 带着同样的数但不导出，表单的 maxLength、计数与数量上限从这里取，后端改了跟着改。
 */

/** 需求单名称的字符数。 */
export const MAX_TITLE_CHARS = 200
/** 商品名称、品牌、品类、颜色与视频规格文本的字符数。 */
export const MAX_SHORT_TEXT_CHARS = 200
/** 创作要求的字符数。 */
export const MAX_DESCRIPTION_CHARS = 4000
/** 每组图片（每款商品图、每类参考图）的张数。 */
export const MAX_REFERENCE_URLS = 16
/** 商品款号的字符数。 */
export const MAX_STYLE_NO_CHARS = 64
/** 一张需求单的商品款数。 */
export const MAX_PRODUCTS = 20
/** 目标时长的取值范围（秒），两端都含。 */
export const MIN_DURATION_SECONDS = 3
export const MAX_DURATION_SECONDS = 50
