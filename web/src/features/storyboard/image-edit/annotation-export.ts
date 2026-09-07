import { annotationVisual } from './annotation-geometry'
import type { ImageAnnotation } from './image-edit-types'

/** Render only after the user explicitly requests an annotated input image. */
export async function exportAnnotatedImage(
  url: string,
  annotations: ImageAnnotation[],
): Promise<File> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.crossOrigin = 'anonymous'
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error('原图无法读取，请检查图片地址是否支持跨域访问'))
    element.src = url
  })
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('原图尺寸无效')
  const scale = Math.min(1, 6000 / image.naturalWidth, 6000 / image.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器不支持导出标注图片')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  // Resolve semantic colors through a real element because CSS variables may refer to other tokens.
  const colorProbe = document.createElement('span')
  colorProbe.style.color = 'var(--color-error)'
  colorProbe.style.backgroundColor = 'var(--color-on-error)'
  colorProbe.style.display = 'none'
  document.body.append(colorProbe)
  const colors = getComputedStyle(colorProbe)
  const stroke = colors.color
  const foreground = colors.backgroundColor
  colorProbe.remove()
  for (const annotation of annotations) {
    const geometry = annotationVisual(annotation, canvas)
    context.strokeStyle = stroke
    context.lineWidth = geometry.strokeWidth
    context.lineJoin = 'round'
    context.lineCap = 'round'
    context.beginPath()
    if (annotation.kind === 'rectangle') {
      context.rect(geometry.left, geometry.top, geometry.width, geometry.height)
    } else if (annotation.kind === 'ellipse') {
      context.ellipse(
        geometry.left + geometry.width / 2,
        geometry.top + geometry.height / 2,
        geometry.width / 2,
        geometry.height / 2,
        0,
        0,
        Math.PI * 2,
      )
    } else {
      geometry.points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      })
    }
    context.stroke()
    if (annotation.kind === 'arrow') {
      context.beginPath()
      geometry.arrow.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      })
      context.stroke()
    }
    context.beginPath()
    context.arc(geometry.label.x, geometry.label.y, geometry.radius, 0, Math.PI * 2)
    context.fillStyle = stroke
    context.fill()
    context.strokeStyle = foreground
    context.lineWidth = geometry.strokeWidth * 0.7
    context.stroke()
    context.fillStyle = foreground
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.font = `600 ${geometry.radius * 1.25}px sans-serif`
    context.fillText(String(annotation.number), geometry.label.x, geometry.label.y)
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((result) => {
        if (result) resolve(result)
        else reject(new Error('标注图片导出失败'))
      }, 'image/png')
    } catch {
      reject(new Error('原图不允许跨域导出，请上传原图后重试'))
    }
  })
  if (blob.size > 16 * 1024 * 1024) throw new Error('标注图片超过 16 MB，请使用更小的原图')
  return new File([blob], 'annotated-frame.png', { type: blob.type })
}
