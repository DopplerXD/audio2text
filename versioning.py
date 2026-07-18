from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any

from models import AIRun, TranscriptionRecord


TEXT_VERSION_STAGES = {"organize", "review"}
_TOKEN_PATTERN = re.compile(
    r"\r\n|\n|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[A-Za-z0-9_]+|[^\w\s]|\s+|\w+",
    re.UNICODE,
)


class VersionLookupError(ValueError):
    pass


def _short_timestamp(value: str) -> str:
    return str(value or "").replace("T", " ")[:16]


def _run_version(run: AIRun) -> dict[str, Any]:
    stage_label = "STEP 1 · 整理" if run.stage == "organize" else "STEP 2 · 检查"
    timestamp = _short_timestamp(run.updated_at or run.created_at)
    suffix = f" · {timestamp}" if timestamp else ""
    return {
        "id": f"{run.stage}:{run.id}",
        "stage": run.stage,
        "run_id": run.id,
        "label": f"{stage_label} #{run.id}{suffix}",
        "text": run.result_text,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
    }


def list_text_versions(record: TranscriptionRecord) -> list[dict[str, Any]]:
    versions = [
        {
            "id": "original",
            "stage": "original",
            "run_id": None,
            "label": "最初版 · 原始识别结果",
            "text": record.initial_text or record.text,
            "created_at": record.created_at,
            "updated_at": record.created_at,
        }
    ]
    runs = sorted(
        (
            run
            for run in record.ai_runs
            if run.stage in TEXT_VERSION_STAGES and run.id is not None and run.result_text
        ),
        key=lambda run: int(run.id or 0),
        reverse=True,
    )
    versions.extend(_run_version(run) for run in runs)
    return versions


def resolve_text_version(record: TranscriptionRecord, version_id: str) -> dict[str, Any]:
    normalized = str(version_id or "").strip()
    for version in list_text_versions(record):
        if version["id"] == normalized:
            return version
    raise VersionLookupError("文本版本不存在或不属于当前记录。")


def tokenize_for_diff(text: str) -> list[str]:
    return _TOKEN_PATTERN.findall(str(text or ""))


def compare_text_versions(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    left_text = str(left.get("text") or "")
    right_text = str(right.get("text") or "")
    left_tokens = tokenize_for_diff(left_text)
    right_tokens = tokenize_for_diff(right_text)
    matcher = SequenceMatcher(a=right_tokens, b=left_tokens, autojunk=True)
    chunks: list[dict[str, str]] = []
    counts = {"added_chars": 0, "removed_chars": 0, "changed_chars": 0}

    for tag, right_start, right_end, left_start, left_end in matcher.get_opcodes():
        current_left = "".join(left_tokens[left_start:left_end])
        current_right = "".join(right_tokens[right_start:right_end])
        if tag == "equal":
            chunk_type = "equal"
        elif tag == "insert":
            chunk_type = "left_only"
            counts["added_chars"] += len(current_left)
        elif tag == "delete":
            chunk_type = "right_only"
            counts["removed_chars"] += len(current_right)
        else:
            chunk_type = "replace"
            counts["changed_chars"] += max(len(current_left), len(current_right))
        chunks.append(
            {
                "type": chunk_type,
                "left_text": current_left,
                "right_text": current_right,
            }
        )

    return {
        "left": {key: value for key, value in left.items() if key != "text"},
        "right": {key: value for key, value in right.items() if key != "text"},
        "identical": left_text == right_text,
        "counts": counts,
        "chunks": chunks,
    }
