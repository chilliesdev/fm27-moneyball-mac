"""Local HTTP server for FM27 Moneyball Scout with save pickup and progressive seasons."""

from __future__ import annotations

import json
import threading
import urllib.parse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import build_moneyball

HOST = "127.0.0.1"
PORT = 8727
APP_DIR = build_moneyball.SCOUTING_DIR / "app"
SEASONS_DIR = build_moneyball.SEASONS_DIR

_LOCK = threading.Lock()
_STATE: dict[str, Any] = {
    "building": False,
    "last_error": None,
    "last_built": None,
}


def _read_status() -> dict[str, Any]:
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

    return {
        "saves": saves,
        "latest_season": seasons_index.get("latest_season"),
        "seasons": seasons_index.get("seasons", []),
        "newest_save_stale": stale,
        "building": _STATE["building"],
        "last_error": _STATE["last_error"],
        "last_built": _STATE["last_built"],
    }


def _trigger_build(save_path_str: str | None) -> dict[str, Any]:
    with _LOCK:
        if _STATE["building"]:
            return {"started": False, "reason": "already_building", **_read_status()}
        _STATE["building"] = True
        _STATE["last_error"] = None

    try:
        target = Path(save_path_str) if save_path_str else build_moneyball.pick_latest_save()
        meta = build_moneyball.build_from_save(target)
        _STATE["last_built"] = {
            "season": meta["season"],
            "in_game_date": meta["in_game_date"],
            "save_file": meta["save_file"],
            "club_name": meta["club_name"],
        }
        return {"started": True, "meta": _STATE["last_built"], **_read_status()}
    except Exception as exc:
        _STATE["last_error"] = f"{type(exc).__name__}: {exc}"
        return {"started": False, "error": _STATE["last_error"], **_read_status()}
    finally:
        with _LOCK:
            _STATE["building"] = False


class ScoutHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def _send_json(self, payload: dict[str, Any], code: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def translate_path(self, path: str) -> str:
        parsed = urllib.parse.urlsplit(path).path
        if parsed.startswith("/seasons/"):
            rel = parsed.removeprefix("/seasons/").lstrip("/")
            candidate = (SEASONS_DIR / rel).resolve()
            if SEASONS_DIR.resolve() in candidate.parents or candidate == SEASONS_DIR.resolve():
                return str(candidate)
            return str(APP_DIR / "__forbidden__")
        return super().translate_path(path)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path).path
        if parsed == "/api/status":
            self._send_json(_read_status())
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlsplit(self.path).path
        if parsed == "/api/refresh":
            length = int(self.headers.get("Content-Length") or "0")
            body_raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(body_raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                data = {}
            save_path = data.get("save_path") if isinstance(data, dict) else None
            result = _trigger_build(save_path)
            status_code = HTTPStatus.INTERNAL_SERVER_ERROR if result.get("error") else HTTPStatus.OK
            self._send_json(result, status_code)
            return
        self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args: Any) -> None:
        # Keep daemon log quiet unless error
        pass


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), ScoutHandler)
    print(f"Moneyball Scout server listening on http://{HOST}:{PORT}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
