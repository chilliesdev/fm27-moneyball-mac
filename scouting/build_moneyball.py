"""Build progressive season Moneyball CSVs and JSON datasets directly from FM27 .fm saves."""

from __future__ import annotations

import argparse
import bisect
import csv
import json
import os
import re
import shutil
import struct
import warnings
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

try:
    from compression import zstd as _zstd
except ImportError:  # Python < 3.14 fallback
    try:
        from backports import zstd as _zstd  # type: ignore[no-redef]
    except ImportError:
        _zstd = None  # type: ignore[assignment]

import fmsave

ROOT_DIR = Path(__file__).resolve().parent.parent
SCOUTING_DIR = Path(__file__).resolve().parent
SEASONS_DIR = SCOUTING_DIR / "seasons"
APP_DATA_DIR = SCOUTING_DIR / "app" / "data"
DEFAULT_GAMES_DIR = Path.home() / "Library/Application Support/Sports Interactive/Football Manager 27/games"
DEFAULT_FM27_INSTALL_DIR = (
    Path.home() / "Library/Application Support/Steam/steamapps/common/Football Manager 27"
)
USER_LNC_DIR = Path.home() / "Library/Application Support/Sports Interactive/Football Manager 27/lnc"

_FMF_MAGIC = b"\x02\x01fmf."
_TAD_MAGIC = b"\x03\x01tad."
_LNC_LINE_RE = re.compile(
    r'^"(COMP_LONG_NAME_CHANGE|COMP_SHORT_NAME_CHANGE|NATION_LONG_NAME_CHANGE|NATION_SHORT_NAME_CHANGE)"'
    r'\s+(\d+)\s+"([^"]*)"(?:\s+(?:"([^"]*)"|([^\s"#/]+)))?'
)
_SUPPORTED_LNC_LANGS = frozenset({"", "english", "8"})

MIN_MINUTES_DATASET = 450
MIN_MINUTES_BASELINE = 900

POSITION_GROUPS: dict[str, tuple[str, ...]] = {
    "GK": ("GK",),
    "CB": ("DC",),
    "FB_WB": ("DL", "DR", "WBL", "WBR"),
    "DM": ("DM",),
    "CM": ("MC",),
    "AM": ("AMC",),
    "W": ("AML", "AMR", "ML", "MR"),
    "ST": ("STC",),
}

SUM_COUNT_FIELDS: tuple[str, ...] = (
    "starts",
    "substitute_appearances",
    "minutes",
    "rated_appearances",
    "player_of_the_match",
    "goals",
    "assists",
    "expected_goals",
    "non_penalty_expected_goals",
    "expected_assists",
    "shots",
    "shots_on_target",
    "shots_outside_box",
    "free_kick_shots",
    "penalties_taken",
    "penalties_scored",
    "passes_attempted",
    "passes_completed",
    "progressive_passes",
    "key_passes",
    "open_play_key_passes",
    "clear_cut_chances_created",
    "crosses_attempted",
    "crosses_completed",
    "open_play_crosses_attempted",
    "open_play_crosses_completed",
    "dribbles",
    "offsides",
    "distance_km",
    "high_intensity_sprints",
    "aerial_challenges_attempted",
    "headers_won",
    "key_headers",
    "tackles_attempted",
    "tackles_completed",
    "key_tackles",
    "interceptions",
    "possession_won",
    "possession_lost",
    "pressures_attempted",
    "pressures_completed",
    "blocks",
    "shots_blocked",
    "clearances",
    "fouls_made",
    "fouls_against",
    "yellow_cards",
    "red_cards",
    "mistakes_leading_to_goal",
    "clean_sheets",
    "goals_allowed",
    "saves_held",
    "saves_parried",
    "saves_tipped",
    "shots_on_target_faced",
    "expected_goals_prevented",
)

PER90_SOURCE_MAP: dict[str, str] = {
    "potm_p90": "player_of_the_match",
    "goals_p90": "goals",
    "assists_p90": "assists",
    "xg_p90": "expected_goals",
    "npxg_p90": "non_penalty_expected_goals",
    "xa_p90": "expected_assists",
    "shots_p90": "shots",
    "sot_p90": "shots_on_target",
    "shots_outside_box_p90": "shots_outside_box",
    "free_kick_shots_p90": "free_kick_shots",
    "penalties_taken_p90": "penalties_taken",
    "penalties_scored_p90": "penalties_scored",
    "passes_att_p90": "passes_attempted",
    "passes_cmp_p90": "passes_completed",
    "prog_passes_p90": "progressive_passes",
    "key_passes_p90": "key_passes",
    "op_key_passes_p90": "open_play_key_passes",
    "ccc_p90": "clear_cut_chances_created",
    "crosses_att_p90": "crosses_attempted",
    "crosses_cmp_p90": "crosses_completed",
    "op_crosses_att_p90": "open_play_crosses_attempted",
    "op_crosses_cmp_p90": "open_play_crosses_completed",
    "dribbles_p90": "dribbles",
    "offsides_p90": "offsides",
    "distance_p90": "distance_km",
    "sprints_p90": "high_intensity_sprints",
    "aerial_att_p90": "aerial_challenges_attempted",
    "headers_won_p90": "headers_won",
    "key_headers_p90": "key_headers",
    "tackles_att_p90": "tackles_attempted",
    "tackles_cmp_p90": "tackles_completed",
    "key_tackles_p90": "key_tackles",
    "interceptions_p90": "interceptions",
    "poss_won_p90": "possession_won",
    "poss_lost_p90": "possession_lost",
    "pressures_cmp_p90": "pressures_completed",
    "blocks_p90": "blocks",
    "shots_blocked_p90": "shots_blocked",
    "clearances_p90": "clearances",
    "fouls_made_p90": "fouls_made",
    "fouls_against_p90": "fouls_against",
    "yellow_cards_p90": "yellow_cards",
    "red_cards_p90": "red_cards",
    "mistakes_p90": "mistakes_leading_to_goal",
    "saves_held_p90": "saves_held",
    "saves_parried_p90": "saves_parried",
    "saves_tipped_p90": "saves_tipped",
    "sot_faced_p90": "shots_on_target_faced",
    "goals_allowed_p90": "goals_allowed",
    "xg_prevented_p90": "expected_goals_prevented",
}

