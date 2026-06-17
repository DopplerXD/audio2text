from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from fastapi import UploadFile

from config import SUPPORTED_EXTENSIONS, TEMP_DIR, UPLOADS_DIR


class AudioProcessingError(RuntimeError):
    pass


def check_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise AudioProcessingError("未安装 FFmpeg。请先运行：brew install ffmpeg")
    if shutil.which("ffprobe") is None:
        raise AudioProcessingError("未安装 FFprobe。请先运行：brew install ffmpeg")


def validate_upload_filename(filename: str) -> str:
    if not filename:
        raise AudioProcessingError("上传文件为空。")
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise AudioProcessingError(f"文件格式不支持：{suffix or '无扩展名'}。支持格式：{supported}")
    return suffix


async def save_upload_file(upload: UploadFile, record_id: str) -> Path:
    validate_upload_filename(upload.filename or "")
    record_dir = UPLOADS_DIR / record_id
    record_dir.mkdir(parents=True, exist_ok=True)
    target = record_dir / Path(upload.filename or "audio").name

    size = 0
    with target.open("wb") as output:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            output.write(chunk)

    if size == 0:
        raise AudioProcessingError("上传文件为空。")
    return target.resolve()


def transcode_to_wav(input_path: Path, record_id: str) -> Path:
    check_ffmpeg()
    temp_dir = TEMP_DIR / record_id
    temp_dir.mkdir(parents=True, exist_ok=True)
    output_path = temp_dir / "audio_16k_mono.wav"
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0 or not output_path.exists():
        message = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "FFmpeg 转码失败。"
        raise AudioProcessingError(f"文件无法被 FFmpeg 读取或转换：{message}")
    return output_path.resolve()


def get_duration_seconds(path: Path) -> float | None:
    check_ffmpeg()
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return None
    try:
        return round(float(result.stdout.strip()), 3)
    except ValueError:
        return None
