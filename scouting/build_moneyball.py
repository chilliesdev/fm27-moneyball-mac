"""Build progressive season Moneyball CSVs and JSON datasets directly from FM27 .fm saves."""

from __future__ import annotations

import argparse
import bisect
import csv
import json
import shutil
import warnings
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

import fmsave

ROOT_DIR = Path(__file__).resolve().parent.parent
SCOUTING_DIR = Path(__file__).resolve().parent
SEASONS_DIR = SCOUTING_DIR / "seasons"
APP_DATA_DIR = SCOUTING_DIR / "app" / "data"
DEFAULT_GAMES_DIR = Path.home() / "Library/Application Support/Sports Interactive/Football Manager 27/games"

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
    "goals",
    "assists",
    "expected_goals",
    "non_penalty_expected_goals",
    "expected_assists",
    "shots",
    "shots_on_target",
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
    "distance_km",
    "high_intensity_sprints",
    "aerial_challenges_attempted",
    "headers_won",
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
    "clean_sheets",
    "goals_allowed",
    "saves_held",
    "saves_parried",
    "saves_tipped",
    "shots_on_target_faced",
    "expected_goals_prevented",
)

PER90_SOURCE_MAP: dict[str, str] = {
    "goals_p90": "goals",
    "assists_p90": "assists",
    "xg_p90": "expected_goals",
    "npxg_p90": "non_penalty_expected_goals",
    "xa_p90": "expected_assists",
    "shots_p90": "shots",
    "sot_p90": "shots_on_target",
    "passes_att_p90": "passes_attempted",
    "passes_cmp_p90": "passes_completed",
    "prog_passes_p90": "progressive_passes",
    "key_passes_p90": "key_passes",
    "op_key_passes_p90": "open_play_key_passes",
    "ccc_p90": "clear_cut_chances_created",
    "op_crosses_cmp_p90": "open_play_crosses_completed",
    "dribbles_p90": "dribbles",
    "distance_p90": "distance_km",
    "sprints_p90": "high_intensity_sprints",
    "headers_won_p90": "headers_won",
    "tackles_cmp_p90": "tackles_completed",
    "interceptions_p90": "interceptions",
    "poss_won_p90": "possession_won",
    "poss_lost_p90": "possession_lost",
    "pressures_cmp_p90": "pressures_completed",
    "blocks_p90": "blocks",
    "clearances_p90": "clearances",
    "goals_allowed_p90": "goals_allowed",
    "xg_prevented_p90": "expected_goals_prevented",
}

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


def _is_women_club(club: Any) -> bool:
    if club is None or club.gender is None:
        return False
    return getattr(club.gender, "raw", 0) == 1


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

    m["pass_pct"] = _safe_pct(raw["passes_completed"], raw["passes_attempted"])
    m["tackle_pct"] = _safe_pct(raw["tackles_completed"], raw["tackles_attempted"])
    m["headers_won_pct"] = _safe_pct(raw["headers_won"], raw["aerial_challenges_attempted"])
    m["conversion_pct"] = _safe_pct(raw["goals"], raw["shots"])
    m["xg_per_shot"] = round(raw["expected_goals"] / raw["shots"], 3) if raw["shots"] > 0 else 0.0

    saves_total = raw["saves_held"] + raw["saves_parried"] + raw["saves_tipped"]
    m["save_pct"] = _safe_pct(saves_total, raw["shots_on_target_faced"])
    apps_total = raw["starts"] + raw["substitute_appearances"]
    m["clean_sheet_pct"] = _safe_pct(raw["clean_sheets"], apps_total)
    return m


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

    with fmsave.open(save_path) as career_save:
        info = career_save.info
        game_date = info.game_date
        game_date_str = game_date.isoformat() if game_date else ""
        season_key = season_key_for_date(game_date)

        managed_list = list(career_save.managed_clubs())
        managed = managed_list[0] if managed_list else None
        managed_uid = str(managed.club_uid) if managed else ""
        managed_name = managed.club_name if managed else "Unknown Club"
        managed_short = managed.club_short_name if managed else managed_name

        clubs_by_uid = {c.uid: c for c in career_save.clubs()}
        managed_club_obj = clubs_by_uid.get(managed.club_uid) if managed else None
        managed_rep = (managed_club_obj.reputation or 0) if managed_club_obj else 0

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
        is_managed = bool(managed_uid and club_uid_str == managed_uid)

        base_record: dict[str, Any] = {
            "uid": str(uid),
            "name": pl.name,
            "age": pl.age,
            "height_cm": pl.height_cm,
            "positions": ";".join(pl.natural_positions or ()),
            "accomplished": ";".join(pl.accomplished_positions or ()),
            "club_uid": club_uid_str,
            "club": pl.club_short_name or pl.club_name or "Free Agent",
            "club_rep": pl.club_reputation or 0,
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
        "club_name": managed_name,
        "club_short_name": managed_short,
        "club_uid": managed_uid,
        "club_reputation": managed_rep,
        "manager_name": managed.manager_name if managed else "",
        "in_game_date": game_date_str,
        "save_file": save_path.name,
        "save_path": str(save_path),
        "save_mtime": save_stat.st_mtime,
        "positions": summary,
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