ALL_METRICS_CATALOG: tuple[tuple[str, str, bool, str], ...] = (
    # Summary
    ("avg_rating", "Avg Rating", True, "Summary"),
    ("minutes", "Minutes", True, "Summary"),
    ("starts", "Starts", True, "Summary"),
    ("apps", "Appearances", True, "Summary"),
    ("goals", "Goals", True, "Summary"),
    ("assists", "Assists", True, "Summary"),
    ("potm_p90", "Player of the Match / 90", True, "Summary"),
    # Attacking
    ("goals_p90", "Goals / 90", True, "Attacking"),
    ("npxg_p90", "np-xG / 90", True, "Attacking"),
    ("xg_p90", "xG / 90", True, "Attacking"),
    ("shots_p90", "Shots / 90", True, "Attacking"),
    ("sot_p90", "Shots on Target / 90", True, "Attacking"),
    ("sot_pct", "Shot Accuracy %", True, "Attacking"),
    ("conversion_pct", "Conversion %", True, "Attacking"),
    ("xg_per_shot", "xG / Shot", True, "Attacking"),
    ("shots_outside_box_p90", "Shots Outside Box / 90", True, "Attacking"),
    ("free_kick_shots_p90", "Free Kick Shots / 90", True, "Attacking"),
    ("penalties_taken_p90", "Penalties Taken / 90", True, "Attacking"),
    ("penalties_scored_p90", "Penalties Scored / 90", True, "Attacking"),
    ("penalty_pct", "Penalty %", True, "Attacking"),
    ("dribbles_p90", "Dribbles / 90", True, "Attacking"),
    ("offsides_p90", "Offsides / 90", False, "Attacking"),
    ("fouls_against_p90", "Fouls Won / 90", True, "Attacking"),
    # Passing & Creation
    ("assists_p90", "Assists / 90", True, "Passing & Creation"),
    ("xa_p90", "xA / 90", True, "Passing & Creation"),
    ("key_passes_p90", "Key Passes / 90", True, "Passing & Creation"),
    ("op_key_passes_p90", "OP Key Passes / 90", True, "Passing & Creation"),
    ("ccc_p90", "Chances Created / 90", True, "Passing & Creation"),
    ("passes_att_p90", "Passes Att / 90", True, "Passing & Creation"),
    ("passes_cmp_p90", "Passes Cmp / 90", True, "Passing & Creation"),
    ("pass_pct", "Pass %", True, "Passing & Creation"),
    ("prog_passes_p90", "Prog Passes / 90", True, "Passing & Creation"),
    ("crosses_att_p90", "Crosses Att / 90", True, "Passing & Creation"),
    ("crosses_cmp_p90", "Crosses Cmp / 90", True, "Passing & Creation"),
    ("cross_pct", "Cross %", True, "Passing & Creation"),
    ("op_crosses_att_p90", "OP Crosses Att / 90", True, "Passing & Creation"),
    ("op_crosses_cmp_p90", "OP Crosses / 90", True, "Passing & Creation"),
    ("op_cross_pct", "OP Cross %", True, "Passing & Creation"),
    # Defending & Aerial
    ("tackles_att_p90", "Tackles Att / 90", True, "Defending & Aerial"),
    ("tackles_cmp_p90", "Tackles / 90", True, "Defending & Aerial"),
    ("tackle_pct", "Tackle %", True, "Defending & Aerial"),
    ("key_tackles_p90", "Key Tackles / 90", True, "Defending & Aerial"),
    ("interceptions_p90", "Interceptions / 90", True, "Defending & Aerial"),
    ("poss_won_p90", "Poss Won / 90", True, "Defending & Aerial"),
    ("poss_lost_p90", "Poss Lost / 90", False, "Defending & Aerial"),
    ("pressures_cmp_p90", "Pressures / 90", True, "Defending & Aerial"),
    ("blocks_p90", "Blocks / 90", True, "Defending & Aerial"),
    ("shots_blocked_p90", "Shots Blocked / 90", True, "Defending & Aerial"),
    ("clearances_p90", "Clearances / 90", True, "Defending & Aerial"),
    ("aerial_att_p90", "Aerials Att / 90", True, "Defending & Aerial"),
    ("headers_won_p90", "Headers Won / 90", True, "Defending & Aerial"),
    ("headers_lost_p90", "Headers Lost / 90", False, "Defending & Aerial"),
    ("headers_won_pct", "Headers Won %", True, "Defending & Aerial"),
    ("key_headers_p90", "Key Headers / 90", True, "Defending & Aerial"),
    ("fouls_made_p90", "Fouls Made / 90", False, "Defending & Aerial"),
    ("yellow_cards_p90", "Yellow Cards / 90", False, "Defending & Aerial"),
    ("red_cards_p90", "Red Cards / 90", False, "Defending & Aerial"),
    ("mistakes_p90", "Mistakes / 90", False, "Defending & Aerial"),
    # Physical
    ("distance_p90", "Distance km / 90", True, "Physical"),
    ("sprints_p90", "Sprints / 90", True, "Physical"),
    # Goalkeeping
    ("xg_prevented_p90", "xG Prevented / 90", True, "Goalkeeping"),
    ("save_pct", "Save %", True, "Goalkeeping"),
    ("saves_p90", "Saves / 90", True, "Goalkeeping"),
    ("saves_held_p90", "Saves Held / 90", True, "Goalkeeping"),
    ("saves_parried_p90", "Saves Parried / 90", True, "Goalkeeping"),
    ("saves_tipped_p90", "Saves Tipped / 90", True, "Goalkeeping"),
    ("sot_faced_p90", "Shots Faced / 90", False, "Goalkeeping"),
    ("goals_allowed_p90", "Goals Allowed / 90", False, "Goalkeeping"),
    ("clean_sheet_pct", "Clean Sheet %", True, "Goalkeeping"),
)

