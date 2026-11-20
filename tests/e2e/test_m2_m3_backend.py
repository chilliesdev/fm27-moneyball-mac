"""Opaque-box E2E tests for M2 (F4-F6) and M3 backend/vendor (F7-F9)."""

from __future__ import annotations

import atexit
import concurrent.futures
import csv
import http.client
import json
import math
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parents[2]
SCOUTING_DIR = REPO_ROOT / "scouting"
APP_DIR = SCOUTING_DIR / "app"
APP_DATA_DIR = APP_DIR / "data"
SEASONS_DIR = SCOUTING_DIR / "seasons"
VENDOR_DIR = APP_DIR / "vendor"
BUILD_SCRIPT = SCOUTING_DIR / "build_moneyball.py"

DEFAULT_GAMES_DIR = (
    Path.home()
    / "Library"
    / "Application Support"
    / "Sports Interactive"
    / "Football Manager 27"
    / "games"
)
ALL_POSITIONS = ("ST", "W", "AM", "CM", "DM", "FB_WB", "CB", "GK")

# Minimal valid 1x1 PNG bytes (67 bytes)
TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00"
    b"\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)
# Distinct 1x1 PNG (slightly different chunk/bytes so we can distinguish files)
TINY_PNG_ALT = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0"
    b"\x00\x00\x03\x01\x01\x00\xc9\xfe\x92\xef\x00\x00\x00\x00IEND\xaeB`\x82"
)
TINY_JPG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
TINY_WEBP = b"RIFF\x1a\x00\x00\x00WEBPVP8 \x0e\x00\x00\x000\x01\x00\x9d\x01*\x01\x00\x01\x00\x02\x004\x25\xa4\x00"

@dataclass
class CaseResult:
    id: str
    feature: str
    tier: int
    passed: bool
    duration_ms: float
    detail: str = ""


class EphemeralServer:
    """Launch scouting/server.py on OS port 0 without touching port 8727."""

    def __init__(self, extra_env: dict[str, str] | None = None, timeout: float = 15.0) -> None:
        self.extra_env = extra_env or {}
        self.timeout = timeout
        self.proc: subprocess.Popen[str] | None = None
        self.port: int | None = None
        self.base_url: str = ""
        self.bind_elapsed_s: float = 0.0

    def __enter__(self) -> "EphemeralServer":
        env = {**os.environ, **self.extra_env}
        t0 = time.perf_counter()
        proc = subprocess.Popen(
            [sys.executable, str(SCOUTING_DIR / "server.py"), "--host", "127.0.0.1", "--port", "0"],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.proc = proc
        atexit.register(self.close)

        ports: queue.Queue[int | None] = queue.Queue()
        output: deque[str] = deque(maxlen=10)

        def _reader() -> None:
            assert proc.stdout is not None
            with proc.stdout:
                for line in proc.stdout:
                    output.append(line)
                    match = re.fullmatch(r"Moneyball Scout server listening on http://127\.0\.0\.1:(\d+)/\s*", line)
                    if match:
                        ports.put(int(match[1]))
            ports.put(None)

        reader = threading.Thread(target=_reader, daemon=True)
        reader.start()

        deadline = time.monotonic() + self.timeout
        try:
            self.port = ports.get(timeout=self.timeout)
            if self.port is None:
                raise RuntimeError("Ephemeral server exited before binding")

            self.base_url = f"http://127.0.0.1:{self.port}"
            while (remaining := deadline - time.monotonic()) > 0:
                try:
                    status, _, _ = http_get(f"{self.base_url}/api/status", timeout=min(remaining, 2.0))
                    if status == 200:
                        self.bind_elapsed_s = time.perf_counter() - t0
                        return self
                except OSError:
                    if proc.poll() is not None:
                        raise RuntimeError("Ephemeral server exited during readiness check")
                time.sleep(0.05)
            raise TimeoutError(f"/api/status did not return 200 within {self.timeout}s")
        except (queue.Empty, OSError, RuntimeError) as exc:
            self.close()
            reader.join(timeout=1)
            reason = str(exc) or f"Server did not bind within {self.timeout}s"
            raise RuntimeError(f"{reason}: {''.join(output.copy()).strip()}") from exc

    def close(self) -> None:
        proc = self.proc
        if proc is None:
            return
        self.proc = None
        atexit.unregister(self.close)
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)

    def __exit__(self, *_: Any) -> None:
        self.close()


def http_request(
    url: str,
    method: str = "GET",
    timeout: float = 5.0,
) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, headers, resp.read()
    except urllib.error.HTTPError as err:
        headers = {k.lower(): v for k, v in err.headers.items()} if err.headers else {}
        return err.code, headers, err.read()


def http_get(url: str, timeout: float = 5.0) -> tuple[int, dict[str, str], bytes]:
    return http_request(url, "GET", timeout=timeout)


def raw_http_get(base_url: str, raw_path: str, timeout: float = 5.0) -> tuple[int, dict[str, str], bytes]:
    """Send raw un-normalized path to test HTTP path traversal handling."""
    parsed = urllib.parse.urlsplit(base_url)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=timeout)
    try:
        conn.request("GET", raw_path)
        resp = conn.getresponse()
        headers = {k.lower(): v for k, v in resp.getheaders()}
        return resp.status, headers, resp.read()
    finally:
        conn.close()


