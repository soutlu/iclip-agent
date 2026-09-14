"""HTTP 错误信封：领域错误与请求校验错误都返回 ``{"detail": "<一句话>"}``。

组合根与各域的 API 测试装同一份，信封不会两边长歪。
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from iclip.common.errors import DomainError
from iclip.platform.http import status_code_for, validation_error_detail


def install_error_handlers(app: FastAPI) -> None:
    """装上两个异常处理器：领域错误按分类映射状态码，请求校验失败一律 422。"""

    @app.exception_handler(DomainError)
    async def _domain_error_handler(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=status_code_for(exc),
            content={"detail": str(exc) or type(exc).__name__},
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """FastAPI 默认给的是每条一项的列表，调用方得自己拆，拆不动就只剩一个状态码。"""

        return JSONResponse(
            status_code=422,
            content={"detail": validation_error_detail(exc.errors())},
        )


__all__ = ["install_error_handlers"]