POSITION_METRICS: dict[str, list[tuple[str, str, bool]]] = {
    "GK": [
        ("xg_prevented_p90", "xG Prevented / 90", True),
        ("save_pct", "Save %", True),
        ("goals_allowed_p90", "Goals Allowed / 90", False),
        ("pass_pct", "Pass %", True),
        ("passes_cmp_p90", "Passes Cmp / 90", True),
        ("clean_sheet_pct", "Clean Sheet %", True),
        ("avg_rating", "Avg Rating", True),
        ("poss_lost_p90", "Poss Lost / 90", False),
    ],
    "CB": [
        ("headers_won_pct", "Headers Won %", True),
        ("headers_won_p90", "Headers Won / 90", True),
        ("tackles_cmp_p90", "Tackles / 90", True),
        ("tackle_pct", "Tackle %", True),
        ("interceptions_p90", "Interceptions / 90", True),
        ("clearances_p90", "Clearances / 90", True),
        ("blocks_p90", "Blocks / 90", True),
        ("poss_won_p90", "Poss Won / 90", True),
        ("prog_passes_p90", "Prog Passes / 90", True),
        ("pass_pct", "Pass %", True),
    ],
    "FB_WB": [
        ("tackles_cmp_p90", "Tackles / 90", True),
        ("tackle_pct", "Tackle %", True),
        ("interceptions_p90", "Interceptions / 90", True),
        ("poss_won_p90", "Poss Won / 90", True),
        ("pressures_cmp_p90", "Pressures / 90", True),
        ("prog_passes_p90", "Prog Passes / 90", True),
        ("op_crosses_cmp_p90", "OP Crosses / 90", True),
        ("xa_p90", "xA / 90", True),
        ("op_key_passes_p90", "OP Key Passes / 90", True),
        ("dribbles_p90", "Dribbles / 90", True),
    ],
    "DM": [
        ("tackles_cmp_p90", "Tackles / 90", True),
        ("tackle_pct", "Tackle %", True),
        ("interceptions_p90", "Interceptions / 90", True),
        ("poss_won_p90", "Poss Won / 90", True),
        ("pressures_cmp_p90", "Pressures / 90", True),
        ("headers_won_pct", "Headers Won %", True),
        ("prog_passes_p90", "Prog Passes / 90", True),
        ("passes_cmp_p90", "Passes Cmp / 90", True),
        ("pass_pct", "Pass %", True),
        ("op_key_passes_p90", "OP Key Passes / 90", True),
    ],
    "CM": [
        ("prog_passes_p90", "Prog Passes / 90", True),
        ("passes_cmp_p90", "Passes Cmp / 90", True),
        ("pass_pct", "Pass %", True),
        ("op_key_passes_p90", "OP Key Passes / 90", True),
        ("xa_p90", "xA / 90", True),
        ("npxg_p90", "np-xG / 90", True),
        ("tackles_cmp_p90", "Tackles / 90", True),
        ("interceptions_p90", "Interceptions / 90", True),
        ("pressures_cmp_p90", "Pressures / 90", True),
        ("sprints_p90", "Sprints / 90", True),
    ],
    "AM": [
        ("npxg_p90", "np-xG / 90", True),
        ("goals_p90", "Goals / 90", True),
        ("xa_p90", "xA / 90", True),
        ("op_key_passes_p90", "OP Key Passes / 90", True),
        ("ccc_p90", "Chances Created / 90", True),
        ("prog_passes_p90", "Prog Passes / 90", True),
        ("sot_p90", "Shots on Target / 90", True),
        ("dribbles_p90", "Dribbles / 90", True),
        ("pressures_cmp_p90", "Pressures / 90", True),
        ("pass_pct", "Pass %", True),
    ],
    "W": [
        ("npxg_p90", "np-xG / 90", True),
        ("goals_p90", "Goals / 90", True),
        ("xa_p90", "xA / 90", True),
        ("op_key_passes_p90", "OP Key Passes / 90", True),
        ("ccc_p90", "Chances Created / 90", True),
        ("op_crosses_cmp_p90", "OP Crosses / 90", True),
        ("sot_p90", "Shots on Target / 90", True),
        ("dribbles_p90", "Dribbles / 90", True),
        ("sprints_p90", "Sprints / 90", True),
        ("pressures_cmp_p90", "Pressures / 90", True),
    ],
    "ST": [
        ("npxg_p90", "np-xG / 90", True),
        ("goals_p90", "Goals / 90", True),
        ("sot_p90", "Shots on Target / 90", True),
        ("conversion_pct", "Conversion %", True),
        ("xg_per_shot", "xG / Shot", True),
        ("xa_p90", "xA / 90", True),
        ("op_key_passes_p90", "OP Key Passes / 90", True),
        ("dribbles_p90", "Dribbles / 90", True),
        ("headers_won_p90", "Headers Won / 90", True),
        ("pressures_cmp_p90", "Pressures / 90", True),
    ],
}

