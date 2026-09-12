# ADR-0022：上传不登记：`media_assets` 下线，`assets` 改名 `uploads`

- 状态：已接受（2026-09-12）
- 关联：[ADR-0010](0010-materials-ledger.md)（取舍里「不给 `media_assets` 加对话字段」那句由本文修订：那张表没有了，台账是对话媒体唯一的表）、[ADR-0002](0002-unified-permission-model.md)（权限目录改两个名字，模型不变）
- 合同 [§10 上传](../../contract/conventions.md#10-上传-uploads)重写；[§9 爆款视频](../../contract/conventions.md#9-爆款视频查询-inspirations)权限改名。

## 背景

`media_assets` 记「桶里有什么」：直传后登记一行，发 id、记上传者与 key。合同宣称「`url` 不是身份、key 才是、换域名不迁数据」。可实际上 `video_shot.json`、对话素材台账、生成任务的结果、每一条附件存的全是 URL 原文，没有一处按素材 id 引用；`GET /assets*` 在仓库里没有任何调用方，前端从来没用过。登记表守着一条谁都不遵守的性质。

登记步骤里唯一有价值的是那次 HEAD：预签名 PUT 限不住大小，上传完由服务端去桶里核对类型与大小是唯一的守门。

## 决策

### 1. 上传只交回地址

`POST /uploads/sign` 与 `POST /uploads/{uploadId}/confirm` 两步，`confirm` 无状态：按前缀 HEAD 桶里的对象，核类型与大小，返回 `{url, contentType, sizeBytes}`。没有 id、没有 `creatorUserId`、没有 `createdAt`：没存的东西不装样子。`confirm` 可重复调，每次都按桶重新回答。

### 2. 删表、删读口、删转存

`media_assets` 删掉；`GET /assets`、`GET /assets/{id}` 删掉；`POST /assets/import` 删掉——它给「外部地址先转存再登记」用，登记没有了，转存也没有调用方。`domains/assets` 改名 `domains/uploads`，只剩签名与确认，不再依赖数据库。

### 3. 权限改名

`assets:write` → `uploads:write`；`assets:read` → `inspirations:read`，它剩下的唯一使用方是爆款视频查询。角色映射不变（viewer 有 `inspirations:read`，editor 两个都有）。迁移 `0004_uploads_no_registry` 把 `users.direct_permissions` 与 `api_keys.permissions` 里的旧名一起改掉；旧名从权限目录移除，签发 key 或直接授权时给旧名是 `422`。

### 4. 审计进对象元数据

不变量 4 要求 key 行为可审计。上传不落表后，签名时把 `x-oss-meta-uploader=<user_id>`、有 key 时再加 `x-oss-meta-api-key=<api_key_id>` 签进直传请求头，随对象存在桶里；浏览器按合同原样带上这些头。

## 取舍

- **前提**：桶的 CORS 规则必须允许 `x-oss-meta-*` 请求头（AllowedHeader 含它们或 `*`），否则浏览器预检就被拒、直传全断。上线前核对一次，本仓改不到这项配置。
- **接受**：`media_assets` 的存量行随表删除，downgrade 只能重建空表。行里只有上传者、类型、大小、时间，没有任何地方引用。
- **接受**：审计从「查表」变成「看对象元数据」，要对桶做 HEAD 或列举；上传审计不是高频操作。
- **不做**：服务端代理上传，或上传后由服务端复制对象来绕开 CORS。多一跳、多一次拷贝，换来的只是省一条桶配置。
