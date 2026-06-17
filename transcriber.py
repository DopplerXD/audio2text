from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from config import (
    DEFAULT_LANGUAGE,
    FUNASR_BATCH_SIZE_S,
    FUNASR_DEVICE,
    FUNASR_MODEL,
    FUNASR_MODEL_NAME,
    FUNASR_PUNC_MODEL,
    FUNASR_VAD_KWARGS,
    FUNASR_VAD_MODEL,
)
from models import Segment, TranscriptionResult


class TranscriptionError(RuntimeError):
    pass


_FUNASR_MODEL = None
_SENTENCE_END_RE = re.compile(r"[。！？!?；;，,、\n]")


def resolve_model(model_mode: str | None = None) -> str:
    return FUNASR_MODEL_NAME


def get_model():
    global _FUNASR_MODEL
    if _FUNASR_MODEL is not None:
        return _FUNASR_MODEL

    try:
        from funasr import AutoModel
    except ImportError as exc:
        raise TranscriptionError("未安装 funasr。请先运行：pip install -r requirements.txt") from exc
    except Exception as exc:
        raise TranscriptionError(f"FunASR 初始化失败：{exc}") from exc

    try:
        _FUNASR_MODEL = AutoModel(
            model=FUNASR_MODEL,
            vad_model=FUNASR_VAD_MODEL,
            vad_kwargs=FUNASR_VAD_KWARGS,
            punc_model=FUNASR_PUNC_MODEL,
            device=FUNASR_DEVICE,
        )
    except Exception as exc:
        raise TranscriptionError(f"FunASR 模型加载失败：{exc}") from exc
    return _FUNASR_MODEL


def transcribe_audio(
    audio_path: str | Path,
    *,
    original_filename: str,
    model_mode: str,
    language: str,
    word_timestamps: bool,
    duration: float | None,
) -> TranscriptionResult:
    try:
        raw_result = get_model().generate(
            input=str(audio_path),
            batch_size_s=FUNASR_BATCH_SIZE_S,
        )
    except TranscriptionError:
        raise
    except Exception as exc:
        raise TranscriptionError(f"识别过程中断：{exc}") from exc

    result = _first_result(raw_result)
    text = str(result.get("text") or "").strip()
    segments = _segments_from_result(result, text, duration)
    if not text:
        text = "\n".join(segment.text for segment in segments if segment.text).strip()

    return TranscriptionResult(
        filename=original_filename,
        language=DEFAULT_LANGUAGE,
        duration=duration,
        text=text,
        segments=segments,
    )


def _first_result(raw_result: Any) -> dict[str, Any]:
    if isinstance(raw_result, list) and raw_result:
        first = raw_result[0]
    else:
        first = raw_result
    if not isinstance(first, dict):
        raise TranscriptionError("FunASR 返回结果格式异常。")
    return first


def _segments_from_result(
    result: dict[str, Any],
    text: str,
    duration: float | None,
) -> list[Segment]:
    sentence_segments = _segments_from_sentence_info(result.get("sentence_info"))
    if sentence_segments:
        return sentence_segments

    timestamps = result.get("timestamp") or result.get("timestamps")
    timestamp_segments = _segments_from_timestamps(text, timestamps)
    if timestamp_segments:
        return timestamp_segments

    clean_text = text.strip()
    if not clean_text:
        return []
    end = float(duration or 0.0)
    return [Segment(id=0, start=0.0, end=end, text=clean_text)]


def _segments_from_sentence_info(sentence_info: Any) -> list[Segment]:
    if not isinstance(sentence_info, list):
        return []

    segments: list[Segment] = []
    for item in sentence_info:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        start = _milliseconds_to_seconds(item.get("start", 0))
        end = _milliseconds_to_seconds(item.get("end", item.get("start", 0)))
        segments.append(Segment(id=len(segments), start=start, end=max(end, start), text=text))
    return segments


def _segments_from_timestamps(text: str, timestamps: Any) -> list[Segment]:
    if not text or not isinstance(timestamps, list):
        return []

    chars = list(text)
    pairs = [_timestamp_pair_to_seconds(pair) for pair in timestamps]
    pairs = [pair for pair in pairs if pair is not None]
    if not pairs:
        return []

    usable_len = min(len(chars), len(pairs))
    segments: list[Segment] = []
    start_index = 0

    for index in range(usable_len):
        char = chars[index]
        segment_len = index - start_index + 1
        should_split = bool(_SENTENCE_END_RE.match(char)) or segment_len >= 42
        if should_split:
            _append_timestamp_segment(segments, chars, pairs, start_index, index)
            start_index = index + 1

    if start_index < usable_len:
        _append_timestamp_segment(segments, chars, pairs, start_index, usable_len - 1)
    return segments


def _append_timestamp_segment(
    segments: list[Segment],
    chars: list[str],
    pairs: list[tuple[float, float]],
    start_index: int,
    end_index: int,
) -> None:
    text = "".join(chars[start_index : end_index + 1]).strip()
    if not text:
        return
    start = pairs[start_index][0]
    end = pairs[end_index][1]
    segments.append(Segment(id=len(segments), start=start, end=max(end, start), text=text))


def _timestamp_pair_to_seconds(pair: Any) -> tuple[float, float] | None:
    if not isinstance(pair, (list, tuple)) or len(pair) < 2:
        return None
    return (_milliseconds_to_seconds(pair[0]), _milliseconds_to_seconds(pair[1]))


def _milliseconds_to_seconds(value: Any) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.0
    return round(numeric / 1000.0, 3)
