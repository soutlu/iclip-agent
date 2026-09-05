"""验证产品资料 HTTP 契约、图片 URL 及删除、转存失败和重复数据的过滤。"""

from __future__ import annotations

import uuid

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.integration_no_llm.conftest import register_and_login
from tests.integration_no_llm.products.conftest import IMAGE_BASE_URL

URL = "/products"
STYLE_NO = "SBPU24001W"
STYLE_PDM_ID = 5660


async def seed_style(engine: AsyncEngine, **overrides: object) -> None:
    row = {
        "pdm_entity_id": STYLE_PDM_ID,
        "product_number": STYLE_NO,
        "style_wms": "SDFA2310W-NEW",
        "source_status": "effective",
        "product_category_id": 52,
        "attributes": '{"brand": "1", "dev_year": "24"}',
        "is_active": True,
        "is_source_deleted": False,
        **overrides,
    }
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO pdm_styles (pdm_entity_id, product_number, style_wms,"
                " source_status, product_category_id, attributes, is_active, is_source_deleted)"
                " VALUES (:pdm_entity_id, :product_number, :style_wms, :source_status,"
                " :product_category_id, CAST(:attributes AS json), :is_active, :is_source_deleted)"
            ),
            row,
        )


async def seed_image(
    engine: AsyncEngine,
    *,
    file_id: int,
    object_key: str,
    content_hash: str,
    file_type: int = 17,
    is_current: bool = True,
    status: str = "succeeded",
    is_source_deleted: bool = False,
    business_id: int = STYLE_PDM_ID,
) -> None:
    mapping_id, asset_id = uuid.uuid4(), uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO pdm_file_mappings (id, pdm_entity_id, business_id, file_type,"
                " is_active, is_source_deleted) VALUES (:id, :file_id, :business_id, :file_type,"
                " true, :is_source_deleted)"
            ),
            {
                "id": mapping_id,
                "file_id": file_id,
                "business_id": business_id,
                "file_type": file_type,
                "is_source_deleted": is_source_deleted,
            },
        )
        await conn.execute(
            text(
                "INSERT INTO assets (id, object_key, content_hash, width, height)"
                " VALUES (:id, :object_key, :content_hash, 644, 508)"
            ),
            {"id": asset_id, "object_key": object_key, "content_hash": content_hash},
        )
        await conn.execute(
            text(
                "INSERT INTO pdm_asset_versions (id, pdm_file_mapping_id, asset_id,"
                " is_current, status) VALUES (:id, :mapping_id, :asset_id, :is_current, :status)"
            ),
            {
                "id": uuid.uuid4(),
                "mapping_id": mapping_id,
                "asset_id": asset_id,
                "is_current": is_current,
                "status": status,
            },
        )


async def seed_color(
    engine: AsyncEngine,
    *,
    skc_id: int,
    color_id: int,
    code: str,
    name: str,
    group: str | None = "BL",
    rgb: str | None = "0,0,0",
) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO pdm_skcs (pdm_entity_id, style_pdm_id, color_pdm_id)"
                " VALUES (:skc_id, :style_id, :color_id)"
            ),
            {"skc_id": skc_id, "style_id": STYLE_PDM_ID, "color_id": color_id},
        )
        await conn.execute(
            text(
                "INSERT INTO pdm_colors (pdm_entity_id, color_code, display_name, rgb, attributes)"
                " VALUES (:id, :code, :name, :rgb, CAST(:attributes AS json))"
                " ON CONFLICT (pdm_entity_id) DO NOTHING"
            ),
            {
                "id": color_id,
                "code": code,
                "name": name,
                "rgb": rgb,
                "attributes": f'{{"color_group": "{group}"}}' if group else "{}",
            },
        )


async def test_anonymous_is_rejected(client: httpx.AsyncClient) -> None:
    assert (await client.get(f"{URL}/{STYLE_NO}")).status_code == 401


async def test_unknown_style_is_not_found(client: httpx.AsyncClient) -> None:

    await register_and_login(client)

    assert (await client.get(f"{URL}/{STYLE_NO}")).status_code == 404


