import { useId, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { Input, Select, Textarea } from '@/shared/ui/field'
import type { Task } from '../tasks.api'
import { TaskMediaField } from './task-media-field'
import { emptyProduct, type TaskFormState, type TaskProduct } from './task-form-state'

type TaskInputs = Task['inputs']
type VideoSpec = TaskInputs['video_spec']

const CONTROL = 'h-(--control-height-sm) min-w-0 rounded-sm border-border px-3 ui-focus-inline'
/** 与合同 inputs.products 的上限一致。 */
const MAX_PRODUCTS = 20
const PRODUCT_ATTRIBUTES: readonly {
  label: string
  placeholder: string
  value: (product: TaskProduct) => string
  patch: (value: string) => Partial<TaskProduct>
}[] = [
  { label: '品牌', placeholder: '输入品牌', value: (p) => p.brand, patch: (brand) => ({ brand }) },
  {
    label: '品类',
    placeholder: '例如 鞋靴',
    value: (p) => p.category,
    patch: (category) => ({ category }),
  },
  {
    label: '颜色',
    placeholder: '例如 黑色',
    value: (p) => p.color_name,
    patch: (color_name) => ({ color_name }),
  },
]
const RATIO_OPTIONS: readonly NonNullable<VideoSpec['aspect_ratio']>[] = [
  '1:1',
  '3:4',
  '4:3',
  '9:16',
  '16:9',
  '21:9',
]
const REFERENCE_FIELDS = [
  { key: 'model', label: '模特参考图' },
  { key: 'outfit', label: '穿搭参考图' },
  { key: 'prop', label: '道具参考图' },
] as const

type TaskFormFieldsProps = {
  editable: (field: string) => boolean
  form: TaskFormState
  onChange: Dispatch<SetStateAction<TaskFormState>>
  onUploadingChange: (field: string, busy: boolean) => void
}

/** 创作内容直接编辑合同 inputs；媒体字段只接收上传完成并登记后的 URL。 */
export function TaskFormFields({
  editable,
  form,
  onChange,
  onUploadingChange,
}: TaskFormFieldsProps) {
  const { inputs } = form
  // 商品没有自己的 id；给每一款配一个本地序号做 key，删中间一款时其余款的图片字段不换挂载点。
  const [productKeys, setProductKeys] = useState(() => inputs.products.map((_, index) => index))
  const productRows = inputs.products.map((product, index) => ({
    key: productKeys[index] ?? index,
    product,
  }))
  const patchInputs = (partial: Partial<TaskInputs>) =>
    onChange((previous) => ({ ...previous, inputs: { ...previous.inputs, ...partial } }))
  const patchVideo = (partial: Partial<VideoSpec>) =>
    onChange((previous) => ({
      ...previous,
      inputs: { ...previous.inputs, video_spec: { ...previous.inputs.video_spec, ...partial } },
    }))
  const patchProducts = (update: (products: readonly TaskProduct[]) => TaskProduct[]) =>
    onChange((previous) => ({
      ...previous,
      inputs: { ...previous.inputs, products: update(previous.inputs.products) },
    }))
  const patchProduct = (index: number, partial: Partial<TaskProduct>) =>
    patchProducts((products) =>
      products.map((product, position) =>
        position === index ? { ...product, ...partial } : product,
      ),
    )
  const addProduct = () => {
    setProductKeys((keys) => [...keys, Math.max(-1, ...keys) + 1])
    patchProducts((products) => [...products, emptyProduct()])
  }
  const removeProduct = (index: number) => {
    setProductKeys((keys) => keys.filter((_, position) => position !== index))
    patchProducts((products) => products.filter((_, position) => position !== index))
  }
  const patchReferences = (key: keyof TaskInputs['reference_image_oss_urls'], urls: string[]) =>
    onChange((previous) => ({
      ...previous,
      inputs: {
        ...previous.inputs,
        reference_image_oss_urls: { ...previous.inputs.reference_image_oss_urls, [key]: urls },
      },
    }))

  return (
    <div className="flex flex-col gap-3">
      <div className="task-form-basics">
        <Field label="需求单名称" required>
          <Input
            aria-label="需求单名称"
            className={CONTROL}
            disabled={!editable('title')}
            maxLength={200}
            required
            placeholder="输入需求单名称"
            onChange={(event) =>
              onChange((previous) => ({ ...previous, title: event.target.value }))
            }
            value={form.title}
          />
        </Field>
        <Field label="截止时间">
          <Input
            aria-label="截止时间"
            className={CONTROL}
            disabled={!editable('deadline')}
            onChange={(event) =>
              onChange((previous) => ({ ...previous, deadline: event.target.value }))
            }
            type="datetime-local"
            value={form.deadline}
          />
        </Field>
      </div>

      <Section title="视频规格">
        <div className="task-form-specs">
          <SuggestedField
            label="发布平台"
            value={inputs.video_spec.platform}
            disabled={!editable('platform')}
            placeholder="选择或输入"
            options={[{ value: 'douyin', label: '抖音' }]}
            onChange={(platform) => patchVideo({ platform })}
          />
          <SuggestedField
            label="视频类型"
            value={inputs.video_spec.video_type}
            disabled={!editable('video_type')}
            placeholder="选择或输入"
            options={[{ value: 'product_showcase', label: '产品展示' }]}
            onChange={(video_type) => patchVideo({ video_type })}
          />
          <SuggestedField
            label="内容类型"
            value={inputs.video_spec.content_type}
            disabled={!editable('content_type')}
            placeholder="选择或输入"
            options={[{ value: 'short_video', label: '短视频' }]}
            onChange={(content_type) => patchVideo({ content_type })}
          />
          <SuggestedField
            label="分辨率"
            value={inputs.video_spec.resolution}
            disabled={!editable('resolution')}
            placeholder="例如 1080p"
            options={[{ value: '1080p', label: '1080p' }]}
            onChange={(resolution) => patchVideo({ resolution })}
          />
          <Field label="比例">
            <Select
              aria-label="比例"
              className={CONTROL}
              disabled={!editable('aspect_ratio')}
              value={inputs.video_spec.aspect_ratio ?? ''}
              onChange={(event) =>
                patchVideo({
                  aspect_ratio: RATIO_OPTIONS.find((ratio) => ratio === event.target.value) ?? null,
                })
              }
            >
              <option value="">未指定</option>
              {RATIO_OPTIONS.map((ratio) => (
                <option key={ratio} value={ratio}>
                  {ratio}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="目标时长（秒）">
            <Input
              aria-label="目标时长（秒）"
              className={CONTROL}
              disabled={!editable('duration_seconds')}
              type="number"
              inputMode="numeric"
              min={3}
              max={50}
              step={1}
              placeholder="3–50 秒"
              value={inputs.video_spec.duration_seconds ?? ''}
              onChange={(event) =>
                patchVideo({
                  duration_seconds: event.target.value === '' ? null : event.target.valueAsNumber,
                })
              }
            />
          </Field>
        </div>
      </Section>

      <Section title="商品信息">
        {productRows.map(({ key, product }, index) => {
          const ordinal = `商品 ${index + 1}`
          return (
            <div
              aria-label={ordinal}
              className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-4"
              key={key}
              role="group"
            >
              <div className="flex h-6 items-center justify-between gap-3">
                <span className="text-body-sm font-medium text-on-surface">{ordinal}</span>
                {editable('products') && inputs.products.length > 1 && (
                  <IconButton
                    label={`移除${ordinal}`}
                    name="delete"
                    onClick={() => removeProduct(index)}
                    size="xs"
                  />
                )}
              </div>
              <div className="task-form-product">
                <Field label="商品款号" required>
                  <Input
                    aria-label={`${ordinal} 款号`}
                    className={CONTROL}
                    disabled={!editable('style_no')}
                    required
                    placeholder="例如 SBPU24001W"
                    maxLength={64}
                    value={product.style_no}
                    onChange={(event) => patchProduct(index, { style_no: event.target.value })}
                  />
                </Field>
                <Field label="商品名称">
                  <Input
                    aria-label={`${ordinal} 名称`}
                    className={CONTROL}
                    disabled={!editable('product')}
                    placeholder="输入商品名称"
                    maxLength={200}
                    value={product.name}
                    onChange={(event) => patchProduct(index, { name: event.target.value })}
                  />
                </Field>
              </div>
              <div className="task-form-product-attributes">
                {PRODUCT_ATTRIBUTES.map((attribute) => (
                  <Field key={attribute.label} label={attribute.label}>
                    <Input
                      aria-label={`${ordinal} ${attribute.label}`}
                      className={CONTROL}
                      disabled={!editable('product')}
                      placeholder={attribute.placeholder}
                      maxLength={200}
                      value={attribute.value(product)}
                      onChange={(event) => patchProduct(index, attribute.patch(event.target.value))}
                    />
                  </Field>
                ))}
              </div>
              <TaskMediaField
                label="商品图片"
                name={`${ordinal} 图片`}
                kind="image"
                value={product.image_oss_urls}
                disabled={!editable('product')}
                maxFiles={16}
                onUploadingChange={(busy) => onUploadingChange(`product-${index}`, busy)}
                onChange={(image_oss_urls) => patchProduct(index, { image_oss_urls })}
              />
            </div>
          )
        })}
        {editable('products') && inputs.products.length < MAX_PRODUCTS && (
          <button
            className="flex h-10 w-full ui-state cursor-pointer items-center justify-center gap-2 rounded-sm border border-dashed border-outline-variant bg-surface text-body-sm text-on-surface-variant ui-focus"
            onClick={addProduct}
            type="button"
          >
            <Icon decorative name="add" size="sm" />
            添加商品
          </button>
        )}
      </Section>

      <Section title="参考素材">
        <div className="task-form-references">
          {REFERENCE_FIELDS.map(({ key, label }) => (
            <TaskMediaField
              key={key}
              compact
              label={label}
              kind="image"
              maxFiles={16}
              value={inputs.reference_image_oss_urls[key]}
              disabled={!editable('references')}
              onUploadingChange={(busy) => onUploadingChange(key, busy)}
              onChange={(urls) => patchReferences(key, urls)}
            />
          ))}
        </div>
        <TaskMediaField
          label="参考视频"
          kind="video"
          maxFiles={1}
          value={inputs.reference_video_oss_url ? [inputs.reference_video_oss_url] : []}
          disabled={!editable('references')}
          onUploadingChange={(busy) => onUploadingChange('video', busy)}
          onChange={(urls) => patchInputs({ reference_video_oss_url: urls[0] ?? null })}
        />
      </Section>

      <Field label="创作要求">
        <Textarea
          aria-label="创作要求"
          className="resize-y rounded-sm border-border ui-focus-inline"
          rows={3}
          disabled={!editable('creative_requirement')}
          maxLength={4000}
          placeholder="描述创作目标、风格偏好、目标受众和输出要求"
          value={inputs.creative_requirement}
          onChange={(event) => patchInputs({ creative_requirement: event.target.value })}
        />
        <span className="self-end text-caption text-on-surface-variant">
          {inputs.creative_requirement.length}/4000
        </span>
      </Field>
    </div>
  )
}

function Field({
  children,
  label,
  required = false,
}: {
  children: ReactNode
  label: string
  required?: boolean
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-body-sm font-medium text-on-surface">
        {label}
        {required && <span className="text-error"> *</span>}
      </span>
      {children}
    </label>
  )
}

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={title}>
      <div className="flex items-center gap-3">
        <h3 className="shrink-0 text-body font-semibold text-on-surface">{title}</h3>
        <span className="h-px flex-1 bg-border" />
      </div>
      {children}
    </section>
  )
}

function SuggestedField({
  label,
  options,
  ...props
}: {
  label: string
  options: readonly { value: string; label: string }[]
  value: string
  disabled: boolean
  placeholder: string
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <Field label={label}>
      <Input
        aria-label={label}
        className={CONTROL}
        disabled={props.disabled}
        list={id}
        maxLength={200}
        placeholder={props.placeholder}
        value={options.find((option) => option.value === props.value)?.label ?? props.value}
        onChange={(event) =>
          props.onChange(
            options.find((option) => option.label === event.target.value)?.value ??
              event.target.value,
          )
        }
      />
      <datalist id={id}>
        {options.map((option) => (
          <option key={option.value} value={option.label}>
            {option.label}
          </option>
        ))}
      </datalist>
    </Field>
  )
}
