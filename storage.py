from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from config import DATABASE_PATH
from models import AIRun, ExportFile, Segment, TranscriptionRecord


TZ = ZoneInfo("Asia/Shanghai")


def now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


@contextmanager
def db_connection():
    connection = get_connection()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def init_db() -> None:
    with db_connection() as connection:
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
                initial_text TEXT NOT NULL DEFAULT '',
                segments_json TEXT NOT NULL DEFAULT '[]',
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id TEXT NOT NULL,
                stage TEXT NOT NULL,
                preset TEXT NOT NULL DEFAULT '',
                source_text TEXT NOT NULL DEFAULT '',
                result_text TEXT NOT NULL DEFAULT '',
                result_json TEXT NOT NULL DEFAULT '{}',
                options_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_ai_runs_record_stage ON ai_runs(record_id, stage, id DESC)"
        )
        record_columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(records)").fetchall()
        }
        if "initial_text" not in record_columns:
            connection.execute(
                "ALTER TABLE records ADD COLUMN initial_text TEXT NOT NULL DEFAULT ''"
            )
        connection.execute(
            """
            UPDATE records
            SET initial_text = COALESCE(
                NULLIF((
                    SELECT source_text
                    FROM ai_runs
                    WHERE ai_runs.record_id = records.id
                      AND source_text <> ''
                    ORDER BY ai_runs.id ASC
                    LIMIT 1
                ), ''),
                text,
                ''
            )
            WHERE initial_text = ''
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


def _row_to_ai_run(row: sqlite3.Row) -> AIRun:
    return AIRun(
        id=row["id"],
        record_id=row["record_id"],
        stage=row["stage"],
        preset=row["preset"],
        source_text=row["source_text"] or "",
        result_text=row["result_text"] or "",
        result=json.loads(row["result_json"] or "{}"),
        options=json.loads(row["options_json"] or "{}"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_record(
    row: sqlite3.Row,
    export_files: list[ExportFile],
    ai_runs: list[AIRun] | None = None,
) -> TranscriptionRecord:
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
        initial_text=row["initial_text"] or row["text"] or "",
        segments=[Segment.from_dict(segment) for segment in segments_data],
        export_files=export_files,
        error_message=row["error_message"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        ai_runs=ai_runs or [],
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
    with db_connection() as connection:
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
    if "initial_text" in fields:
        raise ValueError("initial_text 是不可变字段，请使用 set_initial_text_if_empty。")
    fields["updated_at"] = now_iso()
    if "segments" in fields:
        fields["segments_json"] = _segments_to_json(fields.pop("segments"))
    assignments = ", ".join(f"{key} = ?" for key in fields)
    values = list(fields.values()) + [record_id]
    with db_connection() as connection:
        connection.execute(f"UPDATE records SET {assignments} WHERE id = ?", values)


def set_initial_text_if_empty(record_id: str, text: str) -> None:
    normalized = str(text or "")
    with db_connection() as connection:
        connection.execute(
            "UPDATE records SET initial_text = ? WHERE id = ? AND initial_text = ''",
            (normalized, record_id),
        )


def list_records() -> list[TranscriptionRecord]:
    with db_connection() as connection:
        rows = connection.execute(
            "SELECT * FROM records ORDER BY created_at DESC"
        ).fetchall()
        return [_row_to_record(row, []) for row in rows]


def get_record(record_id: str) -> TranscriptionRecord | None:
    with db_connection() as connection:
        row = connection.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
        if row is None:
            return None
        exports = connection.execute(
            "SELECT * FROM export_files WHERE record_id = ? ORDER BY created_at DESC, id DESC",
            (record_id,),
        ).fetchall()
        ai_runs = connection.execute(
            "SELECT * FROM ai_runs WHERE record_id = ? ORDER BY id DESC",
            (record_id,),
        ).fetchall()
        return _row_to_record(
            row,
            [_row_to_export_file(export) for export in exports],
            [_row_to_ai_run(run) for run in ai_runs],
        )


def add_export_file(record_id: str, fmt: str, path: str | Path) -> ExportFile:
    file_path = Path(path).resolve()
    created_at = now_iso()
    size = file_path.stat().st_size
    with db_connection() as connection:
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
    with db_connection() as connection:
        row = connection.execute("SELECT * FROM export_files WHERE id = ?", (file_id,)).fetchone()
        return _row_to_export_file(row) if row else None


def add_ai_run(
    record_id: str,
    *,
    stage: str,
    preset: str = "",
    source_text: str,
    result_text: str,
    result: dict[str, Any] | None = None,
    options: dict[str, Any] | None = None,
) -> AIRun:
    timestamp = now_iso()
    result_json = json.dumps(result or {}, ensure_ascii=False)
    options_json = json.dumps(options or {}, ensure_ascii=False)
    with db_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO ai_runs (
                record_id, stage, preset, source_text, result_text,
                result_json, options_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record_id,
                stage,
                preset,
                source_text,
                result_text,
                result_json,
                options_json,
                timestamp,
                timestamp,
            ),
        )
        run_id = int(cursor.lastrowid)
        row = connection.execute("SELECT * FROM ai_runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise RuntimeError("AI 处理记录保存失败。")
    return _row_to_ai_run(row)


def get_ai_run(run_id: int) -> AIRun | None:
    with db_connection() as connection:
        row = connection.execute("SELECT * FROM ai_runs WHERE id = ?", (run_id,)).fetchone()
        return _row_to_ai_run(row) if row else None


def update_ai_run(run_id: int, *, result_text: str, result: dict[str, Any]) -> AIRun:
    timestamp = now_iso()
    with db_connection() as connection:
        connection.execute(
            "UPDATE ai_runs SET result_text = ?, result_json = ?, updated_at = ? WHERE id = ?",
            (result_text, json.dumps(result, ensure_ascii=False), timestamp, run_id),
        )
        row = connection.execute("SELECT * FROM ai_runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise KeyError("AI 处理记录不存在。")
    return _row_to_ai_run(row)


def delete_record(record_id: str) -> None:
    with db_connection() as connection:
        connection.execute("DELETE FROM ai_runs WHERE record_id = ?", (record_id,))
        connection.execute("DELETE FROM export_files WHERE record_id = ?", (record_id,))
        connection.execute("DELETE FROM records WHERE id = ?", (record_id,))
