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
  colorProbe.style.backgroundColor = 'var(--color-on-scrim)'
  colorProbe.style.borderColor = 'var(--color-scrim)'
  colorProbe.style.display = 'none'
  document.body.append(colorProbe)
  const colors = getComputedStyle(colorProbe)
  const stroke = colors.color
  const foreground = colors.backgroundColor
  const labelColor = colors.borderTopColor
  colorProbe.remove()
  // A 480 px short edge is the review scale: larger exports retain the same legible marker proportions.
  const unitsPerPixel = Math.min(canvas.width, canvas.height) / 480
  for (const annotation of annotations) {
    const geometry = annotationVisual(annotation, canvas, unitsPerPixel)
    context.lineJoin = 'round'
    context.lineCap = 'round'
    const outline = (path?: Path2D) => {
      context.strokeStyle = foreground
      context.lineWidth = geometry.strokeWidth + geometry.haloWidth
      if (path) context.stroke(path)
      else context.stroke()
      context.strokeStyle = stroke
      context.lineWidth = geometry.strokeWidth
      if (path) context.stroke(path)
      else context.stroke()
    }
    context.beginPath()
    if (annotation.kind === 'rectangle') {
      context.rect(geometry.left, geometry.top, geometry.width, geometry.height)
      outline()
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
      outline()
    } else if (annotation.kind === 'pen') {
      outline(new Path2D(geometry.penPath))
    } else if (annotation.kind === 'arrow') {
      geometry.points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      })
      outline()
      context.beginPath()
      geometry.arrow.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      })
      outline()
    }
    context.beginPath()
    context.moveTo(geometry.connector.start.x, geometry.connector.start.y)
    context.lineTo(geometry.connector.end.x, geometry.connector.end.y)
    context.strokeStyle = foreground
    context.lineWidth = 2 * unitsPerPixel + geometry.haloWidth
    context.stroke()
    context.strokeStyle = labelColor
    context.lineWidth = 2 * unitsPerPixel
    context.stroke()
    if (annotation.kind === 'point') {
      context.beginPath()
      context.arc(geometry.anchor.x, geometry.anchor.y, geometry.targetRadius, 0, Math.PI * 2)
      outline()
      context.beginPath()
      context.arc(geometry.anchor.x, geometry.anchor.y, geometry.targetDotRadius, 0, Math.PI * 2)
      context.fillStyle = stroke
      context.strokeStyle = foreground
      context.lineWidth = 2 * unitsPerPixel
      context.stroke()
      context.fill()
    }
    context.beginPath()
    context.roundRect(
      geometry.label.x - geometry.label.width / 2,
      geometry.label.y - geometry.label.height / 2,
      geometry.label.width,
      geometry.label.height,
      geometry.label.radius,
    )
    context.fillStyle = labelColor
    context.fill()
    context.strokeStyle = foreground
    context.lineWidth = 1.5 * unitsPerPixel
    context.stroke()
    context.fillStyle = foreground
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.font = `600 ${geometry.label.fontSize}px sans-serif`
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
