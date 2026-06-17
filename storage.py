from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from config import DATABASE_PATH
from models import ExportFile, Segment, TranscriptionRecord


TZ = ZoneInfo("Asia/Shanghai")


def now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    with get_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS records (
                id TEXT PRIMARY KEY,
                original_filename TEXT NOT NULL,
                original_path TEXT NOT NULL,
                temp_audio_path TEXT,
                output_dir TEXT NOT NULL,
                status TEXT NOT NULL,
                model_mode TEXT NOT NULL,
                model_name TEXT NOT NULL,
                language TEXT,
                duration REAL,
                elapsed_seconds REAL,
                text TEXT NOT NULL DEFAULT '',
                segments_json TEXT NOT NULL DEFAULT '[]',
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS export_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id TEXT NOT NULL,
                format TEXT NOT NULL,
                filename TEXT NOT NULL,
                path TEXT NOT NULL,
                size INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
            )
            """
        )


def _segments_to_json(segments: list[Segment] | list[dict[str, Any]]) -> str:
    normalized = [
        segment.to_dict() if isinstance(segment, Segment) else Segment.from_dict(segment).to_dict()
        for segment in segments
    ]
    return json.dumps(normalized, ensure_ascii=False)


def _row_to_export_file(row: sqlite3.Row) -> ExportFile:
    return ExportFile(
        id=row["id"],
        record_id=row["record_id"],
        format=row["format"],
        filename=row["filename"],
        path=row["path"],
        size=row["size"],
        created_at=row["created_at"],
    )


def _row_to_record(row: sqlite3.Row, export_files: list[ExportFile]) -> TranscriptionRecord:
    segments_data = json.loads(row["segments_json"] or "[]")
    return TranscriptionRecord(
        id=row["id"],
        original_filename=row["original_filename"],
        original_path=row["original_path"],
        temp_audio_path=row["temp_audio_path"],
        output_dir=row["output_dir"],
        status=row["status"],
        model_mode=row["model_mode"],
        model_name=row["model_name"],
        language=row["language"],
        duration=row["duration"],
        elapsed_seconds=row["elapsed_seconds"],
        text=row["text"] or "",
        segments=[Segment.from_dict(segment) for segment in segments_data],
        export_files=export_files,
        error_message=row["error_message"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def create_record(
    *,
    record_id: str,
    original_filename: str,
    original_path: str,
    output_dir: str,
    model_mode: str,
    model_name: str,
) -> None:
    timestamp = now_iso()
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO records (
                id, original_filename, original_path, output_dir, status,
                model_mode, model_name, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record_id,
                original_filename,
                original_path,
                output_dir,
                "running",
                model_mode,
                model_name,
                timestamp,
                timestamp,
            ),
        )


def update_record(record_id: str, **fields: Any) -> None:
    if not fields:
        return
    fields["updated_at"] = now_iso()
    if "segments" in fields:
        fields["segments_json"] = _segments_to_json(fields.pop("segments"))
    assignments = ", ".join(f"{key} = ?" for key in fields)
    values = list(fields.values()) + [record_id]
    with get_connection() as connection:
        connection.execute(f"UPDATE records SET {assignments} WHERE id = ?", values)


def list_records() -> list[TranscriptionRecord]:
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT * FROM records ORDER BY created_at DESC"
        ).fetchall()
        return [_row_to_record(row, []) for row in rows]


def get_record(record_id: str) -> TranscriptionRecord | None:
    with get_connection() as connection:
        row = connection.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
        if row is None:
            return None
        exports = connection.execute(
            "SELECT * FROM export_files WHERE record_id = ? ORDER BY created_at DESC, id DESC",
            (record_id,),
        ).fetchall()
        return _row_to_record(row, [_row_to_export_file(export) for export in exports])


def add_export_file(record_id: str, fmt: str, path: str | Path) -> ExportFile:
    file_path = Path(path).resolve()
    created_at = now_iso()
    size = file_path.stat().st_size
    with get_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO export_files (record_id, format, filename, path, size, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (record_id, fmt, file_path.name, str(file_path), size, created_at),
        )
        export_id = cursor.lastrowid
    return ExportFile(export_id, record_id, fmt, file_path.name, str(file_path), size, created_at)


def get_export_file(file_id: int) -> ExportFile | None:
    with get_connection() as connection:
        row = connection.execute("SELECT * FROM export_files WHERE id = ?", (file_id,)).fetchone()
        return _row_to_export_file(row) if row else None


def delete_record(record_id: str) -> None:
    with get_connection() as connection:
        connection.execute("DELETE FROM export_files WHERE record_id = ?", (record_id,))
        connection.execute("DELETE FROM records WHERE id = ?", (record_id,))
