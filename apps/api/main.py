from dotenv import load_dotenv
load_dotenv()  # must run before any module that reads env vars at import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import logging

from routers import images, grade, prompt, batch, reference

logger = logging.getLogger("chromaai")

app = FastAPI(
    title="ChromaAI API",
    description="AI-assisted color grading — FastAPI backend",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve rendered previews as static files
previews_dir = Path("previews")
previews_dir.mkdir(exist_ok=True)
app.mount("/previews", StaticFiles(directory=str(previews_dir)), name="previews")

app.include_router(images.router)
app.include_router(grade.router)
app.include_router(prompt.router)
app.include_router(batch.router)
app.include_router(reference.router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    # Surface auth errors as 503 so the frontend can show a meaningful message
    msg = str(exc)
    if "api_key" in msg.lower() or "authentication" in msg.lower() or "auth_token" in msg.lower():
        return JSONResponse(
            status_code=503,
            content={"detail": "ANTHROPIC_API_KEY is not configured. Add it to apps/api/.env"},
        )
    return JSONResponse(status_code=500, content={"detail": msg})


@app.get("/health")
async def health():
    return {"status": "ok", "service": "chromaai-api"}


@app.get("/")
async def root():
    return {
        "name": "ChromaAI API",
        "version": "0.1.0",
        "docs": "/docs",
    }
