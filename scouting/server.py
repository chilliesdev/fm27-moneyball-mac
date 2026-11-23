"""Local HTTP server for FM27 Moneyball Scout with save pickup, progressive seasons, and graphics indexing."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import posixpath
import re
import shutil
import signal
import stat
import sys
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import build_moneyball

HOST = "127.0.0.1"
PORT = 8727
APP_DIR = build_moneyball.SCOUTING_DIR / "app"
SEASONS_DIR = build_moneyball.SEASONS_DIR
DEFAULT_GRAPHICS_DIR = (
    Path.home()
    / "Library"
    / "Application Support"
    / "Sports Interactive"
    / "Football Manager 27"
    / "graphics"
)

SUPPORTED_EXTS: tuple[str, ...] = (".png", ".jpg", ".jpeg", ".webp")
EXT_CONTENT_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
VALID_IMAGE_KINDS: frozenset[str] = frozenset({"person", "club", "comp"})
REFRESH_INTERVAL_SEC = 30.0
MAX_REFRESH_BODY_BYTES = 1_048_576
MAX_CONFIG_XML_BYTES = 64 * 1024 * 1024

_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_XML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_RECORD_TAG_RE = re.compile(r"<record\b([^>]*)/?>", re.IGNORECASE | re.DOTALL)
_ATTR_RE = re.compile(r"""\b(from|to)\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.IGNORECASE)
_WORD_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)

# 12 jewel/slate tones paired with subtle inner border accents for high-contrast #f8fafc text
_SVG_PALETTE: tuple[tuple[str, str], ...] = (
    ("#4338ca", "#818cf8"),
    ("#1d4ed8", "#60a5fa"),
    ("#0369a1", "#38bdf8"),
    ("#0f766e", "#2dd4bf"),
    ("#047857", "#34d399"),
    ("#b45309", "#fbbf24"),
    ("#c2410c", "#fb923c"),
    ("#be123c", "#fb7185"),
    ("#6d28d9", "#a78bfa"),
    ("#334155", "#94a3b8"),
    ("#1e40af", "#93c5fd"),
    ("#7e22ce", "#c084fc"),
)

_LOCK = threading.RLock()
_STATE: dict[str, Any] = {
    "building": False,
    "last_error": None,
    "last_built": None,
}


def _parse_config_records(raw_bytes: bytes) -> list[tuple[str, str]]:
    """Parse `<record from=... to=.../>` pairs from a Football Manager config.xml file."""
    records: list[tuple[str, str]] = []
    try:
        root = ET.fromstring(raw_bytes)
        for el in root.iter():
            if el.tag.rsplit("}", 1)[-1].lower() == "record":
                frm = el.attrib.get("from")
                to = el.attrib.get("to")
                if frm is None or to is None:
                    for k, v in el.attrib.items():
                        kl = k.lower()
                        if kl == "from" and frm is None:
                            frm = v
                        elif kl == "to" and to is None:
                            to = v
                if frm is not None and to is not None:
                    records.append((frm, to))
        return records
    except ET.ParseError:
        text = raw_bytes.decode("utf-8", errors="replace")
        text = _XML_COMMENT_RE.sub("", text)
        for match in _RECORD_TAG_RE.finditer(text):
            attrs_text = match.group(1)
            frm: str | None = None
            to: str | None = None
            for attr_match in _ATTR_RE.finditer(attrs_text):
                key = attr_match.group(1).lower()
                val = html.unescape(
                    attr_match.group(2) if attr_match.group(2) is not None else attr_match.group(3) or ""
                )
                if key == "from":
                    frm = val
                elif key == "to":
                    to = val
            if frm is not None and to is not None:
                records.append((frm, to))
        return records


