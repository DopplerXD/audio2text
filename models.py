from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from config import absolute_path, relative_path


@dataclass
class Segment:
    id: int
    start: float
    end: float
    text: str
    words: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Segment":
        return cls(
            id=int(data.get("id", 0)),
            start=float(data.get("start", 0.0) or 0.0),
            end=float(data.get("end", 0.0) or 0.0),
            text=str(data.get("text", "")),
            words=list(data.get("words") or []),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "start": self.start,
            "end": self.end,
            "text": self.text,
            "words": self.words,
        }


@dataclass
class TranscriptionResult:
    filename: str
    language: str | None
    duration: float | None
    text: str
    segments: list[Segment]


@dataclass
class ExportFile:
    id: int | None
    record_id: str
    format: str
    filename: str
    path: str
    size: int
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "record_id": self.record_id,
            "format": self.format,
            "filename": self.filename,
            "path": relative_path(self.path),
            "absolute_path": absolute_path(self.path),
            "size": self.size,
            "created_at": self.created_at,
        }


@dataclass
class TranscriptionRecord:
    id: str
    original_filename: str
    original_path: str
    temp_audio_path: str | None
    output_dir: str
    status: str
    model_mode: str
    model_name: str
    language: str | None
    duration: float | None
    elapsed_seconds: float | None
    text: str
    segments: list[Segment]
    export_files: list[ExportFile]
    error_message: str | None
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "original_filename": self.original_filename,
            "original_path": relative_path(self.original_path),
            "original_absolute_path": absolute_path(self.original_path),
            "temp_audio_path": relative_path(self.temp_audio_path),
            "temp_audio_absolute_path": absolute_path(self.temp_audio_path),
            "output_dir": relative_path(self.output_dir),
            "output_absolute_dir": absolute_path(self.output_dir),
            "status": self.status,
            "model_mode": self.model_mode,
            "model_name": self.model_name,
            "language": self.language,
            "duration": self.duration,
            "elapsed_seconds": self.elapsed_seconds,
            "text": self.text,
            "segments": [segment.to_dict() for segment in self.segments],
            "export_files": [export_file.to_dict() for export_file in self.export_files],
            "error_message": self.error_message,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


def safe_stem(filename: str) -> str:
    stem = Path(filename).stem.strip().lower()
    safe = []
    for char in stem:
        if char.isalnum() or char in ("-", "_"):
            safe.append(char)
        elif char.isspace() or char in (".", "+"):
            safe.append("-")
    normalized = "".join(safe).strip("-_")
    return normalized[:48] or "audio"
