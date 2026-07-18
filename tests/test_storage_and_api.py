from __future__ import annotations

from io import BytesIO
import tempfile
import unittest
import sqlite3
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import app
import storage
from models import Segment


class StorageAndAPITests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_database_path = storage.DATABASE_PATH
        storage.DATABASE_PATH = Path(self.temp_dir.name) / "records.db"
        self.output_dir = Path(self.temp_dir.name) / "outputs"
        storage.init_db()
        storage.create_record(
            record_id="record-1",
            original_filename="interview.wav",
            original_path=str(Path(self.temp_dir.name) / "interview.wav"),
            output_dir=str(self.output_dir),
            model_mode="quality",
            model_name="paraformer",
        )
        storage.update_record(
            "record-1",
            status="completed",
            language="zh",
            text="呃，我用卡芙卡。",
            segments=[Segment(id=0, start=0, end=3, text="呃，我用卡芙卡。")],
        )
        storage.set_initial_text_if_empty("record-1", "呃，我用卡芙卡。")
        self.client = TestClient(app.create_app())

    def tearDown(self):
        storage.DATABASE_PATH = self.original_database_path
        self.temp_dir.cleanup()

    def test_ai_run_round_trip(self):
        created = storage.add_ai_run(
            "record-1",
            stage="review",
            source_text="原文",
            result_text="原文",
            result={"issues": []},
            options={"model": "deepseek-v4-flash"},
        )
        record = storage.get_record("record-1")
        self.assertIsNotNone(record)
        self.assertEqual(record.ai_runs[0].id, created.id)
        self.assertEqual(record.ai_runs[0].result, {"issues": []})

    def test_initial_text_is_immutable_after_record_edits(self):
        storage.update_record("record-1", text="人工修改后的正文")
        storage.set_initial_text_if_empty("record-1", "不应覆盖最初版")
        record = storage.get_record("record-1")
        self.assertEqual(record.text, "人工修改后的正文")
        self.assertEqual(record.initial_text, "呃，我用卡芙卡。")

    def test_legacy_database_backfills_initial_text_from_earliest_ai_source(self):
        legacy_path = Path(self.temp_dir.name) / "legacy.db"
        connection = sqlite3.connect(legacy_path)
        connection.executescript(
            """
            CREATE TABLE records (
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
            );
            CREATE TABLE ai_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id TEXT NOT NULL,
                stage TEXT NOT NULL,
                preset TEXT NOT NULL DEFAULT '',
                source_text TEXT NOT NULL DEFAULT '',
                result_text TEXT NOT NULL DEFAULT '',
                result_json TEXT NOT NULL DEFAULT '{}',
                options_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO records VALUES (
                'legacy-1', 'legacy.wav', '/tmp/legacy.wav', NULL, '/tmp/out',
                'completed', 'quality', 'paraformer', 'zh', 10, 1, '已覆盖文本', '[]', NULL,
                '2026-01-01T10:00:00+08:00', '2026-01-01T10:10:00+08:00'
            );
            INSERT INTO ai_runs (
                record_id, stage, source_text, result_text, created_at, updated_at
            ) VALUES (
                'legacy-1', 'organize', '最早源文本', '整理结果',
                '2026-01-01T10:05:00+08:00', '2026-01-01T10:05:00+08:00'
            );
            """
        )
        connection.commit()
        connection.close()
        current_path = storage.DATABASE_PATH
        try:
            storage.DATABASE_PATH = legacy_path
            storage.init_db()
            record = storage.get_record("legacy-1")
            self.assertEqual(record.initial_text, "最早源文本")
        finally:
            storage.DATABASE_PATH = current_path

    def test_version_list_and_chinese_diff_exclude_analysis_runs(self):
        organized = storage.add_ai_run(
            "record-1",
            stage="organize",
            source_text="呃，我用卡芙卡。",
            result_text="我用 Kafka。",
        )
        reviewed = storage.add_ai_run(
            "record-1",
            stage="review",
            source_text="我用 Kafka。",
            result_text="我在项目中使用 Kafka。",
        )
        analysis = storage.add_ai_run(
            "record-1",
            stage="analysis",
            source_text="我在项目中使用 Kafka。",
            result_text="总体评价",
        )
        versions_response = self.client.get("/api/transcriptions/record-1/versions")
        self.assertEqual(versions_response.status_code, 200, versions_response.text)
        versions = versions_response.json()["versions"]
        version_ids = {item["id"] for item in versions}
        self.assertEqual(version_ids, {"original", f"organize:{organized.id}", f"review:{reviewed.id}"})
        self.assertNotIn(f"analysis:{analysis.id}", version_ids)

        diff_response = self.client.post(
            "/api/transcriptions/record-1/versions/diff",
            json={"left_version_id": f"organize:{organized.id}", "right_version_id": "original"},
        )
        self.assertEqual(diff_response.status_code, 200, diff_response.text)
        diff = diff_response.json()
        self.assertFalse(diff["identical"])
        self.assertEqual("".join(item["left_text"] for item in diff["chunks"]), "我用 Kafka。")
        self.assertEqual("".join(item["right_text"] for item in diff["chunks"]), "呃，我用卡芙卡。")
        self.assertGreater(sum(diff["counts"].values()), 0)

        same_response = self.client.post(
            "/api/transcriptions/record-1/versions/diff",
            json={"left_version_id": "original", "right_version_id": "original"},
        )
        self.assertTrue(same_response.json()["identical"])

    def test_diff_rejects_version_from_another_record(self):
        storage.create_record(
            record_id="record-2",
            original_filename="other.wav",
            original_path="/tmp/other.wav",
            output_dir="/tmp/other-output",
            model_mode="quality",
            model_name="paraformer",
        )
        foreign = storage.add_ai_run(
            "record-2",
            stage="organize",
            source_text="外部版本",
            result_text="外部整理版本",
        )
        response = self.client.post(
            "/api/transcriptions/record-1/versions/diff",
            json={"left_version_id": f"organize:{foreign.id}", "right_version_id": "original"},
        )
        self.assertEqual(response.status_code, 404)

    @patch("api.ai_service.review_text")
    def test_review_uses_explicit_left_version_text(self, review_text):
        organized = storage.add_ai_run(
            "record-1",
            stage="organize",
            source_text="呃，我用卡芙卡。",
            result_text="我用 Kafka。",
        )
        review_text.return_value = ([], {"issues": []})
        versions = self.client.get("/api/transcriptions/record-1/versions").json()["versions"]
        selected = next(item for item in versions if item["id"] == f"organize:{organized.id}")
        response = self.client.post(
            "/api/transcriptions/record-1/ai/review",
            json={"text": selected["text"]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        review_text.assert_called_once_with("我用 Kafka。")

    @patch("api.ai_service.review_text")
    def test_review_resolves_and_persists_selected_source_version(self, review_text):
        organized = storage.add_ai_run(
            "record-1",
            stage="organize",
            source_text="呃，我用卡芙卡。",
            result_text="我用 Kafka。",
        )
        review_text.return_value = ([], {"issues": []})
        response = self.client.post(
            "/api/transcriptions/record-1/ai/review",
            json={
                "source_version_id": f"organize:{organized.id}",
                "text": "这段客户端文本不应覆盖所选版本。",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        run = response.json()["run"]
        self.assertEqual(run["source_text"], "我用 Kafka。")
        self.assertEqual(run["options"]["source_version_id"], f"organize:{organized.id}")
        review_text.assert_called_once_with("我用 Kafka。")

    def test_review_draft_diff_uses_immutable_check_source(self):
        review = storage.add_ai_run(
            "record-1",
            stage="review",
            source_text="我用卡芙卡处理消息。",
            result_text="我用卡芙卡处理消息。",
            result={"issues": []},
        )
        storage.update_ai_run(
            int(review.id or 0),
            result_text="我使用 Kafka 处理消息。",
            result={"issues": []},
        )

        response = self.client.post(
            f"/api/transcriptions/record-1/ai/reviews/{review.id}/diff",
            json={"text": "我通过 Kafka 处理消息。"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        diff = response.json()
        self.assertEqual("".join(chunk["left_text"] for chunk in diff["chunks"]), "我通过 Kafka 处理消息。")
        self.assertEqual("".join(chunk["right_text"] for chunk in diff["chunks"]), "我用卡芙卡处理消息。")
        self.assertTrue(any(chunk["type"] == "replace" for chunk in diff["chunks"]))

    def test_review_draft_diff_allows_empty_text(self):
        review = storage.add_ai_run(
            "record-1",
            stage="review",
            source_text="需要全部删除的内容",
            result_text="需要全部删除的内容",
        )

        response = self.client.post(
            f"/api/transcriptions/record-1/ai/reviews/{review.id}/diff",
            json={"text": ""},
        )

        self.assertEqual(response.status_code, 200, response.text)
        diff = response.json()
        self.assertEqual("".join(chunk["left_text"] for chunk in diff["chunks"]), "")
        self.assertEqual("".join(chunk["right_text"] for chunk in diff["chunks"]), "需要全部删除的内容")
        self.assertGreater(diff["counts"]["removed_chars"], 0)

    def test_review_draft_diff_rejects_wrong_record_and_stage(self):
        organized = storage.add_ai_run(
            "record-1",
            stage="organize",
            source_text="原始正文",
            result_text="整理正文",
        )
        storage.create_record(
            record_id="record-2",
            original_filename="other.wav",
            original_path="/tmp/other.wav",
            output_dir="/tmp/other-output",
            model_mode="quality",
            model_name="paraformer",
        )
        foreign_review = storage.add_ai_run(
            "record-2",
            stage="review",
            source_text="其他记录正文",
            result_text="其他记录正文",
        )

        wrong_stage = self.client.post(
            f"/api/transcriptions/record-1/ai/reviews/{organized.id}/diff",
            json={"text": "编辑正文"},
        )
        wrong_record = self.client.post(
            f"/api/transcriptions/record-1/ai/reviews/{foreign_review.id}/diff",
            json={"text": "编辑正文"},
        )

        self.assertEqual(wrong_stage.status_code, 404)
        self.assertEqual(wrong_record.status_code, 404)

    @patch("api.ai_service.organize_text")
    def test_organize_default_creates_copy_without_changing_record(self, organize_text):
        organized_segments = [Segment(id=0, start=0, end=3, text="我用 Kafka。")]
        organize_text.return_value = (
            "我用 Kafka。",
            organized_segments,
            {"text": "我用 Kafka。", "segments": []},
        )
        response = self.client.post(
            "/api/transcriptions/record-1/ai/organize",
            json={"operations": ["remove_fillers"]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["record"]["text"], "呃，我用卡芙卡。")
        self.assertEqual(len(payload["export_files"]), 1)
        self.assertEqual(payload["export_files"][0]["format"], "ai-txt")
        self.assertTrue(Path(payload["export_files"][0]["absolute_path"]).exists())

    @patch("api.ai_service.organize_text")
    def test_organize_can_update_record_and_synced_subtitles(self, organize_text):
        organized_segments = [Segment(id=0, start=0, end=3, text="我用 Kafka。")]
        organize_text.return_value = (
            "我用 Kafka。",
            organized_segments,
            {"text": "我用 Kafka。", "segments": [organized_segments[0].to_dict()]},
        )
        response = self.client.post(
            "/api/transcriptions/record-1/ai/organize",
            json={
                "operations": ["remove_fillers", "correct_technical_terms"],
                "save_as_new": False,
                "sync_subtitles": True,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["record"]["text"], "我用 Kafka。")
        self.assertEqual(payload["record"]["segments"][0]["text"], "我用 Kafka。")
        self.assertEqual({item["format"] for item in payload["export_files"]}, {"ai-srt", "ai-vtt"})

    def test_selected_export_download_includes_manual_and_ai_files(self):
        self.output_dir.mkdir(parents=True, exist_ok=True)
        manual_path = self.output_dir / "interview.txt"
        ai_path = self.output_dir / "interview-智能整理-1.txt"
        manual_path.write_text("原始导出", encoding="utf-8")
        ai_path.write_text("AI 整理结果", encoding="utf-8")
        manual_file = storage.add_export_file("record-1", "txt", manual_path)
        duplicate_manual_file = storage.add_export_file("record-1", "txt", manual_path)
        ai_file = storage.add_export_file("record-1", "ai-txt", ai_path)

        response = self.client.post(
            "/api/transcriptions/record-1/exports/download",
            json={"file_ids": [manual_file.id, duplicate_manual_file.id, ai_file.id]},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["content-type"], "application/zip")
        with zipfile.ZipFile(BytesIO(response.content)) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {manual_path.name, "interview-2.txt", ai_path.name},
            )
            self.assertEqual(archive.read(manual_path.name).decode("utf-8"), "原始导出")
            self.assertEqual(archive.read("interview-2.txt").decode("utf-8"), "原始导出")
            self.assertEqual(archive.read(ai_path.name).decode("utf-8"), "AI 整理结果")

    def test_export_delete_keeps_shared_file_until_last_reference(self):
        self.output_dir.mkdir(parents=True, exist_ok=True)
        shared_path = self.output_dir / "shared.txt"
        shared_path.write_text("共享内容", encoding="utf-8")
        first = storage.add_export_file("record-1", "txt", shared_path)
        second = storage.add_export_file("record-1", "txt", shared_path)

        first_response = self.client.post(
            "/api/transcriptions/record-1/exports/delete",
            json={"file_ids": [first.id]},
        )
        self.assertEqual(first_response.status_code, 200, first_response.text)
        self.assertTrue(shared_path.exists())
        self.assertIsNone(storage.get_export_file(int(first.id or 0)))
        self.assertIsNotNone(storage.get_export_file(int(second.id or 0)))
        self.assertTrue(first_response.json()["retained_shared_paths"])

        second_response = self.client.post(
            "/api/transcriptions/record-1/exports/delete",
            json={"file_ids": [second.id]},
        )
        self.assertEqual(second_response.status_code, 200, second_response.text)
        self.assertFalse(shared_path.exists())
        self.assertIsNone(storage.get_export_file(int(second.id or 0)))

    def test_export_batch_operations_validate_ownership_and_safe_path(self):
        storage.create_record(
            record_id="record-2",
            original_filename="other.wav",
            original_path="/tmp/other.wav",
            output_dir=str(Path(self.temp_dir.name) / "other-output"),
            model_mode="quality",
            model_name="paraformer",
        )
        foreign_path = Path(self.temp_dir.name) / "other-output" / "foreign.txt"
        foreign_path.parent.mkdir(parents=True, exist_ok=True)
        foreign_path.write_text("其他记录", encoding="utf-8")
        foreign_file = storage.add_export_file("record-2", "txt", foreign_path)

        foreign_response = self.client.post(
            "/api/transcriptions/record-1/exports/download",
            json={"file_ids": [foreign_file.id]},
        )
        self.assertEqual(foreign_response.status_code, 404)

        outside_path = Path(self.temp_dir.name) / "outside.txt"
        outside_path.write_text("输出目录外文件", encoding="utf-8")
        outside_file = storage.add_export_file("record-1", "txt", outside_path)
        unsafe_response = self.client.post(
            "/api/transcriptions/record-1/exports/delete",
            json={"file_ids": [outside_file.id]},
        )
        self.assertEqual(unsafe_response.status_code, 400)
        self.assertTrue(outside_path.exists())
        self.assertIsNotNone(storage.get_export_file(int(outside_file.id or 0)))

        empty_response = self.client.post(
            "/api/transcriptions/record-1/exports/delete",
            json={"file_ids": []},
        )
        self.assertEqual(empty_response.status_code, 400)

    @patch("api.ai_service.review_text")
    def test_review_edit_resolves_marker(self, review_text):
        issue = {
            "id": "issue-1",
            "text": "卡芙卡",
            "suggestion": "Kafka",
            "reason": "术语误识别",
            "confidence": 0.95,
            "start": 4,
            "end": 7,
            "resolved": False,
        }
        review_text.return_value = ([issue], {"issues": [issue]})
        created = self.client.post(
            "/api/transcriptions/record-1/ai/review",
            json={"text": "呃，我用卡芙卡。"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        run_id = created.json()["run"]["id"]
        updated = self.client.patch(
            f"/api/transcriptions/record-1/ai/reviews/{run_id}",
            json={"text": "呃，我用 Kafka。", "resolved_issue_ids": ["issue-1"]},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertTrue(updated.json()["run"]["result"]["issues"][0]["resolved"])

    def test_review_manual_result_can_be_saved_and_exported(self):
        review = storage.add_ai_run(
            "record-1",
            stage="review",
            source_text="我用卡芙卡处理消息。",
            result_text="我用卡芙卡处理消息。",
            result={"issues": []},
        )
        saved = self.client.patch(
            f"/api/transcriptions/record-1/ai/reviews/{review.id}",
            json={"text": "我使用 Kafka 处理消息。", "resolved_issue_ids": []},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["run"]["result_text"], "我使用 Kafka 处理消息。")

        exported = self.client.post(
            f"/api/transcriptions/record-1/ai/reviews/{review.id}/exports",
            json={"format": "txt"},
        )
        self.assertEqual(exported.status_code, 200, exported.text)
        payload = exported.json()
        self.assertEqual(payload["export_file"]["format"], "ai-review-txt")
        export_path = Path(payload["export_file"]["absolute_path"])
        self.assertTrue(export_path.exists())
        self.assertEqual(export_path.read_text(encoding="utf-8"), "我使用 Kafka 处理消息。\n")
        self.assertIn(payload["export_file"]["id"], payload["run"]["result"]["export_file_ids"])
        self.assertEqual(payload["record"]["text"], "呃，我用卡芙卡。")

    def test_review_export_validates_format_and_run_ownership(self):
        review = storage.add_ai_run(
            "record-1",
            stage="review",
            source_text="送检内容",
            result_text="已保存内容",
        )
        invalid_format = self.client.post(
            f"/api/transcriptions/record-1/ai/reviews/{review.id}/exports",
            json={"format": "srt"},
        )
        wrong_record = self.client.post(
            f"/api/transcriptions/missing/ai/reviews/{review.id}/exports",
            json={"format": "txt"},
        )

        self.assertEqual(invalid_format.status_code, 400)
        self.assertEqual(wrong_record.status_code, 404)

    @patch("api.ai_service.analyze_text")
    def test_backend_interview_analysis_is_persisted(self, analyze_text):
        analyze_text.return_value = {
            "summary": "事务基础准确，但缺少工程案例。",
            "overall_score": 76,
            "hiring_recommendation": "保留",
            "dimensions": [],
            "questions": [],
            "action_items": ["补充故障处理案例"],
            "uncertainties": [],
        }
        response = self.client.post(
            "/api/transcriptions/record-1/ai/analyze",
            json={"preset": "backend_interview"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        run = response.json()["run"]
        self.assertEqual(run["stage"], "analysis")
        self.assertEqual(run["preset"], "backend_interview")
        self.assertEqual(run["result"]["overall_score"], 76)

    @patch("api.ai_service.analyze_text")
    def test_unanswered_interview_analysis_is_persisted_without_score(self, analyze_text):
        analyze_text.return_value = {
            "summary": "只识别到问题。",
            "overall_score": None,
            "hiring_recommendation": "信息不足",
            "dimensions": [],
            "questions": [
                {
                    "index": 1,
                    "question": "什么是 MVCC？",
                    "has_answer": False,
                    "answer_summary": "未识别到回答",
                    "score": None,
                    "focus_areas": ["并发控制", "版本链"],
                    "strengths": [],
                    "weaknesses": [],
                    "better_answer": "",
                }
            ],
            "action_items": [],
            "uncertainties": ["缺少回答"],
        }
        response = self.client.post(
            "/api/transcriptions/record-1/ai/analyze",
            json={"preset": "backend_interview"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()["run"]["result"]
        self.assertIsNone(result["overall_score"])
        self.assertIsNone(result["questions"][0]["score"])


if __name__ == "__main__":
    unittest.main()