ROLE_PROFILES: dict[str, dict[str, list[str]]] = {
    "GK": {
        "Shot Stopper": ["xg_prevented_p90", "save_pct", "goals_allowed_p90", "clean_sheet_pct"],
        "Sweeper Keeper": ["pass_pct", "passes_cmp_p90", "xg_prevented_p90", "poss_lost_p90"],
    },
    "CB": {
        "Stopper": ["headers_won_pct", "headers_won_p90", "tackles_cmp_p90", "clearances_p90", "blocks_p90"],
        "Ball-Playing": ["prog_passes_p90", "pass_pct", "interceptions_p90", "poss_won_p90"],
    },
    "FB_WB": {
        "Attacking WB": ["op_crosses_cmp_p90", "xa_p90", "op_key_passes_p90", "prog_passes_p90", "dribbles_p90"],
        "Defensive FB": ["tackles_cmp_p90", "tackle_pct", "interceptions_p90", "poss_won_p90", "pressures_cmp_p90"],
    },
    "DM": {
        "Destroyer": ["tackles_cmp_p90", "tackle_pct", "interceptions_p90", "poss_won_p90", "pressures_cmp_p90"],
        "Deep Playmaker": ["prog_passes_p90", "passes_cmp_p90", "pass_pct", "op_key_passes_p90"],
    },
    "CM": {
        "Controller": ["prog_passes_p90", "passes_cmp_p90", "pass_pct", "op_key_passes_p90", "xa_p90"],
        "Box-to-Box": ["npxg_p90", "xa_p90", "tackles_cmp_p90", "pressures_cmp_p90", "sprints_p90"],
    },
    "AM": {
        "Creator": ["xa_p90", "op_key_passes_p90", "ccc_p90", "prog_passes_p90", "pass_pct"],
        "Shadow Striker": ["npxg_p90", "goals_p90", "sot_p90", "dribbles_p90", "pressures_cmp_p90"],
    },
    "W": {
        "Inside Forward": ["npxg_p90", "goals_p90", "sot_p90", "dribbles_p90", "sprints_p90"],
        "Wide Creator": ["xa_p90", "op_key_passes_p90", "ccc_p90", "op_crosses_cmp_p90", "dribbles_p90"],
    },
    "ST": {
        "Finisher": ["npxg_p90", "goals_p90", "sot_p90", "conversion_pct", "xg_per_shot"],
        "Complete Forward": ["npxg_p90", "xa_p90", "op_key_passes_p90", "headers_won_p90", "pressures_cmp_p90"],
    },
}


def list_fm_saves(games_dir: Path = DEFAULT_GAMES_DIR) -> list[dict[str, Any]]:
    """Return non-backup .fm saves sorted newest-first."""
    if not games_dir.exists():
        return []
    saves: list[dict[str, Any]] = []
    for path in games_dir.glob("*.fm"):
        name_lower = path.name.lower()
        if "last save overwrite backup" in name_lower or name_lower.startswith("._"):
            continue
        stat = path.stat()
        saves.append(
            {
                "name": path.name,
                "path": str(path),
                "mtime": stat.st_mtime,
                "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
                "size_mb": round(stat.st_size / (1024 * 1024), 1),
            }
        )
    saves.sort(key=lambda item: float(item["mtime"]), reverse=True)
    return saves


def pick_latest_save(games_dir: Path = DEFAULT_GAMES_DIR) -> Path:
    saves = list_fm_saves(games_dir)
    if not saves:
        raise FileNotFoundError(f"No .fm save files found in {games_dir}")
    return Path(saves[0]["path"])


def season_key_for_date(game_date: Any) -> str:
    if game_date is None:
        return "unknown"
    year = int(game_date.year)
    month = int(game_date.month)
    start_year = year if month >= 7 else year - 1
    end_short = str((start_year + 1) % 100).zfill(2)
    return f"{start_year}-{end_short}"


def season_end_year_for(game_date: Any, season_key: str) -> int:
    if game_date is not None:
        year = int(game_date.year)
        month = int(game_date.month)
        start_year = year if month >= 7 else year - 1
        return start_year + 1
    if m := re.match(r"^(\d{4})-(\d{2})$", season_key):
        return int(m.group(1)) + 1
    if m := re.match(r"^(\d{4})-(\d{4})$", season_key):
        return int(m.group(2))
    if m := re.match(r"^(\d{4})$", season_key):
        return int(m.group(1))
    return datetime.now().year


def _find_lang_db_in_ver(ver_dir: Path) -> Path | None:
    if not ver_dir.is_dir() or not ver_dir.name.isdigit():
        return None
    fm_dir = ver_dir / f"{ver_dir.name}_fm"
    for fname in ("lang_db.dat", "lang_update_db.dat"):
        cand = fm_dir / fname
        if cand.is_file():
            return cand
    return None


def _resolve_fm27_lang_db() -> tuple[Path | None, Path | None]:
    env_db = os.environ.get("FM27_DB_DIR", "").strip()
    env_install = os.environ.get("FM27_INSTALL_DIR", "").strip()
    if env_db:
        base = Path(env_db).expanduser()
    elif env_install:
        base = Path(env_install).expanduser()
    else:
        base = DEFAULT_FM27_INSTALL_DIR

    if not base.exists():
        return None, None
    if base.is_file() and base.name in ("lang_db.dat", "lang_update_db.dat"):
        ver_dir = base.parent.parent if base.parent.name.endswith("_fm") else None
        return ver_dir, base

    if (direct := _find_lang_db_in_ver(base)) is not None:
        return base, direct

    candidates = (
        base / "fm.app/Contents/PlugIns/game_plugin.bundle/Contents/Resources/shared/data/database/db",
        base / "Contents/PlugIns/game_plugin.bundle/Contents/Resources/shared/data/database/db",
        base / "shared/data/database/db",
        base / "database/db",
        base,
    )
    for db_root in candidates:
        if not db_root.is_dir():
            continue
        ver_dirs = sorted(
            (d for d in db_root.iterdir() if d.is_dir() and d.name.isdigit()),
            key=lambda d: int(d.name),
            reverse=True,
        )
        for ver_dir in ver_dirs:
            lang_db = _find_lang_db_in_ver(ver_dir)
            if lang_db is not None:
                return ver_dir, lang_db
    return None, None


def _read_tad_string(buf: bytes, pos: int, has_tag: bool) -> tuple[str, int]:
    length = struct.unpack_from("<I", buf, pos)[0]
    pos += 4
    text = buf[pos : pos + length].decode("utf-8", errors="replace")
    pos += length
    if has_tag:
        pos += 1
    return text, pos


