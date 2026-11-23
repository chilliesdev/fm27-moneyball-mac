"""Fast unit tests for build_moneyball and server helpers (no .fm save or browser required)."""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from collections import defaultdict
from datetime import date
from http import HTTPStatus
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCOUTING_DIR = REPO_ROOT / "scouting"
if str(SCOUTING_DIR) not in sys.path:
    sys.path.insert(0, str(SCOUTING_DIR))

import build_moneyball
import server


class BuildMoneyballUnitTests(unittest.TestCase):
    def test_season_key_and_end_year(self) -> None:
        self.assertEqual(build_moneyball.season_key_for_date(date(2027, 8, 15)), "2027-28")
        self.assertEqual(build_moneyball.season_key_for_date(date(2028, 3, 1)), "2027-28")
        self.assertEqual(build_moneyball.season_key_for_date(None), "unknown")

        self.assertEqual(build_moneyball.season_end_year_for(date(2027, 8, 15), "2027-28"), 2028)
        self.assertEqual(build_moneyball.season_end_year_for(None, "2027-28"), 2028)
        self.assertEqual(build_moneyball.season_end_year_for(None, "2027-2028"), 2028)
        self.assertEqual(build_moneyball.season_end_year_for(None, "2029"), 2029)

    def test_compute_metrics_and_zero_guards(self) -> None:
        raw: dict[str, float] = defaultdict(float)
        raw.update(
            {
                "minutes": 900.0,
                "starts": 10.0,
                "substitute_appearances": 2.0,
                "goals": 5.0,
                "assists": 3.0,
                "shots": 20.0,
                "shots_on_target": 10.0,
                "expected_goals": 4.0,
                "passes_attempted": 200.0,
                "passes_completed": 160.0,
                "aerial_challenges_attempted": 10.0,
                "headers_won": 7.0,
                "saves_held": 6.0,
                "saves_parried": 2.0,
                "saves_tipped": 2.0,
                "shots_on_target_faced": 12.0,
                "clean_sheets": 3.0,
                "_rating_sum": 72.0,
                "_rating_apps": 10.0,
            }
        )
        m = build_moneyball._compute_metrics(raw)
        self.assertEqual(m["minutes"], 900)
        self.assertEqual(m["apps"], 12)
        self.assertEqual(m["avg_rating"], 7.2)
        self.assertEqual(m["goals_p90"], 0.5)
        self.assertEqual(m["headers_lost_p90"], 0.3)
        self.assertEqual(m["pass_pct"], 80.0)
        self.assertEqual(m["sot_pct"], 50.0)
        self.assertEqual(m["conversion_pct"], 25.0)
        self.assertEqual(m["xg_per_shot"], 0.2)
        self.assertEqual(m["saves_p90"], 1.0)
        self.assertEqual(m["save_pct"], 83.33)
        self.assertEqual(m["clean_sheet_pct"], 25.0)

        empty: dict[str, float] = defaultdict(float)
        z = build_moneyball._compute_metrics(empty)
        self.assertEqual(z["goals_p90"], 0.0)
        self.assertEqual(z["pass_pct"], 0.0)
        self.assertEqual(z["avg_rating"], 0.0)

    def test_percentile_score(self) -> None:
        vals = [1.0, 2.0, 2.0, 4.0]
        self.assertEqual(build_moneyball._percentile_score([], 5.0, True), 50)
        self.assertEqual(build_moneyball._percentile_score(vals, 1.0, True), 12)
        self.assertEqual(build_moneyball._percentile_score(vals, 2.0, True), 50)
        self.assertEqual(build_moneyball._percentile_score(vals, 4.0, True), 88)
        self.assertEqual(build_moneyball._percentile_score(vals, 4.0, False), 12)

    def test_atomic_write_helpers(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "sub" / "data.json"
            build_moneyball._write_json_atomic(target, {"ok": True, "n": 2})
            self.assertTrue(target.is_file())
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"ok": True, "n": 2})
            self.assertEqual(len(list(target.parent.iterdir())), 1)


class ServerUnitTests(unittest.TestCase):
    def test_parse_config_records_xml_and_fallback(self) -> None:
        xml = b'<record><list id="maps"><record from="100" to="graphics/pictures/person/100/portrait"/></list></record>'
        self.assertEqual(server._parse_config_records(xml), [("100", "graphics/pictures/person/100/portrait")])

        broken = b'<record><record from="200" to="a&amp;b"/></unclosed'
        self.assertEqual(server._parse_config_records(broken), [("200", "a&b")])

    def test_validate_save_path_rejects_outside_and_non_fm(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            games_dir = Path(td) / "games"
            games_dir.mkdir()
            valid_fm = games_dir / "career.fm"
            valid_fm.write_bytes(b"fm")
            bad_txt = games_dir / "notes.txt"
            bad_txt.write_text("hi", encoding="utf-8")

            outside_dir = Path(td) / "outside"
            outside_dir.mkdir()
            outside_fm = outside_dir / "evil.fm"
            outside_fm.write_bytes(b"fm")

            with (
                mock.patch.object(build_moneyball, "DEFAULT_GAMES_DIR", games_dir),
                mock.patch.object(build_moneyball, "list_fm_saves", return_value=[]),
            ):
                self.assertEqual(server._validate_save_path(str(valid_fm)), valid_fm.resolve())
                with self.assertRaises(ValueError):
                    server._validate_save_path(str(bad_txt))
                with self.assertRaises(ValueError):
                    server._validate_save_path(str(outside_fm))
                with self.assertRaises(ValueError):
                    server._validate_save_path(str(games_dir / "missing.fm"))

    def test_trigger_build_async_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            games_dir = Path(td) / "games"
            games_dir.mkdir()
            save_file = games_dir / "test.fm"
            save_file.write_bytes(b"fm")

            fake_meta = {
                "season": "2027-28",
                "in_game_date": "2028-05-01",
                "save_file": "test.fm",
                "club_name": "Test FC",
            }
            with (
                mock.patch.object(build_moneyball, "DEFAULT_GAMES_DIR", games_dir),
                mock.patch.object(build_moneyball, "list_fm_saves", return_value=[]),
                mock.patch.object(build_moneyball, "build_from_save", return_value=fake_meta),
                mock.patch.dict(server._STATE, {"building": False, "last_error": None, "last_built": None}),
            ):
                code, payload = server._trigger_build(str(save_file))
                self.assertEqual(code, HTTPStatus.ACCEPTED)
                self.assertTrue(payload["started"])

                deadline = time.monotonic() + 2.0
                while server._STATE["building"] and time.monotonic() < deadline:
                    time.sleep(0.01)

                self.assertFalse(server._STATE["building"])
                self.assertIsNone(server._STATE["last_error"])
                self.assertEqual(server._STATE["last_built"]["club_name"], "Test FC")


if __name__ == "__main__":
    unittest.main()
