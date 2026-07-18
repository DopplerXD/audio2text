from __future__ import annotations

import shutil
import tempfile
import time
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

import audio_utils
import ai_service
import exporters
import storage
import versioning
from config import (
    ALL_EXPORT_FORMATS,
    APP_NAME,
    APP_VERSION,
    ASR_ENGINE,
    BASE_DIR,
    EXPORT_FORMATS,
    FUNASR_DEVICE,
    FUNASR_MODEL,
    FUNASR_MODEL_MODE,
    FUNASR_MODEL_NAME,
    FUNASR_PUNC_MODEL,
    FUNASR_VAD_MODEL,
    OUTPUTS_DIR,
)
from models import Segment, safe_stem
from transcriber import resolve_model, transcribe_audio


router = APIRouter(prefix="/api")
REVIEW_EXPORT_FORMATS = {"txt", "md", "pdf", "json"}


def _http_error(exc: Exception, status_code: int = 400) -> HTTPException:
    return HTTPException(status_code=status_code, detail=str(exc))


def _ai_http_error(exc: Exception) -> HTTPException:
    status_code = 503 if "API Key" in str(exc) else 502
    return HTTPException(status_code=status_code, detail=str(exc))


def _record_or_404(record_id: str):
    record = storage.get_record(record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="记录不存在。")
    return record


def _review_run_or_404(record_id: str, run_id: int):
    run = storage.get_ai_run(run_id)
    if run is None or run.record_id != record_id or run.stage != "review":
        raise HTTPException(status_code=404, detail="人工检查记录不存在。")
    return run


def _new_record_id(filename: str) -> str:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base_id = f"{timestamp}-{safe_stem(filename)}"
    record_id = base_id
    counter = 2
    while storage.get_record(record_id) is not None:
        record_id = f"{base_id}-{counter}"
        counter += 1
    return record_id


@router.get("/health")
def health() -> dict[str, Any]:
    return {
        "app": APP_NAME,
        "version": APP_VERSION,
        "status": "ok",
        "engine": ASR_ENGINE,
        "model_name": FUNASR_MODEL,
        "device": FUNASR_DEVICE,
        "vad_model": FUNASR_VAD_MODEL,
        "punc_model": FUNASR_PUNC_MODEL,
        "base_dir": str(BASE_DIR),
        "output_dir": str(OUTPUTS_DIR),
        "ai": ai_service.ai_config(),
    }


@router.post("/transcriptions")
async def create_transcription(
    file: UploadFile = File(...),
    language: str = Form("auto"),
    model_mode: str = Form("quality"),
    word_timestamps: bool = Form(False),
) -> dict[str, Any]:
    filename = file.filename or "audio"
    try:
        audio_utils.validate_upload_filename(filename)
    except Exception as exc:
        raise _http_error(exc)

    record_id = _new_record_id(filename)
    output_dir = (OUTPUTS_DIR / record_id).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    model_name = resolve_model(FUNASR_MODEL_MODE)

    original_path = ""
    try:
        original_path = str((BASE_DIR / "uploads" / record_id / Path(filename).name).resolve())
        storage.create_record(
            record_id=record_id,
            original_filename=filename,
            original_path=original_path,
            output_dir=str(output_dir),
            model_mode=FUNASR_MODEL_MODE,
            model_name=model_name,
        )
        start = time.perf_counter()
        saved_path = await audio_utils.save_upload_file(file, record_id)
        storage.update_record(record_id, original_path=str(saved_path))
        wav_path = audio_utils.transcode_to_wav(saved_path, record_id)
        duration = audio_utils.get_duration_seconds(wav_path)
        result = transcribe_audio(
            wav_path,
            original_filename=filename,
            model_mode=FUNASR_MODEL_MODE,
            language="zh",
            word_timestamps=False,
            duration=duration,
        )
        elapsed = round(time.perf_counter() - start, 3)
        storage.set_initial_text_if_empty(record_id, result.text)
        storage.update_record(
            record_id,
            temp_audio_path=str(wav_path),
            status="completed",
            language=result.language,
            duration=result.duration,
            elapsed_seconds=elapsed,
            text=result.text,
            segments=result.segments,
            error_message=None,
        )
        return _record_or_404(record_id).to_dict()
    except Exception as exc:
        message = str(exc)
        if storage.get_record(record_id):
            storage.update_record(record_id, status="failed", error_message=message)
        raise _http_error(exc)


@router.get("/transcriptions")
def get_transcriptions() -> list[dict[str, Any]]:
    return [record.to_dict() for record in storage.list_records()]