def _read_lang_db_entries(lang_db_path: Path) -> tuple[dict[int, list[str]], dict[int, list[str]]]:
    if _zstd is None:
        return {}, {}

    with lang_db_path.open("rb") as fh:
        head = fh.read(64)
        base = head.find(_FMF_MAGIC)
        if base < 0 or base + 17 > len(head):
            return {}, {}

        trailer_rel = struct.unpack_from("<Q", head, base + 9)[0]
        trailer_off = base + 9 + trailer_rel

        fh.seek(trailer_off)
        trailer_hdr = fh.read(9)
        if len(trailer_hdr) < 9 or trailer_hdr[:6] != _FMF_MAGIC:
            return {}, {}

        trailer_payload = _zstd.decompress(fh.read())
        if len(trailer_payload) < 8:
            return {}, {}

        save_name_len = struct.unpack_from("<I", trailer_payload, 0)[0]
        pos = 4 + save_name_len + 4

        targets: dict[str, tuple[int, int, int]] = {}
        while pos + 4 <= len(trailer_payload):
            name_len = struct.unpack_from("<I", trailer_payload, pos)[0]
            if name_len == 0 or name_len > 256:
                break
            pos += 4
            if pos + name_len + 4 > len(trailer_payload):
                break
            name = trailer_payload[pos : pos + name_len].decode("ascii", errors="replace")
            pos += name_len
            ext_len = struct.unpack_from("<I", trailer_payload, pos)[0]
            pos += 4
            if ext_len > 64 or pos + ext_len + 40 > len(trailer_payload):
                break
            ext = trailer_payload[pos : pos + ext_len].decode("ascii", errors="replace")
            pos += ext_len
            rel_off, csize, dsize, _t1, _t2 = struct.unpack_from("<5Q", trailer_payload, pos)
            pos += 40
            if ext:
                full_name = f"{name}{ext}" if ext.startswith(".") else f"{name}.{ext}"
            else:
                full_name = name
            if full_name in ("8_9.dat", "8_25.dat"):
                targets[full_name] = (rel_off, csize, dsize)
                if len(targets) == 2:
                    break

        nations: dict[int, list[str]] = {}
        comps: dict[int, list[str]] = {}

        if "8_9.dat" in targets:
            rel_off, csize, _dsize = targets["8_9.dat"]
            fh.seek(base + 26 + rel_off)
            raw = _zstd.decompress(fh.read(csize))
            if len(raw) >= 12 and raw[:6] == _TAD_MAGIC:
                count = struct.unpack_from("<I", raw, 8)[0]
                cur = 12
                for _ in range(count):
                    if cur + 4 > len(raw):
                        break
                    db_id = struct.unpack_from("<I", raw, cur)[0]
                    cur += 4
                    long_name, cur = _read_tad_string(raw, cur, has_tag=True)
                    short_name, cur = _read_tad_string(raw, cur, has_tag=True)
                    _code3, cur = _read_tad_string(raw, cur, has_tag=False)
                    _adj, cur = _read_tad_string(raw, cur, has_tag=True)
                    nations[db_id] = [long_name, short_name]

        if "8_25.dat" in targets:
            rel_off, csize, _dsize = targets["8_25.dat"]
            fh.seek(base + 26 + rel_off)
            raw = _zstd.decompress(fh.read(csize))
            if len(raw) >= 12 and raw[:6] == _TAD_MAGIC:
                count = struct.unpack_from("<I", raw, 8)[0]
                cur = 12
                for _ in range(count):
                    if cur + 4 > len(raw):
                        break
                    db_id = struct.unpack_from("<I", raw, cur)[0]
                    cur += 4
                    long_name, cur = _read_tad_string(raw, cur, has_tag=True)
                    short_name, cur = _read_tad_string(raw, cur, has_tag=True)
                    _code3, cur = _read_tad_string(raw, cur, has_tag=True)
                    comps[db_id] = [long_name, short_name]

    return comps, nations


def _decode_lnc_bytes(raw: bytes) -> str:
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", errors="replace")
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig", errors="replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1", errors="replace")


def _apply_lnc_dir(
    lnc_dir: Path,
    comps: dict[int, list[str]],
    nations: dict[int, list[str]],
) -> None:
    if not lnc_dir.is_dir():
        return
    lnc_files = sorted(
        (p for p in lnc_dir.glob("*.lnc") if p.is_file() and not p.name.startswith("._")),
        key=lambda p: p.name.lower(),
    )
    for path in lnc_files:
        try:
            text = _decode_lnc_bytes(path.read_bytes())
        except OSError:
            continue
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped.startswith('"'):
                continue
            match = _LNC_LINE_RE.match(stripped)
            if not match:
                continue
            directive, id_str, val, lang_q, lang_u = match.groups()
            lang = (lang_q if lang_q is not None else (lang_u or "")).strip().lower()
            if lang not in _SUPPORTED_LNC_LANGS:
                continue
            cleaned_val = val.strip()
            if not cleaned_val:
                continue
            db_id = int(id_str)
            target = comps if directive.startswith("COMP_") else nations
            slot = 0 if directive.endswith("_LONG_NAME_CHANGE") else 1
            pair = target.setdefault(db_id, ["", ""])
            pair[slot] = cleaned_val


