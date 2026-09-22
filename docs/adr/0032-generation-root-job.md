# ADR-0032：衍生记录的原作号升为列，便签只剩 `shot` 一个服务端认的键

- 状态：已接受（2026-09-22）
- 修订 [ADR-0020](0020-generation-metadata.md) 决策 1 与 §5（`rootJob` 不再是便签键；服务端认 `metadata.shot`）、[ADR-0027](0027-audit-reports.md)（出片与 `missing_shot` 的判据加上原作号）、[ADR-0028](0028-local-video-clipping.md) §6（链的根是列，不是便签）、[ADR-0029](0029-conversation-fork.md) §3（分叉排除按列判）。
- 迁移 `0013_generation_root_job`；合同 [§11 媒体生成](../../contract/conventions.md#11-媒体生成-generations)、[§12 审计报表](../../contract/conventions.md#12-审计报表-audit)；[CONTEXT.md](../CONTEXT.md) 术语「生成任务」「审计口径」。

## 背景

视频编辑（ADR-0028）把参考片段、编辑结果、成片三条记录串成一条链，链的根是最初那条出片。这层关系此前只存在于前端写进 `metadata` 的 `rootJob` 键里，而服务端有两处业务判断必须知道「这条是不是衍生记录」：审计不能把编辑结果当成一镜的出片或漏标（`reports_pg.py` 的 `missing_shot`），分叉拷贝不能把连不回根的链拷进副本（`infra_sql.py`）。两处都靠读前端起的键名成立，前端改名两处静默失效，测试种子写的是同一个字面量，不会红。

同时 ADR-0020 决策 1、CONTEXT.md 与合同 §11 仍写着「服务端不读便签里的键」，与 ADR-0027 按 `metadata.shot` 数镜、ADR-0029 按 `rootJob` 排除的事实相反。

## 决策

### 1. `generation_jobs` 加一列 `root_job_id`

可空的自引用外键（`fk_generation_jobs_root_job`），配只索引非空行的部分索引。含义只有一句：**这条记录是哪条独立记录的衍生**。空即**独立记录**，非空即**衍生记录**。

衍生记录一律指最初那条出片，不指各自基于的版本：在成片上再改一轮，新的三条仍写根。链因此只有一层，`WHERE root_job_id = A` 就是 A 名下的全部记录，不递归。「这次基于哪一版」仍是前端的备注（`metadata.baseJob`），服务端不关心。

### 2. 受理时核对，三条服务端规则改成看列

`POST /generations/video` 与 `/image` 可选带原作号，`/clips` 必填：本地加工的产物一律是衍生记录。受理时按主体可见范围读那条记录，核对同一段对话且本身是独立记录；任一不满足返回 `422`，不区分不存在与不可见。生成记录的 `conversation_id` 只是标签、不按对话验属主，所以必须先按主体可见范围查，否则能把衍生记录挂到别人的出片上。

- 审计：出片 = `kind = 'video' AND root_job_id IS NULL` 且带数字 `metadata.shot`；`missing_shot` = 独立记录却没带数字 `shot`。衍生记录本来就不带镜号，不是漏标。
- 分叉：`root_job_id IS NOT NULL` 的记录不拷。原来的 `kind != 'clip'` 条件删掉，clip 全是衍生记录，一条规则够。
- 列表：`GET /generations?rootJobId=` 一次筛出整条链，替代此前按 `metadata={"rootJob":…}` 的包含匹配。

### 3. 便签的口径：服务端只认 `shot`

`metadata` 仍是调用方的坐标标签，但不再说「不读键」：服务端认 `shot` 这一个键，写它（替带 `shot_index` 的调用方折进去）也读它（审计按它数镜）。其余键（`frame`、`sourceUrl`、`baseJob`、`editId`、`editStart`、`editEnd`）只有前端读写。`rootJob` 从便签里删掉，前端提交时改传 `rootJobId` 字段。

### 4. 存量照抄

迁移把便签上能对上一条真实记录的 `rootJob` 抄进列，然后从便签里擦掉。对不上号的、原作号指向衍生记录的、没原作号的 clip，任一存在就带 id 报错终止：静默留成独立记录会让它们进审计、进分叉拷贝。降级把列写回便签再删列。

## 取舍

- **接受**：`kind=clip` 的请求少了一种用法（不挂原作号的独立加工）。今天没有这种加工；将来若有，去掉必填即可，不必改表。
- **接受**：发版窗口里还开着旧页面的用户，提交 clip 会因缺 `rootJobId` 得到 `422`，刷新即可；提交编辑结果会落一条没有原作号的 `kind=video`，进一次 `missing_shot`。不留兼容分支。
- **不做**：把 `shot` 也升为列。它是调用方贴的标签，写错只是分镜页找不到格子，不是数据坏了；审计按 JSONB 键读几百行无所谓。
- **不做**：`Edit` 聚合或输入边表。区间、提示词、模型已经在三步各自的 `request` 里，服务端只需要「独立还是衍生」这一个事实；以后配音、抽关键帧、换音轨的成品照样写原作号，原料（上传的地址、别的记录）写在 `request` 里，不建模。
- **不做**：`derived_from` 指直接父记录。成片有两个输入（基底与编辑结果），单亲列表达不了；而服务端从不需要谱系，只需要根。
- **不做**：链查询端点。`rootJobId` 筛选够用，前端按对话列表投影版本（`edit-chain.ts`）的做法不变。
- **不做**：分叉时重映射原作号。沿用 ADR-0029 的排除；列成了真外键之后可以做，今天没有需求。