async def test_returns_names_images_and_colors(
    client: httpx.AsyncClient, catalog_engine: AsyncEngine
) -> None:
    await register_and_login(client)
    await seed_style(catalog_engine)
    await seed_image(catalog_engine, file_id=1991, object_key="pdm/a.webp", content_hash="h1")
    await seed_color(catalog_engine, skc_id=1, color_id=1927, code="BL02", name="BLACK")

    found = await client.get(f"{URL}/{STYLE_NO}")

    assert found.status_code == 200, found.text
    product = found.json()["product"]
    assert product["brand"] == {"code": "1", "name": "Bruno Marc"}
    assert product["category"] == {"id": 52, "code": "PU", "name": "高跟鞋", "en": "Pumps"}
    assert product["styleWms"] == "SDFA2310W-NEW"
    assert product["combatTeam"] is None
    assert product["colors"] == [
        {
            "code": "BL02",
            "name": "BLACK",
            "group": {"code": "BL", "name": "黑色系"},
            "rgb": "0,0,0",
        }
    ]
    assert product["images"] == [
        {"id": "1991", "url": f"{IMAGE_BASE_URL}pdm/a.webp", "width": 644, "height": 508}
    ]


async def test_style_with_no_images_or_colors_is_still_a_hit(
    client: httpx.AsyncClient, catalog_engine: AsyncEngine
) -> None:

    await register_and_login(client)
    await seed_style(catalog_engine)

    found = await client.get(f"{URL}/{STYLE_NO}")

    assert found.status_code == 200
    assert found.json()["product"]["images"] == []
    assert found.json()["product"]["colors"] == []


async def test_only_current_succeeded_product_images_count(
    client: httpx.AsyncClient, catalog_engine: AsyncEngine
) -> None:

    await register_and_login(client)
    await seed_style(catalog_engine)
    await seed_image(catalog_engine, file_id=1, object_key="ok.webp", content_hash="keep")
    # 两条映射引用同一图片，验证去重。
    await seed_image(catalog_engine, file_id=2, object_key="ok.webp", content_hash="keep")
    await seed_image(
        catalog_engine, file_id=3, object_key="old.webp", content_hash="a", is_current=False
    )
    await seed_image(
        catalog_engine, file_id=4, object_key="bad.webp", content_hash="b", status="failed"
    )
    await seed_image(
        catalog_engine, file_id=5, object_key="gone.webp", content_hash="c", is_source_deleted=True
    )
    await seed_image(
        catalog_engine, file_id=6, object_key="mold.webp", content_hash="d", file_type=1
    )
    await seed_image(
        catalog_engine, file_id=7, object_key="other.webp", content_hash="e", business_id=9999
    )

    found = await client.get(f"{URL}/{STYLE_NO}")

    assert [image["url"] for image in found.json()["product"]["images"]] == [
        f"{IMAGE_BASE_URL}ok.webp"
    ]


async def test_deleted_style_is_invisible(
    client: httpx.AsyncClient, catalog_engine: AsyncEngine
) -> None:

    await register_and_login(client)
    await seed_style(catalog_engine, is_source_deleted=True)

    assert (await client.get(f"{URL}/{STYLE_NO}")).status_code == 404


async def test_unknown_codes_return_null_names(
    client: httpx.AsyncClient, catalog_engine: AsyncEngine
) -> None:

    await register_and_login(client)
    await seed_style(
        catalog_engine,
        product_category_id=99999,
        attributes='{"brand": "999", "dev_year": ""}',
    )

    product = (await client.get(f"{URL}/{STYLE_NO}")).json()["product"]

    assert product["brand"] == {"code": "999", "name": None}
    assert product["category"]["name"] is None
    assert product["devYear"] is None


async def test_same_color_on_several_skcs_appears_once(
    client: httpx.AsyncClient, catalog_engine: AsyncEngine
) -> None:
    await register_and_login(client)
    await seed_style(catalog_engine)
    await seed_color(catalog_engine, skc_id=1, color_id=1927, code="BL02", name="BLACK")
    await seed_color(catalog_engine, skc_id=2, color_id=1927, code="BL02", name="BLACK")

    colors = (await client.get(f"{URL}/{STYLE_NO}")).json()["product"]["colors"]

    assert [color["code"] for color in colors] == ["BL02"]


async def test_products_not_mounted_without_catalog(app_without_catalog: FastAPI) -> None:
    """检查路由表以区分未挂载与资源不存在；二者响应均为 404。"""

    assert app_without_catalog.state.products is None
    assert not [
        route for route in app_without_catalog.routes if getattr(route, "path", "").startswith(URL)
    ]