def load_fm27_names() -> tuple[dict[int, str], dict[int, str]]:
    """Load competition and nation names from FM27's lang_db.dat + .lnc overrides."""
    try:
        ver_dir, lang_db_path = _resolve_fm27_lang_db()
        if lang_db_path is None:
            return {}, {}
        comps, nations = _read_lang_db_entries(lang_db_path)
        if ver_dir is not None:
            _apply_lnc_dir(ver_dir / "lnc" / "all", comps, nations)
        _apply_lnc_dir(USER_LNC_DIR / "all", comps, nations)
        _apply_lnc_dir(USER_LNC_DIR, comps, nations)
    except Exception:
        return {}, {}

    comp_names = {
        db_id: (pair[0].strip() or pair[1].strip())
        for db_id, pair in comps.items()
        if isinstance(db_id, int) and not isinstance(db_id, bool) and (pair[0].strip() or pair[1].strip())
    }
    nation_names = {
        db_id: (pair[0].strip() or pair[1].strip())
        for db_id, pair in nations.items()
        if isinstance(db_id, int) and not isinstance(db_id, bool) and (pair[0].strip() or pair[1].strip())
    }
    return comp_names, nation_names


def _is_women_club(club: Any) -> bool:
    if club is None or club.gender is None:
        return False
    return getattr(club.gender, "raw", 0) == 1


def _resolve_club_leagues(
    tables: Iterable[Any],
    clubs_by_uid: Mapping[int, Any],
    comps_by_id: Mapping[int, Any],
) -> dict[int, tuple[str, str]]:
    best_score: dict[int, tuple[int, int, int]] = {}
    resolved: dict[int, tuple[str, str]] = {}
    for table in tables:
        if table.competition_id is None or not table.competition_name or not table.rows:
            continue
        if not all(row.team_slot == 0 for row in table.rows):
            continue
        nat_counts: Counter[int] = Counter()
        for row in table.rows:
            club = clubs_by_uid.get(row.club_uid) if row.club_uid is not None else None
            if club is not None and not _is_women_club(club) and club.nation_id is not None:
                nat_counts[club.nation_id] += 1
        if not nat_counts:
            continue
        dom_nat, dom_cnt = nat_counts.most_common(1)[0]
        if dom_cnt <= len(table.rows) / 2.0:
            continue
        has_rounds = 1 if any(row.rounds_per_venue is not None for row in table.rows) else 0
        comp = comps_by_id.get(table.competition_id)
        league_id = str(comp.database_id) if (comp and comp.database_id is not None) else ""
        club_count = int(table.club_count or len(table.rows))
        for row in table.rows:
            if row.club_uid is None:
                continue
            club = clubs_by_uid.get(row.club_uid)
            if club is None or _is_women_club(club) or club.nation_id != dom_nat:
                continue
            score = (club_count, has_rounds, int(row.played or 0))
            if row.club_uid not in best_score or score > best_score[row.club_uid]:
                best_score[row.club_uid] = score
                resolved[row.club_uid] = (table.competition_name, league_id)
    return resolved


def _safe_pct(num: float, den: float) -> float:
    return round((num / den) * 100.0, 2) if den > 0 else 0.0


def _compute_metrics(raw: dict[str, float]) -> dict[str, float]:
    mins = raw["minutes"]
    nineties = mins / 90.0 if mins > 0 else 0.0
    m: dict[str, float] = {
        "minutes": int(round(mins)),
        "starts": int(round(raw["starts"])),
        "apps": int(round(raw["starts"] + raw["substitute_appearances"])),
        "goals": int(round(raw["goals"])),
        "assists": int(round(raw["assists"])),
        "avg_rating": round(raw["_rating_sum"] / raw["_rating_apps"], 2) if raw["_rating_apps"] > 0 else 0.0,
    }
    for out_key, src_key in PER90_SOURCE_MAP.items():
        m[out_key] = round(raw[src_key] / nineties, 3) if nineties > 0 else 0.0

    headers_lost = max(0.0, raw["aerial_challenges_attempted"] - raw["headers_won"])
    m["headers_lost_p90"] = round(headers_lost / nineties, 3) if nineties > 0 else 0.0

    saves_total = raw["saves_held"] + raw["saves_parried"] + raw["saves_tipped"]
    m["saves_p90"] = round(saves_total / nineties, 3) if nineties > 0 else 0.0

    m["pass_pct"] = _safe_pct(raw["passes_completed"], raw["passes_attempted"])
    m["tackle_pct"] = _safe_pct(raw["tackles_completed"], raw["tackles_attempted"])
    m["headers_won_pct"] = _safe_pct(raw["headers_won"], raw["aerial_challenges_attempted"])
    m["sot_pct"] = _safe_pct(raw["shots_on_target"], raw["shots"])
    m["conversion_pct"] = _safe_pct(raw["goals"], raw["shots"])
    m["xg_per_shot"] = round(raw["expected_goals"] / raw["shots"], 3) if raw["shots"] > 0 else 0.0
    m["cross_pct"] = _safe_pct(raw["crosses_completed"], raw["crosses_attempted"])
    m["op_cross_pct"] = _safe_pct(raw["open_play_crosses_completed"], raw["open_play_crosses_attempted"])
    m["penalty_pct"] = _safe_pct(raw["penalties_scored"], raw["penalties_taken"])

    m["save_pct"] = _safe_pct(saves_total, raw["shots_on_target_faced"])
    apps_total = raw["starts"] + raw["substitute_appearances"]
    m["clean_sheet_pct"] = _safe_pct(raw["clean_sheets"], apps_total)
    return m


