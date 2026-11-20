"""Unified E2E test runner for FM27 Moneyball Scout (Tiers 1-4)."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import urllib.request
from dataclasses import asdict
from pathlib import Path
from typing import Any

E2E_DIR = Path(__file__).resolve().parent
REPO_ROOT = E2E_DIR.parents[1]
if str(E2E_DIR) not in sys.path:
    sys.path.insert(0, str(E2E_DIR))

from test_m1_mod import CaseResult, run_m1_tests
from test_m2_m3_backend import EphemeralServer, run_m2_m3_backend_tests


def _verify_base_url(base_url: str, timeout: float) -> None:
    url = f"{base_url.rstrip('/')}/api/status"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            if resp.status != 200:
                raise RuntimeError(f"GET {url} returned HTTP {resp.status}")
    except Exception as exc:
        raise RuntimeError(f"Target server unreachable at {url}: {exc}") from exc


def _run_browser_suite(base_url: str, tier_arg: str) -> list[CaseResult]:
    script = E2E_DIR / "test_m4_browser.mjs"
    with tempfile.NamedTemporaryFile("w+", suffix=".json", delete=False, encoding="utf-8") as tf:
        json_out = Path(tf.name)
    try:
        cmd = [
            "node",
            str(script),
            "--base-url",
            base_url,
            "--tier",
            tier_arg,
            "--json-out",
            str(json_out),
        ]
        proc = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=600)
        if proc.returncode not in (0, 1):
            raise RuntimeError(
                f"Browser test harness failed (exit {proc.returncode}):\n{proc.stdout}\n{proc.stderr}"
            )
        if not json_out.is_file() or json_out.stat().st_size == 0:
            raise RuntimeError(f"Browser harness produced no JSON output (exit {proc.returncode}):\n{proc.stderr}")
        raw = json.loads(json_out.read_text(encoding="utf-8"))
        return [
            CaseResult(
                id=str(item["id"]),
                feature=str(item["feature"]),
                tier=int(item["tier"]),
                passed=bool(item["passed"]),
                duration_ms=float(item["duration_ms"]),
                detail=str(item.get("detail", "")),
            )
            for item in raw
        ]
    finally:
        json_out.unlink(missing_ok=True)


def _print_summary(results: list[CaseResult]) -> None:
    by_tier: dict[int, list[CaseResult]] = {}
    for r in results:
        by_tier.setdefault(r.tier, []).append(r)

    print("\n=== Tier Summary ===")
    for t in sorted(by_tier):
        items = by_tier[t]
        passed = sum(1 for x in items if x.passed)
        failed = len(items) - passed
        print(f"Tier {t}: {passed}/{len(items)} passed, {failed} failed")

    total_pass = sum(1 for r in results if r.passed)
    total_fail = len(results) - total_pass
    print(f"Total:  {total_pass}/{len(results)} passed, {total_fail} failed")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FM27 Moneyball Scout 4-Tier Opaque-Box E2E Runner")
    parser.add_argument("--tier", choices=("1", "2", "3", "4", "all"), default="all", help="Tier to execute (default: all)")
    parser.add_argument("--base-url", default=None, help="Existing server URL (or set BASE_URL env); spawns ephemeral port 0 if unset")
    parser.add_argument("--timeout", type=float, default=15.0, help="Server startup/readiness timeout in seconds (default: 15.0)")
    parser.add_argument("--json-report", default=None, help="Optional path to write JSON test report")
    args = parser.parse_args(argv)

    tier_num = 0 if args.tier == "all" else int(args.tier)
    base_url = (args.base_url or os.environ.get("BASE_URL") or "").strip()

    all_results: list[CaseResult] = []
    server_ctx: EphemeralServer | None = None
    prev_sigterm = signal.getsignal(signal.SIGTERM)

    def _on_sigterm(signum: int, _frame: Any) -> None:
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, _on_sigterm)

    try:
        target_url = ""
        if base_url:
            _verify_base_url(base_url, timeout=args.timeout)
            target_url = base_url.rstrip("/")

        # Tiers 1 & 2 include M1 mod checks (no HTTP server needed, but run uniformly)
        if tier_num in (0, 1, 2):
            m1_res = run_m1_tests(tier_num)
            for r in m1_res:
                tag = "[PASS]" if r.passed else "[FAIL]"
                print(f"{tag} {r.id} ({r.duration_ms:.1f}ms) - {r.detail}", flush=True)
            all_results.extend(m1_res)

        if not base_url:
            server_ctx = EphemeralServer(timeout=args.timeout)
            server_ctx.__enter__()
            target_url = server_ctx.base_url

        if tier_num in (0, 1, 2):
            backend_res = run_m2_m3_backend_tests(target_url, tier_num)
            for r in backend_res:
                tag = "[PASS]" if r.passed else "[FAIL]"
                print(f"{tag} {r.id} ({r.duration_ms:.1f}ms) - {r.detail}", flush=True)
            all_results.extend(backend_res)

        browser_res = _run_browser_suite(target_url, args.tier)
        for r in browser_res:
            tag = "[PASS]" if r.passed else "[FAIL]"
            print(f"{tag} {r.id} ({r.duration_ms:.1f}ms) - {r.detail}", flush=True)
        all_results.extend(browser_res)

    except Exception as exc:
        print(f"[HARNESS ERROR] {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return 2
    finally:
        if server_ctx is not None:
            server_ctx.close()
        signal.signal(signal.SIGTERM, prev_sigterm)

    _print_summary(all_results)

    if args.json_report:
        report_path = Path(args.json_report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, Any] = {
            "tier": args.tier,
            "total": len(all_results),
            "passed": sum(1 for r in all_results if r.passed),
            "failed": sum(1 for r in all_results if not r.passed),
            "cases": [asdict(r) for r in all_results],
        }
        report_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    return 1 if any(not r.passed for r in all_results) else 0


if __name__ == "__main__":
    sys.exit(main())