class BackendContext:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._meta: dict[str, Any] | None = None
        self._pos_data: dict[str, dict[str, Any]] = {}
        self._non_r2_build_cache: dict[str, Any] = {}
        self._temp_gfx_server: EphemeralServer | None = None
        self._temp_gfx_dir: tempfile.TemporaryDirectory[str] | None = None
        self._outside_dir: tempfile.TemporaryDirectory[str] | None = None
        self._nonexistent_gfx_server: EphemeralServer | None = None
        self._warmed_main = False

    def meta(self) -> dict[str, Any]:
        if self._meta is None:
            self._meta = json.loads((APP_DATA_DIR / "meta.json").read_text(encoding="utf-8"))
        return self._meta

    def pos_data(self, pos: str) -> dict[str, Any]:
        if pos not in self._pos_data:
            self._pos_data[pos] = json.loads((APP_DATA_DIR / f"{pos}.json").read_text(encoding="utf-8"))
        return self._pos_data[pos]

    def all_pos_data(self) -> dict[str, dict[str, Any]]:
        return {pos: self.pos_data(pos) for pos in ALL_POSITIONS}

    def all_players(self) -> list[tuple[str, dict[str, Any]]]:
        rows: list[tuple[str, dict[str, Any]]] = []
        for pos, ds in self.all_pos_data().items():
            for p in ds.get("players", []):
                rows.append((pos, p))
        return rows

    def latest_season(self) -> str:
        return str(self.meta().get("season") or "2027-28")

    def _snapshot_latest_save(self, dest_dir: Path) -> Path:
        fm_files = [
            p for p in DEFAULT_GAMES_DIR.glob("*.fm")
            if p.is_file() and not p.name.startswith("._")
        ]
        assert fm_files, f"No .fm save found in {DEFAULT_GAMES_DIR}"
        src = max(fm_files, key=lambda p: p.stat().st_mtime_ns)
        dst = dest_dir / src.name
        for _attempt in range(6):
            try:
                st1 = src.stat()
                shutil.copy2(src, dst)
                st2 = src.stat()
                if (
                    st1.st_size == st2.st_size
                    and st1.st_mtime_ns == st2.st_mtime_ns
                    and dst.stat().st_size == st2.st_size
                ):
                    return dst
            except OSError:
                pass
            time.sleep(0.5)
        raise RuntimeError(f"Save {src.name} kept changing during snapshot copy")

    def run_isolated_build(self, key: str, extra_env: dict[str, str] | None = None) -> dict[str, Any]:
        if key in self._non_r2_build_cache:
            return self._non_r2_build_cache[key]

        meta_path = APP_DATA_DIR / "meta.json"
        orig_mtime = meta_path.stat().st_mtime_ns if meta_path.exists() else None

        with tempfile.TemporaryDirectory(prefix=f"e2e_build_{key}_") as tmpdir:
            root = Path(tmpdir)
            scouting_copy = root / "scouting"
            scouting_copy.mkdir(parents=True, exist_ok=True)
            shutil.copy2(BUILD_SCRIPT, scouting_copy / "build_moneyball.py")
            (scouting_copy / "app" / "data").mkdir(parents=True, exist_ok=True)
            (scouting_copy / "seasons").mkdir(parents=True, exist_ok=True)

            copied_save = self._snapshot_latest_save(root)
            env = {**os.environ, **(extra_env or {})}
            try:
                proc = subprocess.run(
                    [sys.executable, str(scouting_copy / "build_moneyball.py"), "--save", str(copied_save)],
                    cwd=str(root),
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=900,
                )
                returncode, stdout, stderr = proc.returncode, proc.stdout, proc.stderr
            except subprocess.TimeoutExpired as exc:
                returncode, stdout, stderr = None, "", f"Save rebuild exceeded {exc.timeout}s"

            after_mtime = meta_path.stat().st_mtime_ns if meta_path.exists() else None
            assert orig_mtime == after_mtime, "Isolated build touched workspace scouting/app/data/meta.json!"

            built_meta_path = scouting_copy / "app" / "data" / "meta.json"
            built_st_path = scouting_copy / "app" / "data" / "ST.json"
            built_meta = json.loads(built_meta_path.read_text(encoding="utf-8")) if built_meta_path.exists() else None
            built_st = json.loads(built_st_path.read_text(encoding="utf-8")) if built_st_path.exists() else None
            res = {
                "returncode": returncode,
                "stdout": stdout,
                "stderr": stderr,
                "meta": built_meta,
                "st": built_st,
            }
            self._non_r2_build_cache[key] = res
            return res

    def wait_main_graphics_warm(self, url_path: str, timeout: float = 60.0) -> tuple[int, dict[str, str], bytes]:
        """Poll /api/status (graphics.ready) and image URL up to timeout, tolerating transient TimeoutError."""
        deadline = time.monotonic() + timeout
        if not self._warmed_main:
            while time.monotonic() < deadline:
                try:
                    st_s, _, body_s = http_get(f"{self.base_url}/api/status", timeout=8.0)
                    if st_s == 200:
                        info = json.loads(body_s.decode("utf-8"))
                        gfx = info.get("graphics")
                        if not isinstance(gfx, dict) or gfx.get("ready") is True:
                            self._warmed_main = True
                            break
                except (TimeoutError, OSError, urllib.error.URLError, json.JSONDecodeError):
                    pass
                time.sleep(0.35)

        last: tuple[int, dict[str, str], bytes] | None = None
        while True:
            try:
                last = http_get(f"{self.base_url}{url_path}", timeout=8.0)
                status, hdrs, body = last
                ctype = hdrs.get("content-type", "")
                if status >= 400:
                    return last
                if status == 200 and ctype.startswith("image/png"):
                    self._warmed_main = True
                    return last
                if self._warmed_main:
                    return last
            except (TimeoutError, OSError, urllib.error.URLError) as exc:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out requesting {url_path}: {exc}") from exc
            if time.monotonic() >= deadline:
                if last is not None:
                    return last
                raise TimeoutError(f"Timed out waiting for {url_path}")
            time.sleep(0.35)

    def temp_gfx_server(self) -> tuple[EphemeralServer, Path]:
        if self._temp_gfx_server is None:
            self._temp_gfx_dir = tempfile.TemporaryDirectory(prefix="e2e_gfx_")
            self._outside_dir = tempfile.TemporaryDirectory(prefix="e2e_gfx_outside_")
            gfx = Path(self._temp_gfx_dir.name)
            outside = Path(self._outside_dir.name)
            (outside / "secret.png").write_bytes(TINY_PNG)

            # 1) clubs/good mapping
            clubs = gfx / "clubs"
            clubs.mkdir(parents=True, exist_ok=True)
            (clubs / "c1.png").write_bytes(TINY_PNG)
            (clubs / "ok.png").write_bytes(TINY_PNG)
            (clubs / "config.xml").write_text(
                "<record>\n"
                '  <list id="maps">\n'
                '    <record from="c1" to="graphics/pictures/club/777777/logo"/>\n'
                '    <record from="ok" to="graphics/pictures/club/101/logo"/>\n'
                "  </list>\n"
                "</record>\n",
                encoding="utf-8",
            )

            # 2) broken config.xml
            broken = gfx / "broken"
            broken.mkdir(parents=True, exist_ok=True)
            (broken / "config.xml").write_text("<record><broken", encoding="utf-8")

            # 3) traversal config.xml
            evil = gfx / "evil"
            evil.mkdir(parents=True, exist_ok=True)
            rel_secret = os.path.relpath(outside / "secret", evil)
            (evil / "config.xml").write_text(
                "<record>\n"
                '  <list id="maps">\n'
                f'    <record from="{rel_secret}" to="graphics/pictures/club/909/logo"/>\n'
                '    <record from="../../../etc/passwd" to="graphics/pictures/club/910/logo"/>\n'
                "  </list>\n"
                "</record>\n",
                encoding="utf-8",
            )

            # 4) icon-only person fallback
            icons = gfx / "icons"
            icons.mkdir(parents=True, exist_ok=True)
            (icons / "ic1.png").write_bytes(TINY_PNG_ALT)
            (icons / "config.xml").write_text(
                "<record>\n"
                '  <list id="maps">\n'
                '    <record from="ic1" to="graphics/pictures/person/555555/icon"/>\n'
                "  </list>\n"
                "</record>\n",
                encoding="utf-8",
            )

            # 5) jpg/jpeg/webp formats
            fmts = gfx / "formats"
            fmts.mkdir(parents=True, exist_ok=True)
            (fmts / "a.jpg").write_bytes(TINY_JPG)
            (fmts / "b.jpeg").write_bytes(TINY_JPG)
            (fmts / "c.webp").write_bytes(TINY_WEBP)
            (fmts / "config.xml").write_text(
                "<record>\n"
                '  <list id="maps">\n'
                '    <record from="a" to="graphics/pictures/person/1/portrait"/>\n'
                '    <record from="b" to="graphics/pictures/club/2/logo"/>\n'
                '    <record from="c" to="graphics/pictures/comp/3/logo"/>\n'
                "  </list>\n"
                "</record>\n",
                encoding="utf-8",
            )

            # 6) dynamic reload folder (starts without 888888)
            dyn = gfx / "dynamic"
            dyn.mkdir(parents=True, exist_ok=True)
            (dyn / "c2.png").write_bytes(TINY_PNG_ALT)
            (dyn / "config.xml").write_text(
                "<record><list id=\"maps\"></list></record>\n",
                encoding="utf-8",
            )

            srv = EphemeralServer(extra_env={"FM27_GRAPHICS_DIR": str(gfx)}, timeout=10.0)
            srv.__enter__()
            self._temp_gfx_server = srv
            # Wait briefly if index warms async
            for _ in range(20):
                st, hdrs, _ = http_get(f"{srv.base_url}/api/img/club/777777?name=Custom", timeout=3.0)
                if st >= 400 or (st == 200 and hdrs.get("content-type", "").startswith("image/png")):
                    break
                time.sleep(0.1)
        return self._temp_gfx_server, Path(self._temp_gfx_dir.name)

    def nonexistent_gfx_server(self) -> EphemeralServer:
        if self._nonexistent_gfx_server is None:
            srv = EphemeralServer(extra_env={"FM27_GRAPHICS_DIR": "/nonexistent_path_e2e_test"}, timeout=10.0)
            srv.__enter__()
            self._nonexistent_gfx_server = srv
        return self._nonexistent_gfx_server

    def cleanup(self) -> None:
        if self._temp_gfx_server is not None:
            self._temp_gfx_server.close()
            self._temp_gfx_server = None
        if self._nonexistent_gfx_server is not None:
            self._nonexistent_gfx_server.close()
            self._nonexistent_gfx_server = None
        if self._temp_gfx_dir is not None:
            self._temp_gfx_dir.cleanup()
            self._temp_gfx_dir = None
        if self._outside_dir is not None:
            self._outside_dir.cleanup()
            self._outside_dir = None


