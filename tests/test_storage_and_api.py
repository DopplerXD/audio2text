from __future__ import annotations

import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