def _read_regular_config_bytes(
    cfg_path: Path, cfg_rp: Path, resolved_root: Path
) -> bytes | None:
    """Safely read a regular, root-contained config.xml without blocking on FIFOs/devices."""
    fd = -1
    fh = None
    try:
        flags = (
            os.O_RDONLY
            | getattr(os, "O_NONBLOCK", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        fd = os.open(cfg_rp, flags)
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or fst.st_size > MAX_CONFIG_XML_BYTES:
            return None
        re_rp = cfg_path.resolve(strict=True)
        if not (re_rp.is_relative_to(resolved_root) and re_rp != resolved_root):
            return None
        re_st = os.stat(re_rp)
        if (fst.st_dev, fst.st_ino) != (re_st.st_dev, re_st.st_ino):
            return None
        fh = os.fdopen(fd, "rb")
        fd = -1
        raw_bytes = fh.read(MAX_CONFIG_XML_BYTES + 1)
        if len(raw_bytes) > MAX_CONFIG_XML_BYTES:
            return None
        return raw_bytes
    except OSError:
        return None
    finally:
        if fh is not None:
            try:
                fh.close()
            except OSError:
                pass
        elif fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


class GraphicsIndex:
    """Background-warmed, mtime-cached FM27 graphics config.xml indexer."""

    def __init__(self, root: Path | str, refresh_interval: float = REFRESH_INTERVAL_SEC) -> None:
        self._root = Path(root).expanduser()
        self._refresh_interval = max(0.0, float(refresh_interval))
        self._lock = threading.RLock()
        self._generation = 0
        self._dirs: list[Path] = []
        self._entries: dict[tuple[str, str], list[tuple[int, int, int, str]]] = {}
        self._config_mtimes: dict[str, int] = {}
        self._resolved_root: Path | None = None
        self._resolved_cache: dict[tuple[str, str], Path | None] = {}
        self._ready = False
        self._is_warming = False
        self._refreshing = False
        self._last_check_ts = 0.0
        self._entry_count = 0

    @property
    def is_warm(self) -> bool:
        with self._lock:
            return self._ready

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "ready": self._ready,
                "warm": self._ready,
                "is_warming": self._is_warming,
                "refreshing": self._refreshing,
                "graphics_dir": str(self._root),
                "config_count": len(self._config_mtimes),
                "entry_count": self._entry_count,
            }

    def start_warmup(self) -> None:
        with self._lock:
            if self._ready or self._is_warming:
                return
            if not self._root.is_dir():
                self._ready = True
                self._is_warming = False
                self._refreshing = False
                self._last_check_ts = time.monotonic()
                return
            self._is_warming = True
        thread = threading.Thread(
            target=self._run_refresh,
            kwargs={"is_initial": True},
            name="graphics-warmup",
            daemon=True,
        )
        thread.start()

    def maybe_schedule_refresh(self) -> bool:
        with self._lock:
            now = time.monotonic()
            if not self._ready or self._refreshing:
                return False
            if (now - self._last_check_ts) < self._refresh_interval:
                return False
            self._refreshing = True
            self._last_check_ts = now
        thread = threading.Thread(
            target=self._run_refresh,
            kwargs={"is_initial": False},
            name="graphics-refresh",
            daemon=True,
        )
        thread.start()
        return True

    def trigger_refresh(self) -> bool:
        with self._lock:
            if self._is_warming or self._refreshing:
                return False
            if not self._ready:
                self._is_warming = True
                is_initial = True
            else:
                self._refreshing = True
                self._last_check_ts = time.monotonic()
                is_initial = False
        thread = threading.Thread(
            target=self._run_refresh,
            kwargs={"is_initial": is_initial},
            name="graphics-refresh",
            daemon=True,
        )
        thread.start()
        return True

    def _run_refresh(self, is_initial: bool = False) -> None:
        with self._lock:
            prev_mtimes = None if is_initial else dict(self._config_mtimes)
        try:
            result = self._scan_and_build(prev_mtimes=prev_mtimes, is_initial=is_initial)
            if result is not None:
                dirs, entries, config_mtimes, resolved_root, entry_count = result
                with self._lock:
                    self._dirs = dirs
                    self._entries = entries
                    self._config_mtimes = config_mtimes
                    self._resolved_root = resolved_root
                    self._resolved_cache.clear()
                    self._entry_count = entry_count
                    self._generation += 1
                    self._ready = True
        except Exception:
            with self._lock:
                if is_initial and not self._ready:
                    self._ready = True
        finally:
            with self._lock:
                self._is_warming = False
                self._refreshing = False
                self._last_check_ts = time.monotonic()

    def _scan_and_build(
        self, prev_mtimes: dict[str, int] | None, is_initial: bool
    ) -> tuple[
        list[Path],
        dict[tuple[str, str], list[tuple[int, int, int, str]]],
        dict[str, int],
        Path | None,
        int,
    ] | None:
        if not self._root.is_dir():
            if not is_initial and prev_mtimes == {}:
                return None
            return ([], {}, {}, None, 0)

        try:
            resolved_root = self._root.resolve(strict=True)
            root_st = os.stat(resolved_root)
        except OSError:
            if not is_initial and prev_mtimes == {}:
                return None
            return ([], {}, {}, None, 0)

        seen_dirs: set[tuple[int, int]] = {(root_st.st_dev, root_st.st_ino)}
        config_paths: list[Path] = []
        new_mtimes: dict[str, int] = {}

        for dirpath, dirnames, filenames in os.walk(
            self._root, followlinks=True, onerror=lambda _e: None
        ):
            try:
                cur_dir_rp = Path(dirpath).resolve(strict=True)
            except OSError:
                dirnames[:] = []
                continue
            if not cur_dir_rp.is_relative_to(resolved_root):
                dirnames[:] = []
                continue

            kept: list[str] = []
            for dname in dirnames:
                dpath = os.path.join(dirpath, dname)
                try:
                    st = os.stat(dpath)
                    if not stat.S_ISDIR(st.st_mode):
                        continue
                    dir_rp = Path(dpath).resolve(strict=True)
                except OSError:
                    continue
                if not dir_rp.is_relative_to(resolved_root):
                    continue
                dir_key = (st.st_dev, st.st_ino)
                if dir_key not in seen_dirs:
                    seen_dirs.add(dir_key)
                    kept.append(dname)
            dirnames[:] = kept

            for fname in filenames:
                if fname.lower() == "config.xml":
                    cfg_path = Path(dirpath) / fname
                    try:
                        cfg_rp = cfg_path.resolve(strict=True)
                        if not (cfg_rp.is_relative_to(resolved_root) and cfg_rp != resolved_root):
                            continue
                        st = os.stat(cfg_rp)
                    except OSError:
                        continue
                    if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_CONFIG_XML_BYTES:
                        continue
                    config_paths.append(cfg_path)
                    new_mtimes[str(cfg_path)] = st.st_mtime_ns

        if not is_initial and prev_mtimes is not None and new_mtimes == prev_mtimes:
            return None

        config_paths.sort()
        dirs: list[Path] = []
        entries: dict[tuple[str, str], list[tuple[int, int, int, str]]] = {}
        entry_count = 0

        for cfg_path in config_paths:
            base_dir = cfg_path.parent
            try:
                base_dir_rp = base_dir.resolve(strict=True)
                if not base_dir_rp.is_relative_to(resolved_root):
                    new_mtimes.pop(str(cfg_path), None)
                    continue
                cfg_rp = cfg_path.resolve(strict=True)
                if not (cfg_rp.is_relative_to(resolved_root) and cfg_rp != resolved_root):
                    new_mtimes.pop(str(cfg_path), None)
                    continue
            except OSError:
                new_mtimes.pop(str(cfg_path), None)
                continue

            raw_bytes = _read_regular_config_bytes(cfg_path, cfg_rp, resolved_root)
            if raw_bytes is None:
                new_mtimes.pop(str(cfg_path), None)
                continue

            rel_parts = [p.lower() for p in base_dir_rp.relative_to(resolved_root).parts]
            gender_prio = 1 if "women" in rel_parts else 0
            dir_idx = len(dirs)
            dirs.append(base_dir)

            for raw_from, raw_to in _parse_config_records(raw_bytes):
                if not raw_from or not raw_to or not raw_from.strip():
                    continue
                parts = raw_to.strip().lower().replace("\\", "/").strip("/").split("/")
                if len(parts) < 5 or parts[0] != "graphics" or parts[1] != "pictures":
                    continue
                kind, oid, role = parts[2], parts[3], parts[4]
                if not oid:
                    continue
                if kind == "person" and role == "portrait":
                    role_prio = 0
                elif kind == "person" and role == "icon":
                    role_prio = 1
                elif kind in ("club", "comp") and role == "logo":
                    role_prio = 0
                else:
                    continue

                entries.setdefault((kind, oid), []).append(
                    (role_prio, gender_prio, dir_idx, raw_from)
                )
                entry_count += 1

        for cands in entries.values():
            cands.sort(key=lambda item: (item[0], item[1], item[2]))

        return (dirs, entries, new_mtimes, resolved_root, entry_count)

    def invalidate(self, kind: str, item_id: str, expected_path: Path | None = None) -> None:
        norm_id = item_id.strip().lower()
        key = (kind, norm_id)
        with self._lock:
            if expected_path is None or self._resolved_cache.get(key) == expected_path:
                self._resolved_cache.pop(key, None)
            self._generation += 1

    def verify_contained_path(self, candidate: Path) -> Path | None:
        with self._lock:
            resolved_root = self._resolved_root
        if resolved_root is None:
            return None
        try:
            rp = candidate.resolve()
            if (
                rp.is_relative_to(resolved_root)
                and rp != resolved_root
                and rp.suffix.lower() in SUPPORTED_EXTS
                and rp.is_file()
            ):
                return rp
        except OSError:
            return None
        return None

    def resolve(self, kind: str, item_id: str) -> tuple[Path | None, bool]:
        norm_id = item_id.strip().lower()
        if kind not in VALID_IMAGE_KINDS or not norm_id:
            return (None, self.is_warm)

        self.maybe_schedule_refresh()

        key = (kind, norm_id)
        with self._lock:
            if not self._ready:
                return (None, False)
            gen = self._generation
            has_cached = key in self._resolved_cache
            cached_path = self._resolved_cache.get(key)
            candidates = list(self._entries.get(key, ()))
            dirs = self._dirs
            resolved_root = self._resolved_root

        if has_cached:
            if cached_path is None:
                return (None, True)
            if resolved_root is not None:
                try:
                    rp = cached_path.resolve()
                    if (
                        rp.is_relative_to(resolved_root)
                        and rp != resolved_root
                        and rp.suffix.lower() in SUPPORTED_EXTS
                        and rp.is_file()
                    ):
                        return (rp, True)
                except OSError:
                    pass
            with self._lock:
                if self._generation == gen and self._resolved_cache.get(key) == cached_path:
                    self._resolved_cache.pop(key, None)
                    self._generation += 1
                gen = self._generation
                candidates = list(self._entries.get(key, ()))
                dirs = self._dirs
                resolved_root = self._resolved_root

        if resolved_root is None or not candidates:
            with self._lock:
                if self._ready and self._generation == gen:
                    self._resolved_cache[key] = None
            return (None, True)

        for _role_prio, _gender_prio, dir_idx, raw_from in candidates:
            base_dir = dirs[dir_idx]
            stripped = raw_from.strip()
            stems = [stripped] + ([raw_from] if raw_from != stripped else [])
            for stem in stems:
                if not stem or "\x00" in stem or os.path.isabs(stem) or Path(stem).is_absolute():
                    continue
                stem_path = Path(stem)
                if stem_path.suffix.lower() in SUPPORTED_EXTS:
                    probe_paths = [base_dir / stem]
                else:
                    probe_paths = [base_dir / f"{stem}{ext}" for ext in SUPPORTED_EXTS]

                for cand in probe_paths:
                    try:
                        rp = cand.resolve()
                        if (
                            rp.is_relative_to(resolved_root)
                            and rp != resolved_root
                            and rp.suffix.lower() in SUPPORTED_EXTS
                            and rp.is_file()
                        ):
                            with self._lock:
                                if self._ready and self._generation == gen:
                                    self._resolved_cache[key] = rp
                            return (rp, True)
                    except OSError:
                        continue

        with self._lock:
            if self._ready and self._generation == gen:
                self._resolved_cache[key] = None
        return (None, True)


def _extract_initials(name: str, kind: str) -> str:
    clean = "".join(ch for ch in name if ord(ch) >= 32).strip()
    tokens = _WORD_TOKEN_RE.findall(clean)
    if len(tokens) >= 2:
        if kind == "person":
            raw_initials = tokens[0][0] + tokens[-1][0]
        else:
            raw_initials = tokens[0][0] + tokens[1][0]
        return raw_initials.upper()[:2]
    if len(tokens) == 1:
        return tokens[0][:2].upper()[:2]
    if kind == "person":
        return "?"
    if kind == "comp":
        return "CP"
    return "FC"


def build_fallback_svg(kind: str, item_id: str, name: str) -> bytes:
    """Render a deterministic 64x64 inline SVG monogram (person) or shield (club/comp)."""
    seed = f"{kind}:{item_id or name}".encode("utf-8", errors="replace")
    digest = hashlib.sha256(seed).digest()
    bg, accent = _SVG_PALETTE[digest[0] % len(_SVG_PALETTE)]
    initials = html.escape(_extract_initials(name, kind), quote=True)
    font_size = "22" if len(initials) <= 2 else "18"

    if kind == "person":
        shape = (
            f'<circle cx="32" cy="32" r="29" fill="{bg}" '
            f'stroke="rgba(255,255,255,0.24)" stroke-width="2"/>'
            f'<circle cx="32" cy="32" r="26" fill="none" '
            f'stroke="{accent}" stroke-opacity="0.35" stroke-width="1"/>'
        )
        text_y = "33"
    elif kind == "comp":
        shape = (
            f'<path d="M32 4L56 12V30C56 45.5 45.5 55.5 32 60C18.5 55.5 8 45.5 8 30V12Z" '
            f'fill="{bg}" stroke="#fbbf24" stroke-opacity="0.72" stroke-width="2.2"/>'
            f'<path d="M32 8L52 14.8V30C52 42.8 43.2 51.4 32 55.4C20.8 51.4 12 42.8 12 30V14.8Z" '
            f'fill="none" stroke="#fde68a" stroke-opacity="0.45" stroke-width="1.2"/>'
        )
        text_y = "32"
    else:
        shape = (
            f'<path d="M32 4L56 12V30C56 45.5 45.5 55.5 32 60C18.5 55.5 8 45.5 8 30V12Z" '
            f'fill="{bg}" stroke="rgba(255,255,255,0.28)" stroke-width="2"/>'
            f'<path d="M32 8L52 14.8V30C52 42.8 43.2 51.4 32 55.4C20.8 51.4 12 42.8 12 30V14.8Z" '
            f'fill="none" stroke="{accent}" stroke-opacity="0.35" stroke-width="1"/>'
        )
        text_y = "32"

    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" '
        'viewBox="0 0 64 64" role="img" aria-label="Fallback badge">'
        f"{shape}"
        f'<text x="32" y="{text_y}" text-anchor="middle" dominant-baseline="central" '
        'fill="#f8fafc" font-family="-apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif" '
        f'font-size="{font_size}" font-weight="700" letter-spacing="0.02em">{initials}</text>'
        "</svg>"
    )
    return svg.encode("utf-8")