def _assert_r2_fields_present(meta: dict[str, Any], st: dict[str, Any]) -> None:
    for key in ("club_img_id", "season_end_year", "all_metrics"):
        assert key in meta, f"meta.json missing R2 field '{key}'"
    assert "all_metrics" in st, "ST.json missing 'all_metrics'"
    players = st.get("players", [])
    assert len(players) > 0, "ST.json has no players"
    p0 = players[0]
    for key in ("img_id", "club_img_id", "league", "league_id", "nation", "foot", "left_foot", "right_foot"):
        assert key in p0, f"Player row missing R2 field '{key}'"


def _check_f4(ctx: BackendContext, tier: int) -> list[tuple[str, int, Callable[[], str]]]:
    cases: list[tuple[str, int, Callable[[], str]]] = []

    if tier in (0, 1):
        def t1_01() -> str:
            hull = [p for _, p in ctx.all_players() if str(p.get("club_uid")) == "665"]
            assert hull, "No Hull City players found"
            for p in hull:
                assert p.get("league") == "Premier League", f"Hull {p.get('name')} league={p.get('league')!r}"
                assert p.get("league_id") == "11", f"Hull {p.get('name')} league_id={p.get('league_id')!r}"
                assert p.get("nation") and not str(p.get("nation")).isdigit(), f"Bad nation={p.get('nation')!r}"
            pelle = next((p for p in hull if str(p.get("uid")) == "14217505"), None)
            if pelle:
                assert pelle.get("nation") == "Spain", f"Pellegrino nation={pelle.get('nation')!r}"
            hughes = next((p for p in hull if str(p.get("uid")) == "2000050581"), None)
            assert hughes and hughes.get("nation") == "England", f"Hughes nation={hughes.get('nation') if hughes else None!r}"
            return f"Verified {len(hull)} Hull rows in Premier League"

        def t1_02() -> str:
            all_rows = [p for _, p in ctx.all_players()]
            swe = [p for p in all_rows if str(p.get("league_id")) == "50"]
            bra = [p for p in all_rows if str(p.get("league_id")) == "102423"]
            assert swe, "No players found with league_id=='50'"
            assert bra, "No players found with league_id=='102423'"
            assert all(p.get("league") == "Allsvenskan" for p in swe), f"Got {[p.get('league') for p in swe[:3]]}"
            assert all(p.get("league") in ("Série A", "Brasileirão Série A") for p in bra), f"Got {[p.get('league') for p in bra[:3]]}"
            return f"Allsvenskan ({len(swe)}) & Brasileirao ({len(bra)}) overrides applied"

        def t1_03() -> str:
            nations = {str(p.get("nation") or "").strip() for _, p in ctx.all_players()}
            nations.discard("")
            assert len(nations) > 100, f"Only {len(nations)} distinct nations found"
            raw_ints = [n for n in nations if n.isdigit()]
            assert not raw_ints, f"Raw integer nation IDs found: {raw_ints[:5]}"
            for req in ("England", "Argentina", "Brazil", "Sweden", "Scotland", "Wales"):
                assert req in nations, f"Missing nation '{req}'"
            assert "Netherlands" in nations or "The Netherlands" in nations, "Missing Netherlands"
            return f"{len(nations)} distinct resolved nations"

        def t1_04() -> str:
            bad = []
            pat = re.compile(r"^(Competition|Nation)\s*#?\d+$")
            for pos, p in ctx.all_players():
                lid = p.get("league_id")
                assert "league_id" in p and "league" in p, f"Missing league/league_id in {pos}"
                lg = str(p.get("league") or "")
                if lid:
                    if not lg or lg == "None" or pat.match(lg):
                        bad.append((p.get("name"), lid, lg))
            assert not bad, f"Generic/empty competition names: {bad[:5]}"
            return "Zero placeholder competition names"

        def t1_05() -> str:
            season = ctx.latest_season()
            csv_dir = SEASONS_DIR / season / "csv"
            st_json = {str(p["uid"]): p for p in ctx.pos_data("ST")["players"]}
            with (csv_dir / "ST.csv").open("r", encoding="utf-8", newline="") as f:
                st_csv = list(csv.DictReader(f))
            assert len(st_csv) == len(st_json), f"ST.csv ({len(st_csv)}) != ST.json ({len(st_json)})"
            for row in st_csv:
                jp = st_json[row["uid"]]
                for fld in ("league", "league_id", "nation"):
                    assert fld in row and fld in jp, f"Missing '{fld}' in ST CSV/JSON"
                    assert row[fld] == str(jp[fld] or ""), f"Mismatch on {row['uid']} {fld}: {row[fld]!r} != {jp[fld]!r}"
            meta_hull = {str(p["uid"]): p for p in ctx.meta().get("hull_squad", [])}
            with (csv_dir / "managed_club_squad.csv").open("r", encoding="utf-8", newline="") as f:
                sq_csv = list(csv.DictReader(f))
            assert len(sq_csv) == len(meta_hull), "managed_club_squad.csv count mismatch"
            for row in sq_csv:
                jp = meta_hull[row["uid"]]
                for fld in ("league", "league_id", "nation"):
                    assert row[fld] == str(jp[fld] or ""), f"Squad mismatch {fld}"
            return "CSV/JSON parity for league/league_id/nation"

        def t1_06() -> str:
            season = ctx.latest_season()
            arch_dir = SEASONS_DIR / season / "data"
            expected = ["meta.json", *(f"{p}.json" for p in ALL_POSITIONS)]
            for fn in expected:
                a = arch_dir / fn
                b = APP_DATA_DIR / fn
                assert a.is_file() and b.is_file(), f"Missing {fn} in archive or app/data"
                assert a.read_bytes() == b.read_bytes(), f"{fn} differs between seasons/{season}/data and app/data"
            return f"All 9 JSONs synced for {season}"

        cases.extend([
            ("F4-T1-01", 1, t1_01),
            ("F4-T1-02", 1, t1_02),
            ("F4-T1-03", 1, t1_03),
            ("F4-T1-04", 1, t1_04),
            ("F4-T1-05", 1, t1_05),
            ("F4-T1-06", 1, t1_06),
        ])

    if tier in (0, 2):
        def t2_01() -> str:
            res = ctx.run_isolated_build("no_install", {"FM27_INSTALL_DIR": "/nonexistent_fm27"})
            assert res["returncode"] == 0, f"Build failed with missing FM27_INSTALL_DIR: {res['stderr']}"
            assert res["meta"] and res["st"], "Isolated build produced no JSON"
            _assert_r2_fields_present(res["meta"], res["st"])
            return "Isolated build survived FM27_INSTALL_DIR=/nonexistent_fm27 with R2 fields"

        def t2_02() -> str:
            res = ctx.run_isolated_build("default_lnc", {})
            assert res["returncode"] == 0, f"Isolated build failed: {res['stderr']}"
            assert res["meta"] and res["st"], "Missing isolated JSON"
            _assert_r2_fields_present(res["meta"], res["st"])
            swe = [p for p in res["st"]["players"] if str(p.get("league_id")) == "50"]
            assert swe and all(p.get("league") == "Allsvenskan" for p in swe), "Allsvenskan .lnc override missing in isolated build"
            return "Blank .lnc lines ignored; valid overrides applied"

        def t2_03() -> str:
            season = ctx.latest_season()
            st_players = ctx.pos_data("ST")["players"]
            assert any("league" in p for p in st_players), "Missing R2 league field"
            non_ascii = [
                p for p in st_players
                if any(ord(c) > 127 for c in ((p.get("name") or "") + (p.get("league") or "")))
            ]
            assert non_ascii, "No UTF-8 diacritic rows found"
            csv_path = SEASONS_DIR / season / "csv" / "ST.csv"
            with csv_path.open("r", encoding="utf-8", newline="") as f:
                by_uid = {r["uid"]: r for r in csv.DictReader(f)}
            for p in non_ascii[:50]:
                cr = by_uid[str(p["uid"])]
                pname = p.get("name") or ""
                plg = p.get("league") or ""
                assert "Ã" not in pname and "Ã" not in plg, f"Mojibake in {pname!r}"
                assert cr["name"] == pname and cr.get("league") == plg, "UTF-8 CSV/JSON mismatch"
            return f"UTF-8 diacritics preserved across {len(non_ascii)} ST rows"

        def t2_04() -> str:
            res = ctx.run_isolated_build("default_lnc", {})
            assert res["returncode"] == 0, f"Build crashed on save tables: {res['stderr']}"
            assert res["st"], "Missing ST.json"
            _assert_r2_fields_present(res["meta"], res["st"])
            for p in res["st"]["players"]:
                assert isinstance(p.get("league"), str) and p["league"] != "" and p["league"] != "None", f"Bad league on {p.get('name')}: {p.get('league')!r}"
            return "Unnamed/DB-less tables handled cleanly"

        def t2_05() -> str:
            all_rows = ctx.all_players()
            assert any("nation" in p for _, p in all_rows), "Missing 'nation' field"
            bad = [p.get("name") for _, p in all_rows if p.get("nation") is None or p.get("nation") == "None"]
            assert not bad, f"Players with None/'None' nation: {bad[:5]}"
            return "All players have valid string nation (no null/'None')"

        cases.extend([
            ("F4-T2-01", 2, t2_01),
            ("F4-T2-02", 2, t2_02),
            ("F4-T2-03", 2, t2_03),
            ("F4-T2-04", 2, t2_04),
            ("F4-T2-05", 2, t2_05),
        ])

    return cases


