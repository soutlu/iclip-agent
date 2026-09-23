"""装配层的图片模型注册表：能力声明与适配器出自同一张表，按同一个名字对上。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence

import httpx
import pytest
from procrastinate.testing import InMemoryConnector

from iclip.domains.generation.models import STATUS_COMPLETED
from iclip.domains.generation.module import (
    IMAGE_MODEL_SPECS,
    GenerationModule,
    ImageModelConfig,
    build_generation_module,
)
from iclip.domains.generation.video import VideoProviderSettings
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from tests.helpers.generation import (
    InMemoryGenerationRepository,
    MemoryObjectStore,
    image_request,
)
from tests.helpers.identity import InMemoryUserRepository

GATEWAY = "https://image.test"

COMMON_KEYS = {"data_id", "user_name", "prompt", "task_source", "env"}
"""各家 payload 共有的键，由网关 provider 统一填。"""

OWN_KEYS = {
    "nano_banana_pro": {"aspect_ratio", "resolution", "channel"},
    "seedream_v5_pro": {"size", "output_format"},
}
"""各家专有的键。表的键也钉住了落库的 provider 名：改名等于丢掉历史对账。"""

PRINCIPAL = Principal(
    kind="user",
    user_id=uuid.uuid4(),
    permissions=frozenset({"generation:submit"}),
    audit_label="tester",
    username="tester",
)


async def _keep_completion(_conversation_id: uuid.UUID, _owner: uuid.UUID) -> None:
    return None


def build(
    repo: InMemoryGenerationRepository,
    *,
    names: Sequence[str],
    transport: httpx.AsyncBaseTransport | None = None,
) -> GenerationModule:
    return build_generation_module(
        repo,
        act_as=ActAs(InMemoryUserRepository()),
        clear_completion=_keep_completion,
        video=VideoProviderSettings(
            submit_url="https://video.test/generate",
            status_base_url="https://video.test/tasks",
            api_key="secret-key",
        ),
        video_default_model="moyu-seedance-2-5",
        video_allowed_models=("moyu-seedance-2-5",),
        image_models=[
            ImageModelConfig(name=name, api_base=f"{GATEWAY}/{name}", concurrency=1)
            for name in names
        ],
        image_default_model=names[0],
        image_env="test",
        object_store=MemoryObjectStore(),
        queue_connector=InMemoryConnector(),
        image_transport=transport,
    )


async def test_every_registered_image_model_is_wired_to_its_own_payload() -> None:
    """按名字受理的那家，排进队列后打的是它自己的地址、发的是它自己的键。"""

    sent: dict[str, dict[str, object]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            sent[request.url.path.split("/")[1]] = json.loads(request.content)
            return httpx.Response(200, json={"success": True, "output_str": f"{GATEWAY}/o.png"})
        return httpx.Response(200, content=b"PNG", headers={"content-type": "image/png"})

    repo = InMemoryGenerationRepository()
    module = build(repo, names=list(IMAGE_MODEL_SPECS), transport=httpx.MockTransport(handler))

    _, declared = module.service.image_models()
    assert dict(declared) == IMAGE_MODEL_SPECS, "受理层与能力清单端点照的就是这张表"
    for name, spec in IMAGE_MODEL_SPECS.items():
        job = await module.service.submit_image(
            PRINCIPAL,
            image_request(
                model=name, aspect_ratio=spec.aspect_ratios[0], resolution=spec.resolutions[0]
            ),
        )
        assert job.provider == name
        await module.queue.run_submit(str(job.id))
        assert repo.jobs[job.id].status == STATUS_COMPLETED

    assert {name: set(payload) - COMMON_KEYS for name, payload in sent.items()} == OWN_KEYS
    assert all(set(payload) >= COMMON_KEYS for payload in sent.values())


def test_an_image_model_without_an_adapter_fails_at_assembly() -> None:
    with pytest.raises(RuntimeError, match="没有 flux 这家图片模型的适配器"):
        build(InMemoryGenerationRepository(), names=["flux"])