def _read_status(graphics_index: GraphicsIndex | None = None) -> dict[str, Any]:
    saves = build_moneyball.list_fm_saves()
    idx_path = SEASONS_DIR / "index.json"
    seasons_index: dict[str, Any] = {"latest_season": None, "seasons": []}
    if idx_path.exists():
        try:
            seasons_index = json.loads(idx_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    newest = saves[0] if saves else None
    latest_entry = next(
        (s for s in seasons_index.get("seasons", []) if s.get("season") == seasons_index.get("latest_season")),
        None,
    )
    stale = False
    if newest and latest_entry:
        stale = float(newest.get("mtime", 0)) > float(latest_entry.get("save_mtime", 0)) + 1.0
    elif newest and not latest_entry:
        stale = True

    with _LOCK:
        building = _STATE["building"]
        last_error = _STATE["last_error"]
        last_built = _STATE["last_built"]

    payload: dict[str, Any] = {
        "saves": saves,
        "latest_season": seasons_index.get("latest_season"),
        "seasons": seasons_index.get("seasons", []),
        "newest_save_stale": stale,
        "building": building,
        "last_error": last_error,
        "last_built": last_built,
    }
    if graphics_index is not None:
        payload["graphics"] = graphics_index.status()
    return payload


def _validate_save_path(raw_path: str | None) -> Path:
    """Validate and resolve a requested .fm save path, or pick the latest save."""
    if raw_path is None or not raw_path.strip():
        return build_moneyball.pick_latest_save()

    try:
        candidate = Path(raw_path).expanduser().resolve(strict=True)
    except OSError as exc:
        raise ValueError("Save file does not exist") from exc

    if not candidate.is_file() or candidate.suffix.lower() != ".fm":
        raise ValueError("Save path must be an existing .fm file")

    allowed_roots: list[Path] = []
    try:
        allowed_roots.append(build_moneyball.DEFAULT_GAMES_DIR.resolve())
    except OSError:
        pass
    for entry in build_moneyball.list_fm_saves():
        try:
            allowed_roots.append(Path(entry["path"]).resolve().parent)
        except (KeyError, OSError):
            continue

    if not any(candidate.is_relative_to(root) for root in allowed_roots):
        raise ValueError("Save path is outside the allowed saves directory")
    return candidate


def _run_build_job(target: Path) -> None:
    try:
        meta = build_moneyball.build_from_save(target)
        built = {
            "season": meta["season"],
            "in_game_date": meta["in_game_date"],
            "save_file": meta["save_file"],
            "club_name": meta["club_name"],
        }
        with _LOCK:
            _STATE["last_built"] = built
    except Exception as exc:
        with _LOCK:
            _STATE["last_error"] = f"{type(exc).__name__}: {exc}"
    finally:
        with _LOCK:
            _STATE["building"] = False


def _trigger_build(
    save_path_str: str | None, graphics_index: GraphicsIndex | None = None
) -> tuple[int, dict[str, Any]]:
    if graphics_index is not None:
        graphics_index.trigger_refresh()

    try:
        target = _validate_save_path(save_path_str)
    except (ValueError, FileNotFoundError) as exc:
        msg = f"{type(exc).__name__}: {exc}"
        with _LOCK:
            _STATE["last_error"] = msg
        return HTTPStatus.BAD_REQUEST, {
            "started": False,
            "error": msg,
            **_read_status(graphics_index),
        }

    with _LOCK:
        if _STATE["building"]:
            return HTTPStatus.OK, {
                "started": False,
                "reason": "already_building",
                **_read_status(graphics_index),
            }
        _STATE["building"] = True
        _STATE["last_error"] = None

    worker = threading.Thread(
        target=_run_build_job,
        args=(target,),
        name="moneyball-build",
        daemon=True,
    )
    worker.start()
    return HTTPStatus.ACCEPTED, {"started": True, **_read_status(graphics_index)}


class ScoutHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        RequestHandlerClass: type[SimpleHTTPRequestHandler],
        graphics_index: GraphicsIndex,
    ) -> None:
        self.graphics_index = graphics_index
        super().__init__(server_address, RequestHandlerClass)

    def handle_error(self, request: Any, client_address: Any) -> None:
        _, exc, _ = sys.exc_info()
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