def _check_f5(ctx: BackendContext, tier: int) -> list[tuple[str, int, Callable[[], str]]]:
    cases: list[tuple[str, int, Callable[[], str]]] = []

    if tier in (0, 1):
        def t1_01() -> str:
            st_hull = [p for p in ctx.pos_data("ST")["players"] if str(p.get("club_uid")) == "665"]
            am_hull = [p for p in ctx.pos_data("AM")["players"] if str(p.get("club_uid")) == "665"]
            sq_hull = ctx.meta().get("hull_squad", [])
            assert st_hull and am_hull and sq_hull, "Missing Hull rows"
            for p in (*st_hull, *am_hull, *sq_hull):
                assert p.get("league") == "Premier League" and p.get("league_id") == "11", f"Got {p.get('league')}/{p.get('league_id')}"
            return "Hull City resolved to Premier League (11)"

        def t1_02() -> str:
            ev = [p for _, p in ctx.all_players() if str(p.get("club_uid")) == "649"]
            assert len(ev) >= 15, f"Expected >=15 Everton rows, got {len(ev)}"
            for p in ev:
                assert p.get("league") == "Premier League" and p.get("league_id") == "11", f"Everton got {p.get('league')}/{p.get('league_id')}"
            return f"Everton ({len(ev)} rows) resolved to Premier League (11)"

        def t1_03() -> str:
            welsh_eng = [p for _, p in ctx.all_players() if str(p.get("club_uid")) in {"625", "724", "741"}]
            assert len(welsh_eng) >= 20, f"Expected >=20 Cardiff/Swansea/Wrexham rows, got {len(welsh_eng)}"
            for p in welsh_eng:
                lg = p.get("league") or ""
                assert lg and "Wales" not in lg and "Cymru" not in lg, f"Cross-border club {p.get('club')} got {lg!r}"
            return f"Cross-border Welsh clubs ({len(welsh_eng)} rows) in English pyramid"

        def t1_04() -> str:
            targets = {
                "Matt Ritchie": "Scotland (Other)",
                "Jere Uronen": "Denmark (Other)",
            }
            found = {}
            for _, p in ctx.all_players():
                nm = p.get("name")
                if nm in targets:
                    found[nm] = p
                    assert p.get("league") == targets[nm], f"{nm}: expected {targets[nm]!r}, got {p.get('league')!r}"
                    assert p.get("league_id") == "", f"{nm}: expected empty league_id, got {p.get('league_id')!r}"
            assert len(found) == len(targets), f"Only found {list(found.keys())}"
            return f"Verified <Nation> (Other) fallback for {list(found.keys())}"

        def t1_05() -> str:
            cup_terms = ("EFL Trophy", "Swedish Cup", "FA Cup", "Carabao Cup", "DFB-Pokal", "Copa del Rey")
            bad = []
            for _, p in ctx.all_players():
                assert "league" in p, "Missing 'league' field"
                lg = str(p.get("league") or "")
                if any(t in lg for t in cup_terms):
                    bad.append((p.get("club"), lg))
            assert not bad, f"Domestic cup leaked as league: {bad[:5]}"
            return "Domestic leagues beat cup group stages"

        cases.extend([
            ("F5-T1-01", 1, t1_01),
            ("F5-T1-02", 1, t1_02),
            ("F5-T1-03", 1, t1_03),
            ("F5-T1-04", 1, t1_04),
            ("F5-T1-05", 1, t1_05),
        ])

    if tier in (0, 2):
        def t2_01() -> str:
            cont = ("Champions League", "Europa League", "Conference League", "Copa Libertadores", "Copa Sudamericana", "AFC Champions")
            bad = []
            for _, p in ctx.all_players():
                assert "league" in p, "Missing 'league' field"
                lg = str(p.get("league") or "")
                if any(c in lg for c in cont):
                    bad.append((p.get("club"), lg))
            assert not bad, f"Continental cup leaked: {bad[:5]}"
            return "Zero continental cup leakage"

        def t2_02() -> str:
            res_terms = ("U21", "U18", "U23", "Premier League 2", "Reserve")
            bad = []
            for _, p in ctx.all_players():
                assert "league" in p, "Missing 'league' field"
                lg = str(p.get("league") or "")
                if any(t in lg for t in res_terms):
                    bad.append((p.get("name"), p.get("club"), lg))
            assert not bad, f"Reserve/youth league leaked: {bad[:5]}"
            return "Zero U21/U18/reserve leakage"

        def t2_03() -> str:
            by_club: dict[str, set[tuple[str, str]]] = {}
            for _, p in ctx.all_players():
                assert "league" in p and "league_id" in p, "Missing league fields"
                cuid = str(p.get("club_uid") or "")
                if not cuid:
                    continue
                by_club.setdefault(cuid, set()).add((str(p.get("league") or ""), str(p.get("league_id") or "")))
            multi = {k: v for k, v in by_club.items() if len(v) > 1}
            assert not multi, f"Clubs with multiple leagues: {list(multi.items())[:5]}"
            return f"All {len(by_club)} clubs map deterministically to 1 league"

        def t2_04() -> str:
            for _, p in ctx.all_players():
                assert "league" in p and "league_id" in p, "Missing league fields"
                cuid = str(p.get("club_uid") or "")
                lg = p.get("league")
                lid = p.get("league_id")
                if cuid == "":
                    assert lg == "Free Agent" and lid == "", f"Empty club_uid got {lg}/{lid}"
                else:
                    assert isinstance(lg, str) and len(lg) > 0 and lg != "Free Agent", f"Club {cuid} bad league={lg!r}"
            return "Free Agent invariant holds across all rows"

        def t2_05() -> str:
            women_pat = re.compile(r"\b(Women'?s|WSL|FWSL|Frauen-Bundesliga|D1 Féminine)\b", re.I)
            bad = []
            for _, p in ctx.all_players():
                assert "league" in p, "Missing 'league' field"
                if women_pat.search(str(p.get("club") or "")) or women_pat.search(str(p.get("league") or "")):
                    bad.append((p.get("name"), p.get("club"), p.get("league")))
            assert not bad, f"Women's club/league leaked: {bad[:5]}"
            return "Zero women's clubs in men's datasets"

        cases.extend([
            ("F5-T2-01", 2, t2_01),
            ("F5-T2-02", 2, t2_02),
            ("F5-T2-03", 2, t2_03),
            ("F5-T2-04", 2, t2_04),
            ("F5-T2-05", 2, t2_05),
        ])

    return cases


