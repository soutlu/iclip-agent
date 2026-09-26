"""埋点用例层：发起人只取主体。不连库。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from iclip.domains.identity.public import Principal
from iclip.domains.tracking.models import VIDEO_DOWNLOADED, TrackingEvent
from iclip.domains.tracking.schemas import TrackingEventIn
from iclip.domains.tracking.service import TrackingService

USER = uuid.uuid4()
KEY = uuid.uuid4()


def principal(*, api_key_id: uuid.UUID | None = None) -> Principal:
    return Principal(
        kind="user" if api_key_id is None else "api_key",
        user_id=USER,
        permissions=frozenset({"generation:read"}),
        audit_label="someone",
        api_key_id=api_key_id,
    )


@dataclass
class FakeRepository:
    downloadable_ids: set[uuid.UUID] = field(default_factory=set)
    recorded: list[TrackingEvent] = field(default_factory=list)

    async def downloadable(self, job_id: uuid.UUID) -> bool:
        return job_id in self.downloadable_ids

    async def record(self, event: TrackingEvent) -> None:
        self.recorded.append(event)


async def test_a_download_is_recorded_under_the_principal() -> None:
    job_id = uuid.uuid4()
    repository = FakeRepository({job_id})

    await TrackingService(repository).record(
        principal(api_key_id=KEY), TrackingEventIn(name=VIDEO_DOWNLOADED, job_id=job_id)
    )

    assert repository.recorded == [
        TrackingEvent(
            name=VIDEO_DOWNLOADED,
            job_id=job_id,
            conversation_id=None,
            user_id=USER,
            api_key_id=KEY,
        )
    ]
