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
from types import SimpleNamespace
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

    def test_build_player_records_prefers_affiliate_team_club(self) -> None:
        def make_stats(minutes: float) -> dict[str, float]:
            raw: dict[str, float] = defaultdict(float)
            raw["minutes"] = minutes
            raw["starts"] = 10.0
            raw["_rating_sum"] = 70.0
            raw["_rating_apps"] = 10.0
            return raw

        def make_player(**overrides: object) -> SimpleNamespace:
            base = {
                "uid": 1,
                "unique_id": 1001,
                "name": "Test Player",
                "age": 20,
                "height_cm": 185,
                "nation_id": 170,
                "left_foot": 20,
                "right_foot": 10,
                "natural_positions": ("DC",),
                "accomplished_positions": (),
                "club_uid": 1686,
                "club_name": "Atlético de Madrid",
                "club_short_name": "Atlético de Madrid",
                "club_reputation": 8827,
                "team_club_uid": None,
                "team_club_name": None,
                "on_loan": False,
                "loan_parent_club_name": None,
                "transfer_value": 1_000_000,
                "transfer_value_state": "ok",
                "contract": None,
            }
            base.update(overrides)
            return SimpleNamespace(**base)

        clubs_by_uid = {
            1686: SimpleNamespace(
                uid=1686, unique_id=1687, name="Atlético de Madrid", short_name="Atlético de Madrid", nation_id=170, reputation=8827
            ),
            814105: SimpleNamespace(
                uid=814105, unique_id=814344, name="A. Madrid C", short_name="A. Madrid C", nation_id=170, reputation=2350
            ),
            1478: SimpleNamespace(
                uid=1478, unique_id=1478, name="FC Porto", short_name="Porto", nation_id=155, reputation=8000
            ),
            55000308: SimpleNamespace(
                uid=55000308, unique_id=55000308, name="FC Porto B", short_name="Porto B", nation_id=155, reputation=4200
            ),
            999001: SimpleNamespace(
                uid=999001, unique_id=999002, name="Unrated B", short_name="Unrated B", nation_id=170, reputation=None
            ),
        }

        players = {
            10: make_player(
                uid=10,
                unique_id=1010,
                name="Jorge Luis Delgado",
                club_uid=1686,
                team_club_uid=814105,
                team_club_name="A. Madrid C",
            ),
            11: make_player(
                uid=11,
                unique_id=1011,
                name="First Team CB",
                club_uid=1686,
                team_club_uid=None,
                team_club_name=None,
            ),
            12: make_player(
                uid=12,
                unique_id=1012,
                name="Porto B CB",
                club_uid=1478,
                club_name="FC Porto",
                club_short_name="Porto",
                club_reputation=8000,
                team_club_uid=55000308,
                team_club_name="FC Porto B",
            ),
            13: make_player(
                uid=13,
                unique_id=1013,
                name="Unrated Affiliate CB",
                club_uid=1686,
                team_club_uid=999001,
                team_club_name="Unrated B",
            ),
            14: make_player(
                uid=14,
                unique_id=1014,
                name="Free Agent CB",
                club_uid=None,
                club_name=None,
                club_short_name=None,
                club_reputation=None,
                team_club_uid=None,
                team_club_name=None,
            ),
        }

        snapshot = {
            "clubs_by_uid": clubs_by_uid,
            "club_reps": {1686: 8827, 814105: 2350, 1478: 8000, 55000308: 4200},
            "nations_by_id": {170: "Spain", 155: "Portugal"},
            "resolved_leagues": {
                1686: ("LALIGA EA SPORTS", "67"),
                1478: ("Liga Portugal Betclic", "60"),
                55000308: ("Liga Portugal 2 Meu Super", "61"),
            },
            "players_by_uid": players,
            "stats_agg": {uid: make_stats(900.0) for uid in players},
            "managed_uid": "1686",
        }

        pool_records, squad_records, _search_rows, club_catalog = build_moneyball._build_player_records(snapshot)
        by_name = {r["name"]: r for r in pool_records["CB"]}

        delgado = by_name["Jorge Luis Delgado"]
        self.assertEqual(delgado["club"], "A. Madrid C")
        self.assertEqual(delgado["club_uid"], "814105")
        self.assertEqual(delgado["club_img_id"], "814344")
        self.assertEqual(delgado["club_rep"], 2350)
        self.assertEqual(delgado["league"], "Spain (Other)")
        self.assertEqual(delgado["league_id"], "")
        self.assertTrue(delgado["is_hull"])

        first_team = by_name["First Team CB"]
        self.assertEqual(first_team["club"], "Atlético de Madrid")
        self.assertEqual(first_team["club_uid"], "1686")
        self.assertEqual(first_team["club_img_id"], "1687")
        self.assertEqual(first_team["club_rep"], 8827)
        self.assertEqual(first_team["league"], "LALIGA EA SPORTS")
        self.assertEqual(first_team["league_id"], "67")
        self.assertTrue(first_team["is_hull"])

        porto_b = by_name["Porto B CB"]
        self.assertEqual(porto_b["club"], "Porto B")
        self.assertEqual(porto_b["club_uid"], "55000308")
        self.assertEqual(porto_b["club_rep"], 4200)
        self.assertEqual(porto_b["league"], "Liga Portugal 2 Meu Super")
        self.assertEqual(porto_b["league_id"], "61")
        self.assertFalse(porto_b["is_hull"])

        unrated_b = by_name["Unrated Affiliate CB"]
        self.assertEqual(unrated_b["club"], "Unrated B")
        self.assertEqual(unrated_b["club_rep"], 0)

        free_agent = by_name["Free Agent CB"]
        self.assertEqual(free_agent["club"], "Free Agent")
        self.assertEqual(free_agent["club_uid"], "")
        self.assertEqual(free_agent["club_rep"], 0)
        self.assertEqual(free_agent["league"], "Free Agent")

        self.assertEqual(club_catalog["814105"]["club"], "A. Madrid C")
        self.assertEqual(club_catalog["814105"]["league"], "Spain (Other)")
        self.assertEqual(club_catalog["55000308"]["club"], "Porto B")
        self.assertEqual(club_catalog["55000308"]["league"], "Liga Portugal 2 Meu Super")
        self.assertEqual({r["name"] for r in squad_records}, {"Jorge Luis Delgado", "First Team CB", "Unrated Affiliate CB"})

    def test_build_player_records_own_club_reserves_and_youth(self) -> None:
        def make_stats(minutes: float) -> dict[str, float]:
            raw: dict[str, float] = defaultdict(float)
            raw["minutes"] = minutes
            raw["starts"] = 12.0
            raw["_rating_sum"] = 84.0
            raw["_rating_apps"] = 12.0
            return raw

        def make_player(**overrides: object) -> SimpleNamespace:
            base = {
                "uid": 1,
                "unique_id": 1001,
                "name": "Player",
                "age": 20,
                "height_cm": 185,
                "nation_id": 143,
                "left_foot": 10,
                "right_foot": 20,
                "natural_positions": ("STC",),
                "accomplished_positions": (),
                "club_uid": 886,
                "club_name": "Toulouse FC",
                "club_short_name": "Toulouse",
                "club_reputation": 6768,
                "team_id": 686,
                "team_slot": 0,
                "team_club_uid": None,
                "team_club_name": None,
                "on_loan": False,
                "loan_parent_club_name": None,
                "transfer_value": 5000,
                "transfer_value_state": "ok",
                "contract": None,
            }
            base.update(overrides)
            return SimpleNamespace(**base)

        clubs_by_uid = {
            886: SimpleNamespace(uid=886, unique_id=886, name="Toulouse FC", short_name="Toulouse", nation_id=143, reputation=6768),
            1135: SimpleNamespace(uid=1135, unique_id=1135, name="FC Internazionale Milano", short_name="Inter", nation_id=150, reputation=8420),
            665: SimpleNamespace(uid=665, unique_id=665, name="Hull City AFC", short_name="Hull City", nation_id=139, reputation=6782),
        }
        players = {
            1: make_player(uid=1, name="Toulouse First Team", club_uid=886, team_id=686, team_slot=0),
            2: make_player(uid=2, name="Enzo Faty", club_uid=886, team_id=17585, team_slot=1),
            3: make_player(uid=3, name="Toulouse U19 ST", club_uid=886, team_id=35248, team_slot=2),
            4: make_player(
                uid=4,
                name="Inter U23 ST",
                club_uid=1135,
                club_name="FC Internazionale Milano",
                club_short_name="Inter",
                club_reputation=8420,
                team_id=34147,
                team_slot=1,
            ),
            5: make_player(
                uid=5,
                name="Hull U21 ST",
                club_uid=665,
                club_name="Hull City AFC",
                club_short_name="Hull City",
                club_reputation=6782,
                team_id=35041,
                team_slot=1,
            ),
        }
        snapshot = {
            "clubs_by_uid": clubs_by_uid,
            "club_reps": {886: 6768, 1135: 8420, 665: 6782},
            "nations_by_id": {143: "France", 150: "Italy", 139: "England"},
            "resolved_leagues": {886: ("Ligue 1 McDonald's", "16"), 1135: ("Serie A Enilive", "32"), 665: ("Premier League", "11")},
            "resolved_team_leagues": {
                686: ("Ligue 1 McDonald's", "16"),
                35248: ("French Under 19 National - Group D", "9001"),
                34147: ("Serie BKT", "33"),
                35041: ("Premier League 2 Division 2", "9002"),
            },
            "players_by_uid": players,
            "stats_agg": {uid: make_stats(1200.0) for uid in players},
            "managed_uid": "665",
        }

        pool_records, squad_records, _search_rows, club_catalog = build_moneyball._build_player_records(snapshot)
        by_name = {r["name"]: r for r in pool_records["ST"]}

        self.assertEqual(by_name["Toulouse First Team"]["club"], "Toulouse")
        self.assertEqual(by_name["Toulouse First Team"]["club_uid"], "886")
        self.assertEqual(by_name["Toulouse First Team"]["league"], "Ligue 1 McDonald's")
        self.assertEqual(by_name["Toulouse First Team"]["club_rep"], 6768)

        faty = by_name["Enzo Faty"]
        self.assertEqual(faty["club"], "Toulouse 2")
        self.assertEqual(faty["club_uid"], "886:t1")
        self.assertEqual(faty["club_img_id"], "886")
        self.assertEqual(faty["league"], "France (Reserves)")
        self.assertEqual(faty["club_rep"], 0)

        u19 = by_name["Toulouse U19 ST"]
        self.assertEqual(u19["club"], "Toulouse U19")
        self.assertEqual(u19["club_uid"], "886:t2")
        self.assertEqual(u19["league"], "French Under 19 National - Group D")
        self.assertEqual(u19["club_rep"], 0)

        inter_b = by_name["Inter U23 ST"]
        self.assertEqual(inter_b["club"], "Inter II")
        self.assertEqual(inter_b["club_uid"], "1135:t1")
        self.assertEqual(inter_b["league"], "Serie BKT")
        self.assertEqual(inter_b["club_rep"], 0)

        hull_u21 = by_name["Hull U21 ST"]
        self.assertEqual(hull_u21["club"], "Hull City U21")
        self.assertEqual(hull_u21["club_uid"], "665:t1")
        self.assertEqual(hull_u21["league"], "Premier League 2 Division 2")
        self.assertTrue(hull_u21["is_hull"])
        self.assertEqual([r["name"] for r in squad_records], ["Hull U21 ST"])

        self.assertEqual(club_catalog["886"]["club"], "Toulouse")
        self.assertEqual(club_catalog["886:t1"]["club"], "Toulouse 2")
        self.assertEqual(club_catalog["886:t1"]["league"], "France (Reserves)")

    def test_resolve_leagues_from_tables_supports_mixed_slot_senior_leagues(self) -> None:
        clubs = {
            1: SimpleNamespace(uid=1, nation_id=150, gender=SimpleNamespace(raw=0)),
            2: SimpleNamespace(uid=2, nation_id=150, gender=SimpleNamespace(raw=0)),
            3: SimpleNamespace(uid=3, nation_id=150, gender=SimpleNamespace(raw=0)),
            4: SimpleNamespace(uid=4, nation_id=150, gender=SimpleNamespace(raw=0)),
        }
        comps = {
            33: SimpleNamespace(id=33, database_id=33),
            99: SimpleNamespace(id=99, database_id=99),
        }
        serie_b = SimpleNamespace(
            competition_id=33,
            competition_name="Serie BKT",
            club_count=4,
            rows=[
                SimpleNamespace(club_uid=1, team_id=101, team_slot=0, played=30, rounds_per_venue=19),
                SimpleNamespace(club_uid=2, team_id=102, team_slot=0, played=30, rounds_per_venue=19),
                SimpleNamespace(club_uid=3, team_id=103, team_slot=0, played=30, rounds_per_venue=19),
                SimpleNamespace(club_uid=4, team_id=401, team_slot=1, played=30, rounds_per_venue=19),
            ],
        )
        small_cup = SimpleNamespace(
            competition_id=99,
            competition_name="National League Cup",
            club_count=4,
            rows=[
                SimpleNamespace(club_uid=1, team_id=101, team_slot=0, played=4, rounds_per_venue=None),
                SimpleNamespace(club_uid=2, team_id=102, team_slot=0, played=4, rounds_per_venue=None),
                SimpleNamespace(club_uid=3, team_id=301, team_slot=1, played=4, rounds_per_venue=None),
                SimpleNamespace(club_uid=4, team_id=401, team_slot=1, played=4, rounds_per_venue=None),
            ],
        )

        club_leagues, team_leagues = build_moneyball._resolve_leagues_from_tables([small_cup, serie_b], clubs, comps)
        self.assertEqual(club_leagues[1], ("Serie BKT", "33"))
        self.assertNotIn(4, club_leagues)
        self.assertEqual(team_leagues[401], ("Serie BKT", "33"))
        self.assertNotIn(301, team_leagues)


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