def _check_f6(ctx: BackendContext, tier: int) -> list[tuple[str, int, Callable[[], str]]]:
    cases: list[tuple[str, int, Callable[[], str]]] = []

    if tier in (0, 1):
        def t1_01() -> str:
            expected = {
                "28126248": "28126249",
                "14217505": "14217538",
                "2000050581": "2000050618",
            }
            seen = {}
            for _, p in ctx.all_players():
                u = str(p.get("uid"))
                if u in expected:
                    seen[u] = p.get("img_id")
                    assert p.get("img_id") == expected[u], f"{p.get('name')}: expected img_id={expected[u]}, got {p.get('img_id')!r}"
            assert len(seen) == len(expected), f"Only saw {seen}"
            return f"img_id matches unique_id for McAtee, Pellegrino, Hughes"

        def t1_02() -> str:
            meta = ctx.meta()
            assert meta.get("club_img_id") == "665", f"meta club_img_id={meta.get('club_img_id')!r}"
            for h in meta.get("hull_squad", []):
                assert h.get("img_id") and h.get("club_img_id") == "665", f"hull_squad item missing img IDs: {h.get('name')}"
            ev = [p for _, p in ctx.all_players() if str(p.get("club_uid")) == "649"]
            rm = [p for _, p in ctx.all_players() if str(p.get("club_uid")) == "1734"]
            assert ev and all(p.get("club_img_id") == "650" for p in ev), f"Everton club_img_id={[p.get('club_img_id') for p in ev[:2]]}"
            assert rm and all(p.get("club_img_id") == "1736" for p in rm), f"Real Madrid club_img_id={[p.get('club_img_id') for p in rm[:2]]}"
            return "club_img_id verified on meta.json, Everton (650), Real Madrid (1736)"

        def t1_03() -> str:
            sey = ctx.meta().get("season_end_year")
            assert isinstance(sey, int) and sey == 2028, f"Expected int 2028, got {sey!r}"
            return "season_end_year == 2028"

        def t1_04() -> str:
            spot = {"14217505": "Left", "2000050581": "Right", "222731": "Both"}
            seen = {}
            for _, p in ctx.all_players():
                lf = p.get("left_foot")
                rf = p.get("right_foot")
                ft = p.get("foot")
                assert isinstance(lf, int) and 1 <= lf <= 20, f"Invalid left_foot={lf!r}"
                assert isinstance(rf, int) and 1 <= rf <= 20, f"Invalid right_foot={rf!r}"
                assert ft in ("Left", "Right", "Both"), f"Invalid foot={ft!r}"
                u = str(p.get("uid"))
                if u in spot:
                    seen[u] = ft
                    assert ft == spot[u], f"{p.get('name')}: expected {spot[u]}, got {ft} ({lf},{rf})"
            assert len(seen) >= 2, f"Spot check players missing: {seen}"
            return f"Foot fields valid; spot checks={seen}"

        def t1_05() -> str:
            meta_am = ctx.meta().get("all_metrics")
            assert isinstance(meta_am, list) and len(meta_am) >= 25, f"meta.json all_metrics missing or short: {type(meta_am)}"
            keys = set()
            for item in meta_am:
                assert {"key", "label", "higher_is_better", "category"} <= set(item.keys()), f"Bad all_metrics schema: {item}"
                assert isinstance(item["higher_is_better"], bool)
                keys.add(item["key"])
            for req in ("avg_rating", "goals", "assists", "minutes", "xg_per_shot"):
                assert req in keys, f"all_metrics missing {req}"
            assert any(k.endswith("_p90") for k in keys) and any(k.endswith("_pct") for k in keys)
            for pos in ALL_POSITIONS:
                pos_am = ctx.pos_data(pos).get("all_metrics")
                assert pos_am == meta_am, f"{pos}.json all_metrics differs from meta.json"
            return f"Unified all_metrics ({len(meta_am)} metrics) consistent across all 9 JSONs"

        def t1_06() -> str:
            season = ctx.latest_season()
            csv_dir = SEASONS_DIR / season / "csv"
            req_cols = {"img_id", "club_img_id", "league", "league_id", "nation", "foot", "left_foot", "right_foot"}
            am_keys = {m["key"] for m in ctx.meta().get("all_metrics", [])}
            assert am_keys, "all_metrics missing"
            for fn in ("ST.csv", "GK.csv", "managed_club_squad.csv"):
                with (csv_dir / fn).open("r", encoding="utf-8", newline="") as f:
                    hdr = set(csv.DictReader(f).fieldnames or [])
                missing = (req_cols | am_keys) - hdr
                assert not missing, f"{fn} missing columns: {sorted(missing)[:8]}"
            return "CSV headers include all R2 & all_metrics columns"

        cases.extend([
            ("F6-T1-01", 1, t1_01),
            ("F6-T1-02", 1, t1_02),
            ("F6-T1-03", 1, t1_03),
            ("F6-T1-04", 1, t1_04),
            ("F6-T1-05", 1, t1_05),
            ("F6-T1-06", 1, t1_06),
        ])

    if tier in (0, 2):
        def t2_01() -> str:
            rows = ctx.all_players()
            assert any("img_id" in p for _, p in rows), "Missing img_id"
            for _, p in rows:
                iid = str(p.get("img_id") or "")
                assert iid.isdigit() and iid != "None", f"Invalid img_id={p.get('img_id')!r} on {p.get('uid')}"
                if str(p.get("uid")) == "2002113974":
                    assert iid == "2002113974", f"unique_id=None player got img_id={iid!r}"
            return "All img_id values are valid digit strings"

        def t2_02() -> str:
            rows = ctx.all_players()
            assert any("foot" in p for _, p in rows), "Missing foot field"
            for _, p in rows:
                lf = p["left_foot"]
                rf = p["right_foot"]
                expected = "Both" if (lf >= 15 and rf >= 15) else ("Left" if lf > rf else "Right")
                assert p["foot"] == expected, f"{p.get('name')} ({lf},{rf}) got {p.get('foot')}, expected {expected}"
            return f"100% foot rule conformance across {len(rows)} rows"

        def t2_03() -> str:
            am = ctx.meta().get("all_metrics")
            assert am, "Missing all_metrics"
            keys = [m["key"] for m in am]
            for pos, p in ctx.all_players():
                for k in keys:
                    val = p.get(k)
                    assert isinstance(val, (int, float)) and math.isfinite(float(val)), f"{pos} {p.get('name')} {k}={val!r}"
            return f"Zero NaN/Inf/None across {len(keys)} metrics"

        def t2_04() -> str:
            meta = ctx.meta()
            for k in ("positions", "hull_squad", "season", "club_name", "club_uid"):
                assert k in meta, f"meta missing legacy key {k}"
            for pos in ALL_POSITIONS:
                ds = ctx.pos_data(pos)
                for k in ("position", "season", "baseline_minutes", "metrics", "roles", "players"):
                    assert k in ds, f"{pos}.json missing legacy key {k}"
                p0 = ds["players"][0]
                assert "score_overall" in p0 and 0 <= float(p0["score_overall"]) <= 100
                assert any(k.startswith("pct_") for k in p0)
                assert any(k.startswith("score_") for k in p0)
            return "All legacy M2 keys preserved"

        def t2_05() -> str:
            am_by_uid = {str(p["uid"]): p for p in ctx.pos_data("AM")["players"]}
            cm_by_uid = {str(p["uid"]): p for p in ctx.pos_data("CM")["players"]}
            shared = set(am_by_uid) & set(cm_by_uid)
            assert "28126248" in shared or len(shared) > 0, "No shared AM/CM players"
            fields = ("img_id", "club_img_id", "league", "league_id", "nation", "foot", "left_foot", "right_foot")
            for u in list(shared)[:50]:
                a, c = am_by_uid[u], cm_by_uid[u]
                for f in fields:
                    assert f in a and f in c, f"Missing {f} in AM/CM"
                    assert a[f] == c[f], f"UID {u} field {f} differs: {a[f]!r} != {c[f]!r}"
            return f"Cross-position parity verified across {min(50, len(shared))} shared players"

        cases.extend([
            ("F6-T2-01", 2, t2_01),
            ("F6-T2-02", 2, t2_02),
            ("F6-T2-03", 2, t2_03),
            ("F6-T2-04", 2, t2_04),
            ("F6-T2-05", 2, t2_05),
        ])

    return cases


