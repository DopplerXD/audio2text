from __future__ import annotations

import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import storage
from api import router
from config import APP_NAME, APP_VERSION, HOST, PORT, STATIC_DIR, ensure_directories


def create_app() -> FastAPI:
    ensure_directories()
    storage.init_db()

    app = FastAPI(title=APP_NAME, version=APP_VERSION)
    app.include_router(router)
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    return app


app = create_app()


if __name__ == "__main__":
    uvicorn.run("app:app", host=HOST, port=PORT, reload=False)
