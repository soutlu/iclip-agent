# 根级唯一命令入口；新增命令必须加进来，不散落在文档或口头约定里。

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

# 文档核对：Markdown 里的相对链接必须存在，提到的 make 目标必须在本文件里。
docs-check:
	python3 scripts/check-docs.py

# 跨端合同：后端是唯一定义方，导出到 contract/openapi.json；前端据此生成类型与 zod。
# 改了任何对外端点就跑一次 make contract，再去 web 跑 pnpm contract:generate。
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