def _check_f7(ctx: BackendContext, tier: int) -> list[tuple[str, int, Callable[[], str]]]:
    cases: list[tuple[str, int, Callable[[], str]]] = []

    if tier in (0, 1):
        def t1_01() -> str:
            # Ensure main server's initial background walk has settled so it doesn't contend on disk I/O
            ctx.wait_main_graphics_warm("/api/img/person/28126249?name=James%20McAtee", timeout=60.0)
            with EphemeralServer(timeout=15.0) as srv:
                elapsed = srv.bind_elapsed_s
                assert elapsed < 2.0, f"Cold bind + /api/status took {elapsed:.3f}s (>= 2.0s)"
                return f"Cold bind + /api/status in {elapsed:.3f}s (<2.0s)"

        def t1_02() -> str:
            for path in ("/api/img/person/28126249?name=James%20McAtee", "/api/img/club/650?name=Everton", "/api/img/comp/11?name=Premier%20League"):
                st, hdrs, body = ctx.wait_main_graphics_warm(path, timeout=60.0)
                assert st == 200, f"{path} returned HTTP {st}"
                assert hdrs.get("content-type", "").startswith("image/png"), f"{path} Content-Type={hdrs.get('content-type')!r}"
                assert body.startswith(b"\x89PNG\r\n\x1a\n"), f"{path} body not PNG"
            return "Symlinked FM27->FM26 graphics served for person/club/comp"

        def t1_03() -> str:
            srv, _ = ctx.temp_gfx_server()
            st, hdrs, body = http_get(f"{srv.base_url}/api/img/club/777777?name=Custom")
            assert st == 200, f"HTTP {st}"
            assert hdrs.get("content-type", "").startswith("image/png"), f"Content-Type={hdrs.get('content-type')!r}"
            assert body == TINY_PNG, "Did not serve c1.png from FM27_GRAPHICS_DIR"
            return "FM27_GRAPHICS_DIR override served custom club PNG"

        def t1_04() -> str:
            srv, gfx = ctx.temp_gfx_server()
            st0, hdrs0, _ = http_get(f"{srv.base_url}/api/img/club/888888?name=New")
            assert st0 == 200, f"Initial HTTP {st0}"
            assert "image/svg+xml" in hdrs0.get("content-type", ""), f"Expected SVG initially, got {hdrs0.get('content-type')!r}"

            cfg_path = gfx / "dynamic" / "config.xml"
            cfg_path.write_text(
                "<record>\n"
                '  <list id="maps">\n'
                '    <record from="c2" to="graphics/pictures/club/888888/logo"/>\n'
                "  </list>\n"
                "</record>\n",
                encoding="utf-8",
            )
            now = time.time() + 3.0
            os.utime(cfg_path, (now, now))

            deadline = time.monotonic() + 33.0
            got_png = False
            last_ct = ""
            while time.monotonic() < deadline:
                st1, hdrs1, body1 = http_get(f"{srv.base_url}/api/img/club/888888?name=New")
                last_ct = hdrs1.get("content-type", "")
                if st1 == 200 and last_ct.startswith("image/png") and body1 == TINY_PNG_ALT:
                    got_png = True
                    break
                time.sleep(0.5)
            assert got_png, f"Mtime-cached reload did not pick up new config.xml entry (last Content-Type={last_ct!r})"
            return "Mtime-cached reload picked up new config.xml mapping"

        def t1_05() -> str:
            st, hdrs, body = ctx.wait_main_graphics_warm("/api/img/club/216?name=Club216", timeout=15.0)
            assert st == 200, f"HTTP {st}"
            assert hdrs.get("content-type", "").startswith("image/png"), f"Content-Type={hdrs.get('content-type')!r}"
            assert body.startswith(b"\x89PNG\r\n\x1a\n")
            return "Whitespace-trimmed config.xml 'from' matched club/216"

        cases.extend([
            ("F7-T1-01", 1, t1_01),
            ("F7-T1-02", 1, t1_02),
            ("F7-T1-03", 1, t1_03),
            ("F7-T1-04", 1, t1_04),
            ("F7-T1-05", 1, t1_05),
        ])

    if tier in (0, 2):
        def t2_01() -> str:
            srv = ctx.nonexistent_gfx_server()
            st_s, _, _ = http_get(f"{srv.base_url}/api/status")
            assert st_s == 200
            st_i, hdrs_i, body_i = http_get(f"{srv.base_url}/api/img/person/28126249?name=James%20McAtee")
            assert st_i == 200, f"Expected 200 SVG fallback, got {st_i}"
            assert "image/svg+xml" in hdrs_i.get("content-type", ""), f"Expected SVG, got {hdrs_i.get('content-type')!r}"
            assert b"<svg" in body_i
            return "Nonexistent FM27_GRAPHICS_DIR degraded gracefully to 200 SVG"

        def t2_02() -> str:
            srv, _ = ctx.temp_gfx_server()
            st, hdrs, body = http_get(f"{srv.base_url}/api/img/club/101?name=Good")
            assert st == 200, f"HTTP {st}"
            assert hdrs.get("content-type", "").startswith("image/png"), f"Content-Type={hdrs.get('content-type')!r}"
            assert body == TINY_PNG
            return "Malformed config.xml skipped without breaking valid config.xml"

        def t2_03() -> str:
            srv, _ = ctx.temp_gfx_server()
            for cid in ("909", "910"):
                st, hdrs, body = http_get(f"{srv.base_url}/api/img/club/{cid}?name=Evil")
                assert st == 200, f"HTTP {st}"
                assert "image/svg+xml" in hdrs.get("content-type", ""), f"Traversal cid {cid} returned {hdrs.get('content-type')!r}"
                assert b"root:" not in body and body != TINY_PNG
            return "Path traversal in config.xml rejected safely"

        def t2_04() -> str:
            for raw in ("/api/img/person/../../etc/passwd", "/api/img/club/%2e%2e%2fsecret", "/seasons/../../scouting/server.py"):
                st, _, body = raw_http_get(ctx.base_url, raw)
                assert st < 500, f"{raw} caused HTTP {st}"
                assert b"root:" not in body and b"ScoutHandler" not in body, f"{raw} leaked sensitive file!"
            return "HTTP URL traversal attempts blocked cleanly"

        def t2_05() -> str:
            st, hdrs, body = ctx.wait_main_graphics_warm("/api/img/person/28126249?name=James%20McAtee", timeout=15.0)
            assert st == 200 and hdrs.get("content-type", "").startswith("image/png"), f"HTTP {st} {hdrs.get('content-type')}"
            assert len(body) > 10000, f"Expected full portrait (>10KB), got {len(body)}B (icon?)"
            srv, _ = ctx.temp_gfx_server()
            st2, hdrs2, body2 = http_get(f"{srv.base_url}/api/img/person/555555?name=IconOnly")
            assert st2 == 200 and hdrs2.get("content-type", "").startswith("image/png") and body2 == TINY_PNG_ALT, f"Icon fallback failed: {st2} {hdrs2.get('content-type')}"
            return f"Portrait prioritized ({len(body)}B) + icon-only fallback works"

        cases.extend([
            ("F7-T2-01", 2, t2_01),
            ("F7-T2-02", 2, t2_02),
            ("F7-T2-03", 2, t2_03),
            ("F7-T2-04", 2, t2_04),
            ("F7-T2-05", 2, t2_05),
        ])

    return cases


