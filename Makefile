# 项目命令入口。

.PHONY: setup dev up lint format format-check typecheck tach test check contract contract-check docs-check db-upgrade test-external web-check hooks

setup:
	cd server && uv sync
	cd web && pnpm install

dev:
	cd server && uv run --env-file ../.env python -m iclip.main --config configs/config.yaml --reload

up:
	bash scripts/dev-up.sh

lint:
	cd server && uv run ruff check .

format:
	cd server && uv run ruff format .

format-check:
	cd server && uv run ruff format --check .

typecheck:
	cd server && uv run pyright

tach:
	cd server && uv run tach check

test:
	cd server && uv run pytest -m "unit or integration_no_llm"

check: lint format-check typecheck tach test contract-check docs-check

# 核对 Markdown 相对链接与 make 目标。
docs-check:
	python3 scripts/check-docs.py

# 导出后运行 web 的 pnpm contract:generate，更新前端类型与 zod schema。
contract:
	cd server && uv run python scripts/dump_openapi.py

contract-check:
	cd server && uv run python scripts/dump_openapi.py --check

db-upgrade:
	cd server && uv run --env-file ../.env alembic upgrade head

test-external:
	cd server && uv run --env-file ../.env pytest -m "integration_llm or e2e_full or external" -v

web-check:
	cd web && pnpm ci:check

hooks:
	cd server && uv run pre-commit install -t pre-commit -t pre-push
