import os
from pathlib import Path

from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


APP_NAME = "本地音频转文字"
APP_VERSION = "v1.5"
HOST = "127.0.0.1"
PORT = 7860

DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = BASE_DIR / "uploads"
TEMP_DIR = BASE_DIR / "temp"
OUTPUTS_DIR = BASE_DIR / "outputs"
STATIC_DIR = BASE_DIR / "static"
DATABASE_PATH = DATA_DIR / "records.db"

SUPPORTED_EXTENSIONS = {
    ".mp3",
    ".m4a",
    ".wav",
    ".aac",
    ".flac",
    ".mp4",
    ".mov",
    ".mkv",
}

ASR_ENGINE = "funasr"
FUNASR_MODEL_MODE = "funasr-paraformer-zh"
FUNASR_MODEL = "paraformer-zh"
FUNASR_VAD_MODEL = "fsmn-vad"
FUNASR_PUNC_MODEL = "ct-punc"
FUNASR_MODEL_NAME = "paraformer-zh + fsmn-vad + ct-punc"
FUNASR_DEVICE = os.getenv("FUNASR_DEVICE", "cpu")
FUNASR_VAD_KWARGS = {"max_single_segment_time": 60000}
FUNASR_BATCH_SIZE_S = 300
DEFAULT_LANGUAGE = "zh"

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash").strip() or "deepseek-v4-flash"
DEEPSEEK_TIMEOUT_SECONDS = float(os.getenv("DEEPSEEK_TIMEOUT_SECONDS", "180"))
AI_MAX_INPUT_CHARS = int(os.getenv("AI_MAX_INPUT_CHARS", "350000"))

EXPORT_FORMATS = {"txt", "md", "pdf", "srt", "vtt", "json"}
ALL_EXPORT_FORMATS = ["txt", "md", "pdf", "srt", "vtt", "json"]


def ensure_directories() -> None:
    for directory in (DATA_DIR, UPLOADS_DIR, TEMP_DIR, OUTPUTS_DIR, STATIC_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def relative_path(path: str | Path | None) -> str | None:
    if not path:
        return None
    resolved = Path(path).resolve()
    try:
        return str(resolved.relative_to(BASE_DIR))
    except ValueError:
        return str(resolved)


def absolute_path(path: str | Path | None) -> str | None:
    if not path:
        return None
    return str(Path(path).resolve())