def _materialize_all_metrics(records: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    rec_list = list(records)
    catalog: list[dict[str, Any]] = []
    for key, label, higher_is_better, category in ALL_METRICS_CATALOG:
        if rec_list and not any(float(r.get(key) or 0.0) != 0.0 for r in rec_list):
            continue
        catalog.append(
            {
                "key": key,
                "label": label,
                "higher_is_better": higher_is_better,
                "category": category,
            }
        )
    return catalog


def _player_groups(natural_positions: tuple[str, ...]) -> list[str]:
    tokens = set(natural_positions)
    return [group for group, group_tokens in POSITION_GROUPS.items() if tokens.intersection(group_tokens)]


def _percentile_score(sorted_vals: list[float], val: float, higher_is_better: bool) -> int:
    if not sorted_vals:
        return 50
    idx_left = bisect.bisect_left(sorted_vals, val)
    idx_right = bisect.bisect_right(sorted_vals, val)
    mid_rank = (idx_left + idx_right) / 2.0
    pct = (mid_rank / len(sorted_vals)) * 100.0
    if not higher_is_better:
        pct = 100.0 - pct
    return max(0, min(100, int(round(pct))))


def _load_seasons_index() -> dict[str, Any]:
    idx_path = SEASONS_DIR / "index.json"
    if not idx_path.exists():
        return {"latest_season": None, "seasons": []}
    try:
        return json.loads(idx_path.read_text(encoding="utf-8"))
    except Exception:
        return {"latest_season": None, "seasons": []}


def build_from_save(save_path: Path) -> dict[str, Any]:
    """Read a .fm save directly, archive its season snapshot, and update latest app data."""
    save_path = Path(save_path).expanduser().resolve()
    if not save_path.exists():
        raise FileNotFoundError(f"Save file not found: {save_path}")

    save_stat = save_path.stat()
    warnings.simplefilter("ignore")
    comp_names, nation_names = load_fm27_names()

    with fmsave.open(save_path, competition_names=comp_names or None) as career_save:
        info = career_save.info
        game_date = info.game_date
        game_date_str = game_date.isoformat() if game_date else ""
        season_key = season_key_for_date(game_date)
        season_end_year = season_end_year_for(game_date, season_key)

        managed_list = list(career_save.managed_clubs())
        managed = managed_list[0] if managed_list else None
        managed_uid = str(managed.club_uid) if managed else ""
        managed_name = managed.club_name if managed else "Unknown Club"
        managed_short = managed.club_short_name if managed else managed_name

        clubs_by_uid = {c.uid: c for c in career_save.clubs()}
        managed_club_obj = clubs_by_uid.get(managed.club_uid) if managed else None
        managed_rep = (managed_club_obj.reputation or 0) if managed_club_obj else 0
        managed_club_img_id = (
            str(
                managed_club_obj.unique_id
                if (managed_club_obj and managed_club_obj.unique_id is not None)
                else managed_uid
            )
            if managed_uid
            else ""
        )

        nations_by_id = {
            n.nation_id: nation_names.get(n.database_id, "")
            for n in career_save.nations()
        }
        comps_by_id = {c.id: c for c in career_save.competitions()}
        resolved_leagues = _resolve_club_leagues(
            career_save.league_tables(), clubs_by_uid, comps_by_id
        )

        players_by_uid: dict[int, Any] = {}
        for pl in career_save.players():
            if _is_women_club(clubs_by_uid.get(pl.club_uid)):
                continue
            players_by_uid[pl.uid] = pl

        stats_agg: dict[int, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        for st in career_save.player_season_stats():
            kind_str = str(getattr(st.kind, "value", st.kind))
            if kind_str != "league":
                continue
            if _is_women_club(clubs_by_uid.get(st.club_uid)):
                continue
            mins = float(st.minutes or 0)
            if mins <= 0:
                continue
            bucket = stats_agg[st.player_uid]
            for field in SUM_COUNT_FIELDS:
                val = getattr(st, field, 0)
                bucket[field] += float(val or 0)
            rated = float(st.rated_appearances or 0)
            avg = float(st.average_rating or 0)
            if rated > 0 and avg > 0:
                bucket["_rating_sum"] += avg * rated
                bucket["_rating_apps"] += rated

    season_dir = SEASONS_DIR / season_key
    csv_dir = season_dir / "csv"
    data_dir = season_dir / "data"
    csv_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)

    pool_records: dict[str, list[dict[str, Any]]] = {group: [] for group in POSITION_GROUPS}
    squad_records: list[dict[str, Any]] = []

    for uid, raw_stats in stats_agg.items():
        if raw_stats["minutes"] < MIN_MINUTES_DATASET:
            continue
        pl = players_by_uid.get(uid)
        if pl is None:
            continue
        groups = _player_groups(pl.natural_positions or ())
        if not groups:
            continue

        metrics = _compute_metrics(raw_stats)
        contract = pl.contract
        squad_status = ""
        if contract and contract.squad_status:
            squad_status = str(getattr(contract.squad_status, "label", contract.squad_status))

        club_uid_str = str(pl.club_uid) if pl.club_uid is not None else ""
        club_obj = clubs_by_uid.get(pl.club_uid) if pl.club_uid is not None else None
        is_managed = bool(managed_uid and club_uid_str == managed_uid)

        img_id = str(pl.unique_id if pl.unique_id is not None else pl.uid)
        club_img_id = (
            str(
                club_obj.unique_id
                if (club_obj and club_obj.unique_id is not None)
                else club_uid_str
            )
            if club_uid_str
            else ""
        )
        nation = nations_by_id.get(pl.nation_id, "") if pl.nation_id is not None else ""
        left_foot = int(pl.left_foot) if pl.left_foot is not None else 10
        right_foot = int(pl.right_foot) if pl.right_foot is not None else 10
        foot = (
            "Both"
            if (left_foot >= 15 and right_foot >= 15)
            else ("Left" if left_foot > right_foot else "Right")
        )

        if pl.club_uid is None:
            league, league_id = "Free Agent", ""
        elif pl.club_uid in resolved_leagues:
            league, league_id = resolved_leagues[pl.club_uid]
        else:
            club_nation = (
                nations_by_id.get(club_obj.nation_id, "")
                if (club_obj and club_obj.nation_id is not None)
                else ""
            )
            league = f"{club_nation} (Other)" if club_nation else "Other"
            league_id = ""

        base_record: dict[str, Any] = {
            "uid": str(uid),
            "img_id": img_id,
            "name": pl.name,
            "age": pl.age,
            "height_cm": pl.height_cm,
            "nation": nation,
            "left_foot": left_foot,
            "right_foot": right_foot,
            "foot": foot,
            "positions": ";".join(pl.natural_positions or ()),
            "accomplished": ";".join(pl.accomplished_positions or ()),
            "club_uid": club_uid_str,
            "club_img_id": club_img_id,
            "club": pl.club_short_name or pl.club_name or "Free Agent",
            "club_rep": pl.club_reputation or 0,
            "league": league,
            "league_id": league_id,
            "on_loan": bool(pl.on_loan),
            "loan_parent": pl.loan_parent_club_name or "",
            "value": pl.transfer_value,
            "value_state": str(getattr(pl.transfer_value_state, "value", pl.transfer_value_state or "")),
            "wage": contract.wage if contract else None,
            "contract_end": contract.end.isoformat() if (contract and contract.end) else "",
            "squad_status": squad_status,
            "is_hull": is_managed,
            **metrics,
        }

        if is_managed:
            squad_records.append(base_record)
        for group in groups:
            pool_records[group].append(dict(base_record))

    all_metrics = _materialize_all_metrics(
        [r for recs in pool_records.values() for r in recs] + squad_records
    )

    summary: dict[str, dict[str, int]] = {}
    for group, records in pool_records.items():
        baseline = [r for r in records if int(r["minutes"]) >= MIN_MINUTES_BASELINE]
        if len(baseline) < 20:
            baseline = records

        metric_defs = POSITION_METRICS[group]
        sorted_dist: dict[str, list[float]] = {
            key: sorted(float(r[key]) for r in baseline) for key, _, _ in metric_defs
        }

        for r in records:
            pcts: dict[str, int] = {}
            for key, _, higher in metric_defs:
                pct = _percentile_score(sorted_dist[key], float(r[key]), higher)
                pcts[key] = pct
                r[f"pct_{key}"] = pct

            for role_name, role_keys in ROLE_PROFILES[group].items():
                slug = role_name.lower().replace(" ", "_").replace("-", "_")
                r[f"score_{slug}"] = round(sum(pcts[k] for k in role_keys) / len(role_keys), 1)
            r["score_overall"] = round(sum(pcts.values()) / len(pcts), 1)

        records.sort(key=lambda r: float(r["score_overall"]), reverse=True)

        csv_path = csv_dir / f"{group}.csv"
        if records:
            with csv_path.open("w", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=list(records[0].keys()))
                writer.writeheader()
                writer.writerows(records)

        payload = {
            "position": group,
            "season": season_key,
            "baseline_minutes": MIN_MINUTES_BASELINE,
            "metrics": [
                {"key": key, "label": label, "higher_is_better": higher}
                for key, label, higher in metric_defs
            ],
            "all_metrics": all_metrics,
            "roles": {
                role_name.lower().replace(" ", "_").replace("-", "_"): {
                    "label": role_name,
                    "metrics": role_keys,
                }
                for role_name, role_keys in ROLE_PROFILES[group].items()
            },
            "players": records,
        }
        (data_dir / f"{group}.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        summary[group] = {
            "total_450": len(records),
            "baseline_900": len(baseline),
            "hull_count": sum(1 for r in records if r["is_hull"]),
        }

    squad_records.sort(key=lambda r: int(r["minutes"]), reverse=True)
    if squad_records:
        with (csv_dir / "managed_club_squad.csv").open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(squad_records[0].keys()))
            writer.writeheader()
            writer.writerows(squad_records)

    meta = {
        "season": season_key,
        "season_end_year": season_end_year,
        "club_name": managed_name,
        "club_short_name": managed_short,
        "club_uid": managed_uid,
        "club_img_id": managed_club_img_id,
        "club_reputation": managed_rep,
        "manager_name": managed.manager_name if managed else "",
        "in_game_date": game_date_str,
        "save_file": save_path.name,
        "save_path": str(save_path),
        "save_mtime": save_stat.st_mtime,
        "positions": summary,
        "all_metrics": all_metrics,
        "hull_squad": squad_records,
    }
    (data_dir / "meta.json").write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")

    # Sync latest season to app/data/ fallback
    for json_file in data_dir.glob("*.json"):
        shutil.copy2(json_file, APP_DATA_DIR / json_file.name)

    # Update progressive seasons index
    index = _load_seasons_index()
    entries: list[dict[str, Any]] = [
        e for e in index.get("seasons", []) if e.get("season") != season_key
    ]
    entries.append(
        {
            "season": season_key,
            "in_game_date": game_date_str,
            "save_file": save_path.name,
            "save_path": str(save_path),
            "save_mtime": save_stat.st_mtime,
            "club_name": managed_name,
            "club_short_name": managed_short,
            "club_uid": managed_uid,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
    )
    entries.sort(key=lambda e: str(e.get("season", "")), reverse=True)
    index = {"latest_season": season_key, "seasons": entries}
    (SEASONS_DIR / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    return meta


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Moneyball scouting data from FM27 .fm save.")
    parser.add_argument("--save", help="Path to a .fm save file (defaults to newest FM27 save)")
    parser.add_argument("--pick", action="store_true", help="Interactively choose from local .fm saves")
    args = parser.parse_args()

    if args.save:
        save_path = Path(args.save)
    elif args.pick:
        saves = list_fm_saves()
        if not saves:
            raise SystemExit(f"No .fm saves found in {DEFAULT_GAMES_DIR}")
        for idx, s in enumerate(saves, start=1):
            print(f"[{idx}] {s['name']} ({s['modified']}, {s['size_mb']} MB)")
        choice = input("Select save number [1]: ").strip() or "1"
        save_path = Path(saves[int(choice) - 1]["path"])
    else:
        save_path = pick_latest_save()

    meta = build_from_save(save_path)
    print(f"Built season {meta['season']} ({meta['in_game_date']}) for {meta['club_name']} from {meta['save_file']}")
    for pos, counts in meta["positions"].items():
        print(f"  {pos:6s}: {counts['total_450']:5d} (>=450m), {counts['baseline_900']:5d} (>=900m), Club={counts['hull_count']}")


if __name__ == "__main__":
    main()
