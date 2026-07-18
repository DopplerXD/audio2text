from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import ai_service
from models import Segment, TranscriptionRecord


class FakeClient:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def complete_json(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


def make_record(output_dir: str = "/tmp/audio2text-test") -> TranscriptionRecord:
    return TranscriptionRecord(
        id="record-1",
        original_filename="interview.wav",
        original_path="/tmp/interview.wav",
        temp_audio_path=None,
        output_dir=output_dir,
        status="completed",
        model_mode="quality",
        model_name="paraformer",
        language="zh",
        duration=12.0,
        elapsed_seconds=1.0,
        text="呃我使用卡芙卡处理消息。",
        segments=[Segment(id=0, start=0.0, end=4.0, text="呃我使用卡芙卡处理消息。")],
        export_files=[],
        error_message=None,
        created_at="2026-07-18T12:00:00+08:00",
        updated_at="2026-07-18T12:00:00+08:00",
    )


class AIServiceTests(unittest.TestCase):
    def test_client_requires_isolated_api_key(self):
        client = ai_service.DeepSeekClient(api_key="")
        with self.assertRaisesRegex(ai_service.AIServiceError, "DEEPSEEK_API_KEY"):
            client.complete_json(system_prompt="只输出 JSON", user_prompt="{}")

    def test_prompt_only_includes_selected_operations(self):
        _, prompt = ai_service.build_organize_prompts(
            "呃，这是正文。",
            ["remove_fillers"],
            segments=[],
            sync_subtitles=False,
        )
        self.assertIn("口水词去除", prompt)
        self.assertNotIn("书面化改写", prompt)
        self.assertIn("segments 固定返回空数组", prompt)

    def test_organize_preserves_segment_timestamps(self):
        record = make_record()
        client = FakeClient(
            {
                "text": "我使用 Kafka 处理消息。",
                "segments": [{"id": 0, "text": "我使用 Kafka 处理消息。", "start": 99}],
                "change_summary": ["移除口水词", "修正术语"],
            }
        )
        text, segments, _ = ai_service.organize_text(
            record,
            source_text=record.text,
            operations=["remove_fillers", "correct_technical_terms"],
            sync_subtitles=True,
            client=client,
        )
        self.assertEqual(text, "我使用 Kafka 处理消息。")
        self.assertEqual(segments[0].text, "我使用 Kafka 处理消息。")
        self.assertEqual(segments[0].start, 0.0)
        self.assertEqual(segments[0].end, 4.0)

    def test_review_quotes_are_mapped_to_exact_offsets(self):
        text = "我们用卡芙卡，再由卡芙卡消费消息。"
        issues = ai_service.locate_review_issues(
            text,
            [
                {"text": "卡芙卡", "suggestion": "Kafka", "reason": "术语误识别", "confidence": 0.96},
                {"text": "卡芙卡", "suggestion": "Kafka", "reason": "术语误识别", "confidence": 0.91},
                {"text": "我们", "suggestion": "我", "reason": "低置信度", "confidence": 0.4},
            ],
        )
        self.assertEqual(len(issues), 2)
        self.assertEqual(text[issues[0]["start"] : issues[0]["end"]], "卡芙卡")
        self.assertGreater(issues[1]["start"], issues[0]["start"])

    def test_review_issue_resolves_after_text_changes(self):
        issues = [{"id": "issue-1", "text": "卡芙卡", "start": 3, "end": 6, "resolved": False}]
        refreshed = ai_service.refresh_review_issues("使用 Kafka。", issues, ["issue-1"])
        self.assertTrue(refreshed[0]["resolved"])

    def test_analysis_result_is_normalized(self):
        client = FakeClient({"summary": "基础扎实", "overall_score": 108, "questions": None})
        result = ai_service.analyze_text("问：什么是事务？答：事务具有 ACID。", preset="backend_interview", client=client)
        self.assertEqual(result["overall_score"], 100)
        self.assertEqual(result["questions"], [])
        self.assertEqual(result["dimensions"], [])

    def test_default_copy_export_does_not_use_original_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            record = make_record(directory)
            files = ai_service.export_organized_files(
                record,
                run_id=7,
                text="整理结果",
                segments=record.segments,
                save_as_new=True,
                save_markdown=False,
                sync_subtitles=False,
            )
            self.assertEqual([fmt for fmt, _ in files], ["txt"])
            path = files[0][1]
            self.assertEqual(path.name, "interview-智能整理-7.txt")
            self.assertEqual(Path(path).read_text(encoding="utf-8").strip(), "整理结果")


if __name__ == "__main__":
    unittest.main()
