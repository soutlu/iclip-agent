# ADR-0002: 统一权限抽象——权限集合是唯一授权货币

- 状态：已接受（2026-08-19）
- **[ADR-0001](0001-architecture-foundations.md) §4（双主体身份）**：阐述了系统对用户与 API Key 两套身份同等视之的设计初衷。

## 背景

最初的权限体系有两套并行语义：用户按单一角色（如 admin / editor / viewer）推导权限，API Key 按“显式授予集 ∩ 属主当下角色权限”推导权限。两者虽最终落在 `Principal.permissions`，但上游推导规则不同：角色是一种身份等级，而 Key 的权限要在签发与解析两处与属主对齐。这就导致若想做精细化控制（例如仅给某个用户增加一项权限），只能将整级角色提升。

## 决策

**授权的唯一货币是权限集合（`frozenset[str]`）**，将两类主体的有效权限统一计算方式：

```
用户有效权限     = 所分配角色的权限并集 ∪ 直接授权
API key 有效权限 = key 显式授权集
```

- **角色降格为权限集合的命名快捷方式**：代码内预置 `root`（全量计算，新权限自动流入）/ `editor` / `viewer`，无角色管理表、无角色 CRUD。用户持多角色（`users.roles` JSONB）+ 可选直接授权（`users.direct_permissions` JSONB）。
- **签发权是一项普通权限**：新增 `api_keys:issue`，仅 root 角色持有——「API key 只能由 root 签发」不再是特判，而是同一词汇表内的门控。签发时仍校验授予集 ⊆ 签发者当下权限，且 API key 主体不能签发新 key（防套娃）。
- **解析时不再与属主角色求交集**：key 有效权限就是显式授权集。放弃「属主降权 → key 即时降权」（签发已收敛到 root，该路径不复存在）；属主停用、key 吊销/过期仍即时 401。
- **root 引导**：SSO 场景配置 `ICLIP_ROOT_EMAIL`（该邮箱登录即幂等持有 root）；非 SSO 场景走 `scripts/admin.py set-roles`。SSO/PMS 同步只在首次建号写默认角色（editor），此后不触碰 `roles`/`direct_permissions`——授权字段属主是 root，不是身份提供方。
- **自我保护**：users:manage 持有者不能修改自己的授权（roles/直接授权）、不能停用自己。

## 后果

- 下游零改动：`require_permission` 与一切授权检查只消费 `Principal.permissions`，本来就与角色无关。
- wire 契约：`/users/me`、`GET /users`、`PATCH /users/{id}` 暴露 `roles` + `directPermissions`（不再有单值 `role`）。
- 直接改 0001 baseline 迁移（`users.roles` + `users.direct_permissions`），无数据迁移。