def _check_f8(ctx: BackendContext, tier: int) -> list[tuple[str, int, Callable[[], str]]]:
    cases: list[tuple[str, int, Callable[[], str]]] = []

    if tier in (0, 1):
        def t1_01() -> str:
            st, hdrs, body = ctx.wait_main_graphics_warm("/api/img/person/28126249?name=James%20McAtee")
            assert st == 200, f"HTTP {st}"
            assert hdrs.get("content-type", "").startswith("image/png"), f"CT={hdrs.get('content-type')}"
            assert hdrs.get("cache-control") == "public, max-age=86400", f"CC={hdrs.get('cache-control')}"
            assert body.startswith(b"\x89PNG\r\n\x1a\n")
            return "Person portrait 200 image/png + Cache-Control 86400"

        def t1_02() -> str:
            for path in ("/api/img/club/650?name=Everton", "/api/img/club/665?name=Hull%20City"):
                st, hdrs, body = ctx.wait_main_graphics_warm(path)
                assert st == 200 and hdrs.get("content-type", "").startswith("image/png"), f"{path}: {st} {hdrs.get('content-type')}"
                assert hdrs.get("cache-control") == "public, max-age=86400", f"CC={hdrs.get('cache-control')}"
                assert body.startswith(b"\x89PNG\r\n\x1a\n")
            return "Club logos 650 & 665 200 image/png"

        def t1_03() -> str:
            for path in ("/api/img/comp/11?name=Premier%20League", "/api/img/comp/50?name=Allsvenskan"):
                st, hdrs, body = ctx.wait_main_graphics_warm(path)
                assert st == 200 and hdrs.get("content-type", "").startswith("image/png"), f"{path}: {st} {hdrs.get('content-type')}"
                assert hdrs.get("cache-control") == "public, max-age=86400", f"CC={hdrs.get('cache-control')}"
                assert body.startswith(b"\x89PNG\r\n\x1a\n")
            return "Comp logos 11 & 50 200 image/png"

        def t1_04() -> str:
            srv, _ = ctx.temp_gfx_server()
            checks = [
                ("/api/img/person/1?name=A", "image/jpeg", TINY_JPG),
                ("/api/img/club/2?name=B", "image/jpeg", TINY_JPG),
                ("/api/img/comp/3?name=C", "image/webp", TINY_WEBP),
            ]
            for path, exp_ct, exp_body in checks:
                st, hdrs, body = http_get(f"{srv.base_url}{path}")
                assert st == 200, f"{path}: HTTP {st}"
                assert hdrs.get("content-type", "").startswith(exp_ct), f"{path}: CT={hdrs.get('content-type')}"
                assert hdrs.get("cache-control") == "public, max-age=86400"
                assert body == exp_body
            return "JPG, JPEG, WebP Content-Types & Cache-Control verified"

        def t1_05() -> str:
            st, hdrs, body = http_get(f"{ctx.base_url}/api/img/person/999999999?name=Test%20Player")
            assert st == 200, f"HTTP {st}"
            assert "image/svg+xml" in hdrs.get("content-type", ""), f"CT={hdrs.get('content-type')}"
            root = ET.fromstring(body.decode("utf-8"))
            assert root.tag.endswith("svg")
            txt = "".join(root.itertext())
            assert "TP" in txt, f"Expected 'TP' initials in SVG, got {txt!r}"
            return "Missing person returned 200 SVG monogram 'TP'"

        def t1_06() -> str:
            for path, exp_init in (("/api/img/club/999999999?name=Hull%20City", "HC"), ("/api/img/comp/999999999?name=Premier%20League", "PL")):
                st, hdrs, body = http_get(f"{ctx.base_url}{path}")
                assert st == 200, f"{path}: HTTP {st}"
                assert "image/svg+xml" in hdrs.get("content-type", ""), f"CT={hdrs.get('content-type')}"
                root = ET.fromstring(body.decode("utf-8"))
                assert root.tag.endswith("svg")
                txt = "".join(root.itertext())
                assert exp_init in txt, f"{path}: expected {exp_init!r} in SVG text {txt!r}"
            return "Missing club/comp returned 200 SVG shields ('HC', 'PL')"

        cases.extend([
            ("F8-T1-01", 1, t1_01),
            ("F8-T1-02", 1, t1_02),
            ("F8-T1-03", 1, t1_03),
            ("F8-T1-04", 1, t1_04),
            ("F8-T1-05", 1, t1_05),
            ("F8-T1-06", 1, t1_06),
        ])

    if tier in (0, 2):
        def t2_01() -> str:
            for q in ("%3Cscript%3Ealert(1)%3C/script%3E", "%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E"):
                st, hdrs, body = http_get(f"{ctx.base_url}/api/img/person/999999999?name={q}")
                assert st == 200 and "image/svg+xml" in hdrs.get("content-type", ""), f"HTTP {st}"
                s = body.decode("utf-8")
                ET.fromstring(s)
                low = s.lower()
                assert "<script" not in low and "<img" not in low and "onerror=" not in low, f"XSS leaked: {s[:200]}"
            return "XSS payloads safely escaped/stripped in SVG"

        def t2_02() -> str:
            for path in ("/api/img/person/999999999", "/api/img/club/999999999?name="):
                st, hdrs, body = http_get(f"{ctx.base_url}{path}")
                assert st == 200 and "image/svg+xml" in hdrs.get("content-type", ""), f"{path}: {st}"
                root = ET.fromstring(body.decode("utf-8"))
                txt = "".join(root.itertext()).strip()
                assert len(txt) >= 1, f"{path}: empty fallback text"
            return "Missing/empty ?name= produced valid non-empty SVG"

        def t2_03() -> str:
            for q in ("Stefan%20Baj%C4%8Deti%C4%87", "O'Connor-Smith", "%20%20%20"):
                st, hdrs, body = http_get(f"{ctx.base_url}/api/img/person/999999999?name={q}")
                assert st == 200 and "image/svg+xml" in hdrs.get("content-type", ""), f"{q}: {st}"
                ET.fromstring(body.decode("utf-8"))
            return "Unicode, punctuation, whitespace ?name= handled cleanly"

        def t2_04() -> str:
            for q in ("Ronaldo", "Real%20Madrid%20Club%20de%20Futbol"):
                st, hdrs, body = http_get(f"{ctx.base_url}/api/img/person/999999999?name={q}")
                assert st == 200 and "image/svg+xml" in hdrs.get("content-type", ""), f"{q}: {st}"
                root = ET.fromstring(body.decode("utf-8"))
                txt = "".join(root.itertext()).strip()
                assert 1 <= len(txt) <= 3, f"{q}: unexpected initials {txt!r}"
            return "Single-word & multi-word initials stay compact"

        def t2_05() -> str:
            for path in ("/api/img/stadium/123?name=MKM", "/api/img/unknown/123"):
                st, _, _ = http_get(f"{ctx.base_url}{path}")
                assert st < 500, f"{path}: returned 5xx ({st})"
                assert st in (200, 400, 404), f"{path}: unexpected status {st}"
            return "Unknown image kind handled without 500"

        def t2_06() -> str:
            st_uid, h_uid, _ = ctx.wait_main_graphics_warm("/api/img/person/28126248?name=James%20McAtee")
            st_iid, h_iid, _ = ctx.wait_main_graphics_warm("/api/img/person/28126249?name=James%20McAtee")
            assert st_uid == 200 and "image/svg+xml" in h_uid.get("content-type", ""), f"uid 28126248 got {st_uid} {h_uid.get('content-type')}"
            assert st_iid == 200 and h_iid.get("content-type", "").startswith("image/png"), f"img_id 28126249 got {st_iid} {h_iid.get('content-type')}"

            st_cuid, h_cuid, _ = ctx.wait_main_graphics_warm("/api/img/club/649?name=Everton")
            st_ciid, h_ciid, _ = ctx.wait_main_graphics_warm("/api/img/club/650?name=Everton")
            assert st_cuid == 200 and "image/svg+xml" in h_cuid.get("content-type", "")
            assert st_ciid == 200 and h_ciid.get("content-type", "").startswith("image/png")
            return "End-to-end proof: uid misses (SVG), unique_id hits (PNG)"

        cases.extend([
            ("F8-T2-01", 2, t2_01),
            ("F8-T2-02", 2, t2_02),
            ("F8-T2-03", 2, t2_03),
            ("F8-T2-04", 2, t2_04),
            ("F8-T2-05", 2, t2_05),
            ("F8-T2-06", 2, t2_06),
        ])

    return cases


