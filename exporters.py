from __future__ import annotations

import json
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

from config import ALL_EXPORT_FORMATS, EXPORT_FORMATS, OUTPUTS_DIR
from models import Segment, TranscriptionRecord


class ExportError(RuntimeError):
    pass


TZ = ZoneInfo("Asia/Shanghai")


def export_record(record: TranscriptionRecord, fmt: str) -> Path:
    if fmt not in EXPORT_FORMATS:
        raise ExportError(f"导出格式不支持：{fmt}")

    output_dir = Path(record.output_dir or OUTPUTS_DIR / record.id)
    output_dir.mkdir(parents=True, exist_ok=True)
    writers: dict[str, Callable[[TranscriptionRecord, Path], Path]] = {
        "txt": write_txt,
        "md": write_markdown,
        "pdf": write_pdf,
        "srt": write_srt,
        "vtt": write_vtt,
        "json": write_json,
    }
    try:
        return writers[fmt](record, output_dir).resolve()
    except Exception as exc:
        if isinstance(exc, ExportError):
            raise
        raise ExportError(f"导出文件写入失败：{exc}") from exc


def export_all_zip(record: TranscriptionRecord) -> tuple[list[Path], Path]:
    output_dir = Path(record.output_dir or OUTPUTS_DIR / record.id)
    output_dir.mkdir(parents=True, exist_ok=True)
    files = [export_record(record, fmt) for fmt in ALL_EXPORT_FORMATS]
    zip_path = output_dir / f"{record.id}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for file_path in files:
            archive.write(file_path, arcname=file_path.name)
    return files, zip_path.resolve()


def _safe_text(record: TranscriptionRecord) -> str:
    text = (record.text or "").strip()
    if text:
        return text
    return "\n".join(segment.text.strip() for segment in record.segments if segment.text.strip())


def _base_name(record: TranscriptionRecord) -> str:
    return Path(record.original_filename).stem or record.id


def _format_timestamp(seconds: float, separator: str) -> str:
    milliseconds = int(round(max(seconds, 0.0) * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02}{separator}{millis:03}"


def _metadata_lines(record: TranscriptionRecord) -> list[str]:
    generated_at = datetime.now(TZ).isoformat(timespec="seconds")
    return [
        f"文件名：{record.original_filename}",
        f"识别语言：{record.language or '自动识别'}",
        f"音频时长：{record.duration if record.duration is not None else '未知'}",
        f"识别模型：{record.model_name}",
        f"生成时间：{generated_at}",
    ]


def write_txt(record: TranscriptionRecord, output_dir: Path) -> Path:
    path = output_dir / f"{_base_name(record)}.txt"
    path.write_text(_safe_text(record) + "\n", encoding="utf-8")
    return path


def write_markdown(record: TranscriptionRecord, output_dir: Path) -> Path:
    path = output_dir / f"{_base_name(record)}.md"
    lines = ["# 转写结果", "", *[f"- {line}" for line in _metadata_lines(record)], "", "## 完整文本", "", _safe_text(record), ""]
    if record.segments:
        lines.extend(["## 字幕分段", "", "| 开始 | 结束 | 内容 |", "| --- | --- | --- |"])
        for segment in record.segments:
            text = segment.text.replace("|", "\\|")
            lines.append(
                f"| {_format_timestamp(segment.start, '.')} | {_format_timestamp(segment.end, '.')} | {text} |"
            )
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return path


def _find_chinese_font() -> str | None:
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    return None


def write_pdf(record: TranscriptionRecord, output_dir: Path) -> Path:
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
    except ImportError as exc:
        raise ExportError("未安装 reportlab。请先运行：pip install -r requirements.txt") from exc

    path = output_dir / f"{_base_name(record)}.pdf"
    styles = getSampleStyleSheet()
    font_name = "Helvetica"
    font_path = _find_chinese_font()
    if font_path:
        try:
            pdfmetrics.registerFont(TTFont("LocalChineseFont", font_path))
            font_name = "LocalChineseFont"
        except Exception:
            font_name = "Helvetica"
    if font_name == "Helvetica":
        try:
            pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
            font_name = "STSong-Light"
        except Exception:
            font_name = "Helvetica"

    for style_name in ("Title", "Heading2", "BodyText"):
        styles[style_name].fontName = font_name
        styles[style_name].leading = max(styles[style_name].leading, styles[style_name].fontSize + 5)

    document = SimpleDocTemplate(str(path), pagesize=A4, title="转写结果")
    story = [Paragraph("转写结果", styles["Title"]), Spacer(1, 12)]
    for line in _metadata_lines(record):
        story.append(Paragraph(line, styles["BodyText"]))
    story.extend([Spacer(1, 12), Paragraph("完整文本", styles["Heading2"])])
    for paragraph in _safe_text(record).splitlines() or [""]:
        story.append(Paragraph(paragraph.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), styles["BodyText"]))
        story.append(Spacer(1, 6))
    document.build(story)
    return path


def _subtitle_segments(segments: list[Segment], text: str) -> list[Segment]:
    if segments:
        return segments
    return [Segment(id=0, start=0.0, end=0.0, text=text)]


def write_srt(record: TranscriptionRecord, output_dir: Path) -> Path:
    path = output_dir / f"{_base_name(record)}.srt"
    blocks = []
    for index, segment in enumerate(_subtitle_segments(record.segments, _safe_text(record)), start=1):
        blocks.append(
            f"{index}\n"
            f"{_format_timestamp(segment.start, ',')} --> {_format_timestamp(segment.end, ',')}\n"
            f"{segment.text.strip()}\n"
        )
    path.write_text("\n".join(blocks).rstrip() + "\n", encoding="utf-8")
    return path


def write_vtt(record: TranscriptionRecord, output_dir: Path) -> Path:
    path = output_dir / f"{_base_name(record)}.vtt"
    lines = ["WEBVTT", ""]
    for segment in _subtitle_segments(record.segments, _safe_text(record)):
        lines.extend(
            [
                f"{_format_timestamp(segment.start, '.')} --> {_format_timestamp(segment.end, '.')}",
                segment.text.strip(),
                "",
            ]
        )
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return path


def write_json(record: TranscriptionRecord, output_dir: Path) -> Path:
    path = output_dir / f"{_base_name(record)}.json"
    payload = record.to_dict()
    payload["text"] = _safe_text(record)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path