class ScoutHandler(SimpleHTTPRequestHandler):
    extensions_map: dict[str, str] = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".map": "application/json",
    }

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._cache_control_sent = False
        self._last_status_code = 200
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    @property
    def graphics_index(self) -> GraphicsIndex:
        return self.server.graphics_index  # type: ignore[attr-defined, no-any-return]

    def send_response(self, code: int, message: str | None = None) -> None:
        self._cache_control_sent = False
        self._last_status_code = int(code)
        super().send_response(code, message)

    def send_header(self, keyword: str, value: str) -> None:
        if keyword.lower() == "cache-control":
            self._cache_control_sent = True
        super().send_header(keyword, value)

    def end_headers(self) -> None:
        if not getattr(self, "_cache_control_sent", False):
            parsed_path = urllib.parse.urlsplit(getattr(self, "path", "")).path
            norm_path = posixpath.normpath("/" + urllib.parse.unquote(parsed_path).lstrip("/"))
            if norm_path.startswith("/vendor/") and 200 <= self._last_status_code < 400:
                self.send_header("Cache-Control", "public, max-age=86400")
            elif not norm_path.startswith("/api/"):
                self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _safe_write(self, data: bytes) -> bool:
        try:
            self.wfile.write(data)
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
            return False

    def copyfile(self, source: Any, outputfile: Any) -> None:
        try:
            shutil.copyfileobj(source, outputfile)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True

    def _send_json(
        self, payload: dict[str, Any], code: int = HTTPStatus.OK, send_body: bool = True
    ) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if send_body:
            self._safe_write(body)

    def _send_svg_fallback(
        self, kind: str, item_id: str, name: str, is_ready: bool, send_body: bool = True
    ) -> None:
        svg_bytes = build_fallback_svg(kind, item_id, name)
        cache_ctl = "public, max-age=3600" if is_ready else "public, max-age=300"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
        self.send_header("Content-Length", str(len(svg_bytes)))
        self.send_header("Cache-Control", cache_ctl)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if send_body:
            self._safe_write(svg_bytes)

    def _handle_image_request(
        self, parsed: urllib.parse.SplitResult, send_body: bool = True
    ) -> None:
        raw_rest = parsed.path.removeprefix("/api/img/")
        segments = raw_rest.split("/")
        if len(segments) == 1:
            self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND, send_body=send_body)
            return
        if len(segments) > 2:
            raw_kind = urllib.parse.unquote(segments[0])
            if raw_kind in VALID_IMAGE_KINDS:
                self._send_json(
                    {"error": "Invalid image id"}, HTTPStatus.BAD_REQUEST, send_body=send_body
                )
            else:
                self._send_json(
                    {"error": "Invalid image kind"}, HTTPStatus.BAD_REQUEST, send_body=send_body
                )
            return

        kind = urllib.parse.unquote(segments[0])
        item_id = urllib.parse.unquote(segments[1])

        if kind not in VALID_IMAGE_KINDS:
            self._send_json(
                {"error": "Invalid image kind"}, HTTPStatus.BAD_REQUEST, send_body=send_body
            )
            return

        if item_id != "":
            if (
                "\x00" in item_id
                or "/" in item_id
                or "\\" in item_id
                or ".." in item_id
                or not _SAFE_ID_RE.fullmatch(item_id)
            ):
                self._send_json(
                    {"error": "Invalid image id"}, HTTPStatus.BAD_REQUEST, send_body=send_body
                )
                return

        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        name = (params.get("name") or [""])[0].strip()[:200]

        if item_id == "":
            self._send_svg_fallback(
                kind, item_id, name, self.graphics_index.is_warm, send_body=send_body
            )
            return

        img_path, is_ready = self.graphics_index.resolve(kind, item_id)
        for _attempt in range(2):
            if img_path is None:
                break
            fh = None
            try:
                flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                fd = os.open(img_path, flags)
                try:
                    fh = os.fdopen(fd, "rb")
                except Exception:
                    os.close(fd)
                    raise
                st = os.fstat(fh.fileno())
                if not stat.S_ISREG(st.st_mode):
                    raise OSError("Not a regular file")
                rp = self.graphics_index.verify_contained_path(img_path)
                if rp is None:
                    raise OSError("Path outside graphics root")
                rp_st = os.stat(rp)
                if (st.st_dev, st.st_ino) != (rp_st.st_dev, rp_st.st_ino):
                    raise OSError("Path changed during open")
                ctype = EXT_CONTENT_TYPES.get(
                    rp.suffix.lower(), "application/octet-stream"
                )
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(st.st_size))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.send_header("Last-Modified", self.date_time_string(st.st_mtime))
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                if send_body:
                    self.copyfile(fh, self.wfile)
                return
            except OSError:
                self.graphics_index.invalidate(kind, item_id, expected_path=img_path)
                img_path, is_ready = self.graphics_index.resolve(kind, item_id)
            finally:
                if fh is not None:
                    try:
                        fh.close()
                    except OSError:
                        pass

        self._send_svg_fallback(kind, item_id, name, is_ready, send_body=send_body)

    def translate_path(self, path: str) -> str:
        raw_path = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        if "\x00" in raw_path:
            return str(APP_DIR / "__forbidden__")
        if raw_path.startswith("/seasons/"):
            rel = raw_path.removeprefix("/seasons/").lstrip("/")
            try:
                seasons_root = SEASONS_DIR.resolve()
                candidate = (seasons_root / rel).resolve()
            except (ValueError, OSError):
                return str(APP_DIR / "__forbidden__")
            if candidate.is_relative_to(seasons_root):
                return str(candidate)
            return str(APP_DIR / "__forbidden__")
        return super().translate_path(path)

    def _handle_get_or_head(self, send_body: bool) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/api/status":
            self._send_json(_read_status(self.graphics_index), send_body=send_body)
            return
        if parsed.path.startswith("/api/img/"):
            self._handle_image_request(parsed, send_body=send_body)
            return
        try:
            if send_body:
                super().do_GET()
            else:
                super().do_HEAD()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True

    def do_GET(self) -> None:
        self._handle_get_or_head(send_body=True)

    def do_HEAD(self) -> None:
        self._handle_get_or_head(send_body=False)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/api/refresh":
            raw_len = self.headers.get("Content-Length")
            if raw_len is not None:
                try:
                    length = int(raw_len)
                except ValueError:
                    self._send_json({"error": "Invalid Content-Length"}, HTTPStatus.BAD_REQUEST)
                    return
                if length < 0:
                    self._send_json({"error": "Invalid Content-Length"}, HTTPStatus.BAD_REQUEST)
                    return
                if length > MAX_REFRESH_BODY_BYTES:
                    self._send_json(
                        {"error": "Request body too large"},
                        HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    )
                    return
            else:
                length = 0

            body_raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(body_raw.decode("utf-8") or "{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                data = {}
            save_path = data.get("save_path") if isinstance(data, dict) else None
            if save_path is not None and not isinstance(save_path, str):
                self._send_json({"error": "Invalid save_path"}, HTTPStatus.BAD_REQUEST)
                return

            status_code, result = _trigger_build(save_path, self.graphics_index)
            self._send_json(result, status_code)
            return
        self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def log_error(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"[ScoutHTTP] {self.address_string()} - {format % args}\n")
        sys.stderr.flush()

    def log_message(self, format: str, *args: Any) -> None:
        if getattr(self, "_last_status_code", 200) >= 400:
            sys.stderr.write(f"[ScoutHTTP] {self.address_string()} - {format % args}\n")
            sys.stderr.flush()


def _resolve_port(cli_port: int | None) -> int:
    if cli_port is not None:
        port = cli_port
    else:
        raw = os.environ.get("MONEYBALL_PORT") or os.environ.get("PORT")
        if raw is not None and raw.strip():
            try:
                port = int(raw.strip())
            except ValueError as exc:
                raise SystemExit(f"Invalid port value: {raw!r}") from exc
        else:
            port = PORT
    if not (0 <= port <= 65535):
        raise SystemExit(f"Port out of range (0-65535): {port}")
    return port


def _resolve_host(cli_host: str | None) -> str:
    if cli_host is not None and cli_host.strip():
        return cli_host.strip()
    env_host = os.environ.get("MONEYBALL_HOST") or os.environ.get("HOST")
    if env_host is not None and env_host.strip():
        return env_host.strip()
    return HOST


def _resolve_graphics_dir(cli_graphics_dir: str | None) -> Path:
    if cli_graphics_dir is not None and cli_graphics_dir.strip():
        return Path(cli_graphics_dir.strip()).expanduser()
    env_dir = os.environ.get("FM27_GRAPHICS_DIR", "").strip()
    if env_dir:
        return Path(env_dir).expanduser()
    return DEFAULT_GRAPHICS_DIR


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="FM27 Moneyball Scout HTTP server")
    parser.add_argument("--host", default=None, help="Host interface to bind (default: 127.0.0.1)")
    parser.add_argument(
        "--port", type=int, default=None, help="TCP port to bind (0 for ephemeral, default: 8727)"
    )
    parser.add_argument(
        "--graphics-dir",
        default=None,
        help="Path to FM27 graphics directory (overrides FM27_GRAPHICS_DIR)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    host = _resolve_host(args.host)
    port = _resolve_port(args.port)
    graphics_dir = _resolve_graphics_dir(args.graphics_dir)

    graphics_index = GraphicsIndex(graphics_dir)
    try:
        server = ScoutHTTPServer((host, port), ScoutHandler, graphics_index=graphics_index)
    except OSError as exc:
        print(f"Failed to bind {host}:{port}: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1) from exc

    actual_host, actual_port = server.server_address[:2]
    graphics_index.start_warmup()
    print(f"Moneyball Scout server listening on http://{actual_host}:{actual_port}/", flush=True)

    def _shutdown_signal(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, name="server-shutdown", daemon=True).start()

    prev_sigterm = signal.signal(signal.SIGTERM, _shutdown_signal)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        signal.signal(signal.SIGTERM, prev_sigterm)
        server.server_close()


if __name__ == "__main__":
    main()