@router.get("/transcriptions/{record_id}")
def get_transcription(record_id: str) -> dict[str, Any]:
    return _record_or_404(record_id).to_dict()


@router.get("/transcriptions/{record_id}/versions")
def get_transcription_versions(record_id: str) -> dict[str, Any]:
    record = _record_or_404(record_id)
    return {"versions": versioning.list_text_versions(record)}


@router.post("/transcriptions/{record_id}/versions/diff")
def diff_transcription_versions(record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    record = _record_or_404(record_id)
    left_version_id = str(payload.get("left_version_id") or "").strip()
    right_version_id = str(payload.get("right_version_id") or "").strip()
    if not left_version_id or not right_version_id:
        raise HTTPException(status_code=400, detail="必须同时选择左右两个文本版本。")
    try:
        left = versioning.resolve_text_version(record, left_version_id)
        right = versioning.resolve_text_version(record, right_version_id)
    except versioning.VersionLookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return versioning.compare_text_versions(left, right)


@router.patch("/transcriptions/{record_id}")
def update_transcription(record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    record = _record_or_404(record_id)
    segments = [Segment.from_dict(segment) for segment in payload.get("segments", record.segments)]
    storage.update_record(
        record_id,
        text=str(payload.get("text", "")),
        segments=segments,
    )
    return _record_or_404(record_id).to_dict()


@router.post("/transcriptions/{record_id}/ai/organize")
def organize_transcription(record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    record = _record_or_404(record_id)
    operations = payload.get("operations", ["remove_fillers"])
    if not isinstance(operations, list):
        raise HTTPException(status_code=400, detail="operations 必须是数组。")
    source_text = str(payload.get("text") or record.text)
    sync_subtitles = bool(payload.get("sync_subtitles", False))
    save_as_new = bool(payload.get("save_as_new", True))
    save_markdown = bool(payload.get("save_markdown", False))
    options = {
        "operations": operations,
        "sync_subtitles": sync_subtitles,
        "save_as_new": save_as_new,
        "save_markdown": save_markdown,
        "model": ai_service.DEEPSEEK_MODEL,
    }
    try:
        text, segments, result = ai_service.organize_text(
            record,
            source_text=source_text,
            operations=operations,
            sync_subtitles=sync_subtitles,
        )
        run = storage.add_ai_run(
            record_id,
            stage="organize",
            preset="custom",
            source_text=source_text,
            result_text=text,
            result=result,
            options=options,
        )
        if not save_as_new:
            update_fields: dict[str, Any] = {"text": text}
            if sync_subtitles:
                update_fields["segments"] = segments
            storage.update_record(record_id, **update_fields)

        export_files = []
        for fmt, path in ai_service.export_organized_files(
            record,
            run_id=int(run.id or 0),
            text=text,
            segments=segments,
            save_as_new=save_as_new,
            save_markdown=save_markdown,
            sync_subtitles=sync_subtitles,
        ):
            export_files.append(storage.add_export_file(record_id, f"ai-{fmt}", path))
        result["export_file_ids"] = [export_file.id for export_file in export_files]
        run = storage.update_ai_run(int(run.id or 0), result_text=text, result=result)
        return {
            "run": run.to_dict(),
            "export_files": [export_file.to_dict() for export_file in export_files],
            "record": _record_or_404(record_id).to_dict(),
        }
    except ai_service.AIServiceError as exc:
        raise _ai_http_error(exc)
    except Exception as exc:
        raise _http_error(exc)


@router.post("/transcriptions/{record_id}/ai/review")
def review_transcription(record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    record = _record_or_404(record_id)
    source_version_id = str(payload.get("source_version_id") or "").strip()
    try:
        if source_version_id:
            source_version = versioning.resolve_text_version(record, source_version_id)
            source_text = str(source_version["text"])
        else:
            source_text = str(payload.get("text") or record.text)
        issues, result = ai_service.review_text(source_text)
        run = storage.add_ai_run(
            record_id,
            stage="review",
            preset="contextual_anomaly",
            source_text=source_text,
            result_text=source_text,
            result=result,
            options={
                "model": ai_service.DEEPSEEK_MODEL,
                "source_version_id": source_version_id,
            },
        )
        return {"run": run.to_dict(), "issue_count": len(issues)}
    except versioning.VersionLookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ai_service.AIServiceError as exc:
        raise _ai_http_error(exc)
    except Exception as exc:
        raise _http_error(exc)


@router.post("/transcriptions/{record_id}/ai/reviews/{run_id}/diff")
def diff_review_draft(record_id: str, run_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    _record_or_404(record_id)
    run = _review_run_or_404(record_id, run_id)
    edited_text = payload.get("text")
    if not isinstance(edited_text, str):
        raise HTTPException(status_code=400, detail="text 必须是字符串。")
    current = {
        "id": f"review:{run_id}:draft",
        "stage": "review_draft",
        "run_id": run_id,
        "label": "当前编辑稿",
        "text": edited_text,
    }
    baseline = {
        "id": f"review:{run_id}:source",
        "stage": "review_source",
        "run_id": run_id,
        "label": "AI 检查初稿",
        "text": run.source_text,
    }
    return versioning.compare_text_versions(current, baseline)


@router.patch("/transcriptions/{record_id}/ai/reviews/{run_id}")
def update_review(record_id: str, run_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    _record_or_404(record_id)
    run = _review_run_or_404(record_id, run_id)
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="检查文本不能为空。")
    resolved_ids = payload.get("resolved_issue_ids", [])
    if not isinstance(resolved_ids, list):
        raise HTTPException(status_code=400, detail="resolved_issue_ids 必须是数组。")
    result = dict(run.result)
    issues = result.get("issues", [])
    result["issues"] = ai_service.refresh_review_issues(
        text,
        issues if isinstance(issues, list) else [],
        resolved_ids,
    )
    updated = storage.update_ai_run(run_id, result_text=text, result=result)
    return {"run": updated.to_dict()}


@router.post("/transcriptions/{record_id}/ai/reviews/{run_id}/exports")
def export_review_result(record_id: str, run_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    record = _record_or_404(record_id)
    run = _review_run_or_404(record_id, run_id)
    fmt = str(payload.get("format") or "").strip().lower()
    if fmt not in REVIEW_EXPORT_FORMATS:
        raise HTTPException(status_code=400, detail="STEP 2 结果支持导出 TXT、Markdown、PDF 或 JSON。")
    text = str(run.result_text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="请先保存 STEP 2 人工修改结果。")
    try:
        path = exporters.export_review_result(
            record,
            run_id=run_id,
            text=text,
            fmt=fmt,
        )
        export_file = storage.add_export_file(record_id, f"ai-review-{fmt}", path)
        result = dict(run.result)
        export_file_ids = [
            int(file_id)
            for file_id in result.get("export_file_ids", [])
            if isinstance(file_id, int) or str(file_id).isdigit()
        ]
        export_file_ids.append(int(export_file.id or 0))
        result["export_file_ids"] = list(dict.fromkeys(export_file_ids))
        updated = storage.update_ai_run(run_id, result_text=text, result=result)
        return {
            "run": updated.to_dict(),
            "export_file": export_file.to_dict(),
            "record": _record_or_404(record_id).to_dict(),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise _http_error(exc)


@router.post("/transcriptions/{record_id}/ai/analyze")
def analyze_transcription(record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    record = _record_or_404(record_id)
    source_text = str(payload.get("text") or record.text)
    preset = str(payload.get("preset") or "backend_interview")
    try:
        result = ai_service.analyze_text(source_text, preset=preset)
        run = storage.add_ai_run(
            record_id,
            stage="analysis",
            preset=preset,
            source_text=source_text,
            result_text=result["summary"],
            result=result,
            options={"model": ai_service.DEEPSEEK_MODEL},
        )
        return {"run": run.to_dict()}
    except ai_service.AIServiceError as exc:
        raise _ai_http_error(exc)
    except Exception as exc:
        raise _http_error(exc)


@router.delete("/transcriptions/{record_id}")
def delete_transcription(record_id: str, delete_files: bool = False) -> dict[str, Any]:
    record = _record_or_404(record_id)
    storage.delete_record(record_id)
    if delete_files:
        for path in (record.original_path, record.temp_audio_path, record.output_dir):
            if not path:
                continue
            target = Path(path)
            if target.is_file():
                target.unlink(missing_ok=True)
            elif target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
    return {"ok": True}


@router.post("/transcriptions/{record_id}/exports")
def create_export(record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    record = _record_or_404(record_id)
    fmt = str(payload.get("format", "")).lower()
    if fmt not in EXPORT_FORMATS:
        raise HTTPException(status_code=400, detail="导出格式不支持。")
    try:
        path = exporters.export_record(record, fmt)
        export_file = storage.add_export_file(record_id, fmt, path)
        return {"export_file": export_file.to_dict(), "record": _record_or_404(record_id).to_dict()}
    except Exception as exc:
        raise _http_error(exc)


@router.post("/transcriptions/{record_id}/exports/all")
def create_all_exports(record_id: str) -> dict[str, Any]:
    record = _record_or_404(record_id)
    try:
        files, zip_path = exporters.export_all_zip(record)
        export_files = [storage.add_export_file(record_id, fmt, path) for fmt, path in zip(ALL_EXPORT_FORMATS, files)]
        export_files.append(storage.add_export_file(record_id, "zip", zip_path))
        return {
            "export_files": [export_file.to_dict() for export_file in export_files],
            "record": _record_or_404(record_id).to_dict(),
        }
    except Exception as exc:
        raise _http_error(exc)


def _selected_export_files(
    record_id: str,
    payload: dict[str, Any],
) -> tuple[list[int], list[Any]]:
    raw_ids = payload.get("file_ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(status_code=400, detail="请至少选择一个导出文件。")
    try:
        file_ids = list(dict.fromkeys(int(file_id) for file_id in raw_ids))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="file_ids 必须是文件 ID 数组。")
    if any(file_id <= 0 for file_id in file_ids):
        raise HTTPException(status_code=400, detail="文件 ID 无效。")
    files = storage.get_export_files(record_id, file_ids)
    if len(files) != len(file_ids):
        raise HTTPException(status_code=404, detail="部分导出文件不存在或不属于当前记录。")
    return file_ids, files


def _safe_export_path(record: Any, export_file: Any) -> Path:
    output_dir = Path(record.output_dir).resolve()
    file_path = Path(export_file.path).resolve()
    try:
        file_path.relative_to(output_dir)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"文件不在当前记录的输出目录中：{export_file.filename}")
    return file_path


@router.post("/transcriptions/{record_id}/exports/download")
def download_selected_exports(
    record_id: str,
    payload: dict[str, Any],
) -> FileResponse:
    record = _record_or_404(record_id)
    _, files = _selected_export_files(record_id, payload)
    temp_dir = Path(tempfile.mkdtemp(prefix="audio2text-selected-exports-"))
    zip_path = temp_dir / f"{record.id}-selected-exports.zip"
    used_names: set[str] = set()
    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for export_file in files:
                file_path = _safe_export_path(record, export_file)
                if not file_path.is_file():
                    raise HTTPException(status_code=404, detail=f"导出文件不存在：{export_file.filename}")
                candidate = export_file.filename
                stem = Path(candidate).stem
                suffix = Path(candidate).suffix
                index = 2
                while candidate in used_names:
                    candidate = f"{stem}-{index}{suffix}"
                    index += 1
                used_names.add(candidate)
                archive.write(file_path, arcname=candidate)
        return FileResponse(
            str(zip_path),
            media_type="application/zip",
            filename=zip_path.name,
            background=BackgroundTask(shutil.rmtree, temp_dir, ignore_errors=True),
        )
    except HTTPException:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise _http_error(exc)


@router.post("/transcriptions/{record_id}/exports/delete")
def delete_selected_exports(record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    record = _record_or_404(record_id)
    file_ids, files = _selected_export_files(record_id, payload)
    paths_to_delete: dict[Path, str] = {}
    retained_shared_paths: list[str] = []
    for export_file in files:
        file_path = _safe_export_path(record, export_file)
        remaining_references = storage.count_export_path_references(
            str(file_path),
            excluding_file_ids=file_ids,
        )
        if remaining_references:
            retained_shared_paths.append(str(file_path))
        else:
            paths_to_delete[file_path] = export_file.filename

    try:
        deleted_paths: list[str] = []
        for file_path, filename in paths_to_delete.items():
            if not file_path.exists():
                continue
            if not file_path.is_file():
                raise HTTPException(status_code=400, detail=f"导出目标不是普通文件：{filename}")
            file_path.unlink()
            deleted_paths.append(str(file_path))
        deleted_count = storage.delete_export_files(record_id, file_ids)
        if deleted_count != len(file_ids):
            raise RuntimeError("导出文件记录删除不完整。")
        return {
            "deleted_ids": file_ids,
            "deleted_paths": deleted_paths,
            "retained_shared_paths": retained_shared_paths,
            "record": _record_or_404(record_id).to_dict(),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise _http_error(exc)


@router.get("/files/{file_id}")
def download_file(file_id: int) -> FileResponse:
    export_file = storage.get_export_file(file_id)
    if export_file is None:
        raise HTTPException(status_code=404, detail="文件记录不存在。")
    path = Path(export_file.path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="下载文件不存在。")
    return FileResponse(str(path), filename=export_file.filename)