def _check_f9_backend(ctx: BackendContext, tier: int) -> list[tuple[str, int, Callable[[], str]]]:
    cases: list[tuple[str, int, Callable[[], str]]] = []
    assets = [
        ("echarts/echarts.min.js", 500_000, ("application/javascript", "text/javascript")),
        ("tabulator/tabulator.min.js", 100_000, ("application/javascript", "text/javascript")),
        ("tabulator/tabulator.min.css", 10_000, ("text/css",)),
    ]

    if tier in (0, 1):
        def t1_01() -> str:
            sizes = {}
            for rel, min_sz, _ in assets:
                p = VENDOR_DIR / rel
                assert p.is_file(), f"Missing vendored file: {p}"
                sz = p.stat().st_size
                assert sz > min_sz, f"{rel} too small: {sz} <= {min_sz}"
                sizes[rel] = sz
            return f"Vendor bundles present: {sizes}"

        def t1_02() -> str:
            for rel, _, ctypes in assets:
                st, hdrs, _ = http_get(f"{ctx.base_url}/vendor/{rel}")
                assert st == 200, f"/vendor/{rel} returned HTTP {st}"
                ct = hdrs.get("content-type", "").split(";")[0].strip().lower()
                assert ct in ctypes, f"/vendor/{rel} Content-Type={ct!r} not in {ctypes}"
            return "All 3 /vendor/* endpoints return 200 with strict MIME types"

        def t1_03() -> str:
            allowed_ns = {
                "http://www.w3.org/2000/svg",
                "http://www.w3.org/1999/xlink",
                "http://www.w3.org/1999/xhtml",
            }
            ext_pat = re.compile(r"https?://[^\s'\"`<>)]+", re.I)
            hits = []
            for fn in ("index.html", "styles.css", "app.js"):
                p = APP_DIR / fn
                txt = p.read_text(encoding="utf-8")
                for i, line in enumerate(txt.splitlines(), 1):
                    for m in ext_pat.finditer(line):
                        url = m.group(0).rstrip(".,;:")
                        if url.rstrip("/").lower() not in allowed_ns:
                            hits.append(f"{fn}:{i}: {url[:80]}")
            assert not hits, f"External http/https URLs in scouting/app/: {hits}"
            return "Zero external http/https URLs in index.html, styles.css, app.js"

        cases.extend([
            ("F9-T1-01", 1, t1_01),
            ("F9-T1-02", 1, t1_02),
            ("F9-T1-03", 1, t1_03),
        ])

    if tier in (0, 2):
        def t2_03() -> str:
            for rel, _, _ in assets:
                st_h, hdrs_h, _ = http_request(f"{ctx.base_url}/vendor/{rel}", method="HEAD")
                assert st_h == 200, f"HEAD /vendor/{rel} -> {st_h}"
                cl = int(hdrs_h.get("content-length") or "0")
                assert cl > 0, f"HEAD /vendor/{rel} Content-Length={cl}"

            def _fetch(rel_path: str) -> tuple[int, int]:
                st, _, body = http_get(f"{ctx.base_url}/vendor/{rel_path}")
                return st, len(body)

            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                for rel, _, _ in assets:
                    futs = [pool.submit(_fetch, rel) for _ in range(10)]
                    res = [f.result() for f in futs]
                    assert all(st == 200 and ln > 0 for st, ln in res), f"Concurrent GET failed on {rel}: {res}"
            return "HEAD + 10 concurrent GETs per vendor asset succeeded"

        def t2_05() -> str:
            assert VENDOR_DIR.is_dir(), f"Missing {VENDOR_DIR}"
            bad = []
            for p in VENDOR_DIR.rglob("*"):
                if "node_modules" in p.parts or p.name in ("package.json", "package-lock.json"):
                    bad.append(str(p.relative_to(VENDOR_DIR)))
            assert not bad, f"Unexpected node_modules/npm artifacts in vendor/: {bad[:5]}"
            return "Clean vendor/ directory (no node_modules or lockfiles)"

        cases.extend([
            ("F9-T2-03", 2, t2_03),
            ("F9-T2-05", 2, t2_05),
        ])

    return cases


def run_m2_m3_backend_tests(base_url: str, tier: int = 0) -> list[CaseResult]:
    ctx = BackendContext(base_url)
    specs: list[tuple[str, str, int, Callable[[], str]]] = []
    try:
        for cid, ctier, fn in _check_f4(ctx, tier):
            specs.append((cid, "F4", ctier, fn))
        for cid, ctier, fn in _check_f5(ctx, tier):
            specs.append((cid, "F5", ctier, fn))
        for cid, ctier, fn in _check_f6(ctx, tier):
            specs.append((cid, "F6", ctier, fn))
        for cid, ctier, fn in _check_f7(ctx, tier):
            specs.append((cid, "F7", ctier, fn))
        for cid, ctier, fn in _check_f8(ctx, tier):
            specs.append((cid, "F8", ctier, fn))
        for cid, ctier, fn in _check_f9_backend(ctx, tier):
            specs.append((cid, "F9", ctier, fn))

        results: list[CaseResult] = []
        for cid, feat, ctier, fn in specs:
            t0 = time.perf_counter()
            try:
                detail = fn()
                dt = (time.perf_counter() - t0) * 1000.0
                results.append(CaseResult(cid, feat, ctier, True, dt, detail))
            except Exception as exc:
                dt = (time.perf_counter() - t0) * 1000.0
                results.append(CaseResult(cid, feat, ctier, False, dt, str(exc)))
        return results
    finally:
        ctx.cleanup()


if __name__ == "__main__":
    req_tier = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    env_url = os.environ.get("BASE_URL")
    if env_url:
        res = run_m2_m3_backend_tests(env_url, req_tier)
    else:
        with EphemeralServer() as srv:
            res = run_m2_m3_backend_tests(srv.base_url, req_tier)
    fails = 0
    for r in res:
        tag = "[PASS]" if r.passed else "[FAIL]"
        if not r.passed:
            fails += 1
        print(f"{tag} {r.id} ({r.duration_ms:.1f}ms) - {r.detail}")
    sys.exit(1 if fails else 0)
