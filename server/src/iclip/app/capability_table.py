"""capability 名字表：``agents.yaml`` 写名字，这里持有实现。

和 ``config.yaml`` 的 ``models`` 段同一个套路——声明面只出现名字，实现由代码持
有，组合根做翻译。

**为什么不写进 agent spec 自己的 ``capabilities:`` 段。** 官方那条路是通的（我们
走的就是 ``Agent.from_spec``，spec 里能声明官方内置能力），但它只传得进 YAML 能
序列化的值，而这里的能力握着数据库连接池。官方自己也止步于此：它的 ``Memory``
在 spec 里只给内存/文件/sqlite 三种后端，明明有 Postgres 的实现却不给选，就是因
为连接池长不出来。所以需要运行期对象的能力走这张表。

表放在组合根而不是 ``capabilities/``，是因为能力里的工具迟早要调 domain 的服务，
而只有这里同时看得见 domains 与 capabilities。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from iclip.capabilities.workspace.capability import workspace_capability
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.capabilities.workspace.store import WorkspaceStore
from iclip.harness.agents import AgentCapabilities

CapabilityTable = Mapping[str, AgentCapabilities]
"""名字 → 这个名字挂上去的那几件能力。

值是元组而不是单件，因为一个名字挂多件是真实存在的形状（skill 库就是「按需加载
的指令 + 读 references 的工具」两件）。同一个实例被多个 agent 共用是安全的：
capability 的 ``for_run`` 每次运行克隆一份，运行期状态不落在共享实例上。
"""


def build_capability_table(*, workspace_store: WorkspaceStore) -> CapabilityTable:
    """建立名字表。落地一个能力就在这里登记一个名字。"""

    return {
        "workspace": (workspace_capability(store=workspace_store, namespace=workspace_namespace),),
    }


def resolve_capabilities(
    names: Sequence[str], *, table: CapabilityTable, declared_by: str
) -> AgentCapabilities:
    """按名字取能力；名字没登记即报错（装配期 fail fast）。"""

    resolved: AgentCapabilities = ()
    for name in names:
        found = table.get(name)
        if found is None:
            known = ", ".join(table) or "（还没有登记任何 capability）"
            raise RuntimeError(
                f"{declared_by} 引用了未登记的 capability {name!r}；已登记的有: {known}"
            )
        resolved = (*resolved, *found)
    return resolved


__all__ = ["CapabilityTable", "build_capability_table", "resolve_capabilities"]
