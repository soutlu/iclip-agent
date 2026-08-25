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

import uuid
from collections.abc import Mapping, Sequence

import httpx
from pydantic import ValidationError

from iclip.capabilities.shot_video.capability import GenerationPolicy, shot_video_capability
from iclip.capabilities.shot_video.parser import ArkVideoUnderstanding
from iclip.capabilities.shot_video.ports import (
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
    PublicObjectWriter,
)
from iclip.capabilities.workspace.capability import workspace_capability
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.config import ResolvedShotVideo
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal
from iclip.harness.agents import AgentCapabilities
from iclip.platform.file_store.store import FileSpace, FileStore

CapabilityTable = Mapping[str, AgentCapabilities]
"""名字 → 这个名字挂上去的那几件能力。

值是元组而不是单件，因为一个名字挂多件是真实存在的形状（skill 库就是「按需加载
的指令 + 读 references 的工具」两件）。同一个实例被多个 agent 共用是安全的：
capability 的 ``for_run`` 每次运行克隆一份，运行期状态不落在共享实例上。
"""

REQUIRES: Mapping[str, tuple[str, ...]] = {"shot_video": ("workspace",)}
"""挂某个名字就必须一起挂的名字。

``shot_video`` 写的文档与账本要靠 ``workspace`` 的 ``read_file`` / ``edit_file``
让模型看得见、改得动；少挂一个的后果是静默的——文档照写照读，只是模型看不见。
所以在装配期就拦，而不是等模型撞上去。
"""


class GenerationsAdapter:
    """把 generation 域的服务接到能力包的窄协议上。

    翻译只做两件事：拼出生成域那套唯一的请求定义（取值合不合法由它判，这里不再
    写一遍），以及把 job 行收窄成能力包看得懂的几个字段。
    """

    def __init__(self, service: GenerationService) -> None:
        self._service = service

    async def submit(self, principal: Principal, request: ImageRequest) -> ImageJob:
        try:
            # 走 model_validate 而不是构造器：画幅与档位是封闭枚举，模型给的是自
            # 由字符串，判定归生成域那套唯一的请求定义，不在这里再写一遍。
            payload = ImageGenerationIn.model_validate(
                {
                    "prompt": request.prompt,
                    "channel": request.channel,
                    "aspect_ratio": request.aspect_ratio,
                    "resolution": request.resolution,
                    "reference_image_urls": list(request.reference_image_urls),
                }
            )
        except ValidationError as exc:
            raise InvalidImageRequest(_first_problem(exc)) from exc
        return _job_view(await self._service.submit(principal, payload))

    async def get(self, principal: Principal, job_id: uuid.UUID) -> ImageJob:
        return _job_view(await self._service.get(principal, job_id))


def _job_view(job: GenerationJob) -> ImageJob:
    """job 行 → 能力包要的那几个字段。渠道从请求快照上取（那才是这次真用的）。"""

    request = job.request
    return ImageJob(
        job_id=job.id,
        status=job.status,
        channel=request.channel if isinstance(request, ImageGenerationIn) else "dev",
        output_url=job.output_url,
        error_code=job.error_code,
        error_message=job.error_message,
    )


def _first_problem(exc: ValidationError) -> str:
    """挑一条说得清的出来。

    模型一次只改得动一处，把十条校验错误原样甩过去只会让它无从下手。
    """

    first = exc.errors()[0]
    where = ".".join(str(part) for part in first["loc"]) or "参数"
    return f"{where}: {first['msg']}"


def build_capability_table(
    *,
    workspace_store: FileStore,
    generation_service: GenerationService | None = None,
    object_store: PublicObjectWriter | None = None,
    http_client: httpx.AsyncClient | None = None,
    shot_video: ResolvedShotVideo | None = None,
) -> CapabilityTable:
    """建立名字表。落地一个能力就在这里登记一个名字。

    ``shot_video`` 那几个入参要么一起有、要么一起没有：它建立在媒体生成之上（出
    图走生成域，产物落生成用的那个对象存储），配置解析那一步已经保证了这一点。
    没配就是不登记这个名字，而 agent 声明里引用它会在装配期报错——一个带着半套
    工具上线的 agent，症状是「它不干活」，最难查。
    """

    # 往工作区落文件的能力收的是同一个 FileSpace：各接各的话，文档照写照读、
    # 只是模型的 read_file 看不见——失效是静默的。
    space = FileSpace(store=workspace_store, namespace=workspace_namespace)
    table: dict[str, AgentCapabilities] = {
        "workspace": (workspace_capability(space=space),),
    }
    if (
        shot_video is not None
        and generation_service is not None
        and object_store is not None
        and http_client is not None
    ):
        table["shot_video"] = (
            shot_video_capability(
                space=space,
                generations=GenerationsAdapter(generation_service),
                objects=object_store,
                understanding=ArkVideoUnderstanding(
                    http_client,
                    url=shot_video.understanding_url,
                    api_key=shot_video.understanding_api_key,
                    model=shot_video.understanding_model,
                ),
                client=http_client,
                policy=GenerationPolicy(
                    poll_interval_seconds=shot_video.poll_interval_seconds,
                    dev_attempts=shot_video.dev_attempts,
                    pro_attempts=shot_video.pro_attempts,
                    backoff_seconds=shot_video.backoff_seconds,
                    backoff_factor=shot_video.backoff_factor,
                    total_timeout_seconds=shot_video.job_timeout_seconds,
                ),
            ),
        )
    return table


def resolve_capabilities(
    names: Sequence[str], *, table: CapabilityTable, declared_by: str
) -> AgentCapabilities:
    """按名字取能力；名字没登记、或少挂了它要求同挂的名字，即报错（装配期 fail fast）。"""

    resolved: AgentCapabilities = ()
    for name in names:
        found = table.get(name)
        if found is None:
            known = ", ".join(table) or "（还没有登记任何 capability）"
            raise RuntimeError(
                f"{declared_by} 引用了未登记的 capability {name!r}；已登记的有: {known}"
            )
        missing = [required for required in REQUIRES.get(name, ()) if required not in names]
        if missing:
            raise RuntimeError(
                f"{declared_by} 挂了 capability {name!r} 却没挂 {', '.join(map(repr, missing))}——"
                f"{name} 写的文件要靠它们让模型看见；在 agents.yaml 里一起挂上。"
            )
        resolved = (*resolved, *found)
    return resolved


__all__ = [
    "REQUIRES",
    "CapabilityTable",
    "GenerationsAdapter",
    "build_capability_table",
    "resolve_capabilities",
]
