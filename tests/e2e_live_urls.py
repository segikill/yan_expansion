"""Live smoke-test of the unpacked extension against URLs from a 1.9.0 XLSX export."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from openpyxl import load_workbook
from playwright.sync_api import sync_playwright


SESSION_KEY = "maps_export_session_v2"
JOB_KEY = "maps_export_enrichment_job_v1"
RESULTS_KEY = "maps_export_enrichment_results_v1"
TERMINAL_STATES = {"completed", "blocked", "stopped"}
EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("xlsx", type=Path, nargs="?")
    parser.add_argument("--url", action="append", default=[], help="Yandex URL; may be repeated instead of XLSX")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--workers", type=int, choices=(1, 2, 4), default=1)
    parser.add_argument("--attempts", type=int, choices=(1, 2, 3), default=2)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--timeout", type=int, default=35, help="Card timeout in seconds")
    parser.add_argument("--max-seconds", type=int, default=480)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--check-export", action="store_true")
    return parser.parse_args()


def read_objects(path: Path, limit: int, offset: int = 0) -> list[dict]:
    workbook = load_workbook(path, read_only=True, data_only=True)
    sheet = workbook["objects"]
    rows = sheet.iter_rows(values_only=True)
    headers = [str(value or "") for value in next(rows)]
    objects: list[dict] = []
    seen: set[str] = set()
    for values in rows:
        row = dict(zip(headers, values))
        url = str(row.get("url") or "").strip()
        org_id = str(row.get("org_id") or "").strip()
        object_key = str(row.get("object_key") or f"yandex:{org_id}").strip()
        if not org_id or not object_key or "/maps/org/" not in url or url in seen:
            continue
        seen.add(url)
        if len(seen) <= max(0, offset):
            continue
        objects.append(
            {
                "object_key": object_key,
                "source": "yandex",
                "org_id": org_id,
                "title": str(row.get("title") or "").strip(),
                "rating": row.get("rating") or "",
                "reviews": row.get("reviews") or "",
                "categories_all": str(row.get("categories_all") or "").strip(),
                "address": str(row.get("address") or "").strip(),
                "photos_count": row.get("photos_count") or "",
                "lat": row.get("lat") or "",
                "lon": row.get("lon") or "",
                "url": url,
            }
        )
        if len(objects) >= limit:
            break
    workbook.close()
    return objects


def session_from(objects: list[dict]) -> dict:
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "id": f"e2e_{int(time.time())}",
        "version": 2,
        "created_at": timestamp,
        "updated_at": timestamp,
        "objects": {item["object_key"]: item for item in objects},
        "snapshots": [],
        "observations": [],
    }


def org_id_from_url(raw: str) -> str:
    parsed = urlparse(raw)
    path_match = re.search(r"/maps/org/[^/]+/(\d{5,})/?", parsed.path, re.I)
    if path_match:
        return path_match.group(1)
    query = parse_qs(parsed.query)
    whatshere_uri = unquote((query.get("whatshere[uri]") or [""])[0])
    match = re.search(r"[?&]oid=(\d{5,})", whatshere_uri, re.I)
    return match.group(1) if match else ""


def objects_from_urls(urls: list[str], limit: int) -> list[dict]:
    objects = []
    seen = set()
    for raw in urls:
        org_id = org_id_from_url(raw)
        if not org_id or org_id in seen:
            continue
        seen.add(org_id)
        objects.append(
            {
                "object_key": f"yandex:{org_id}",
                "source": "yandex",
                "org_id": org_id,
                "title": f"Test {org_id}",
                "url": raw,
            }
        )
        if len(objects) >= limit:
            break
    return objects


def unpacked_extension_id(extension_dir: Path) -> str:
    digest = hashlib.sha256(str(extension_dir.resolve()).encode("utf-16le")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(nibble, 16)) for nibble in digest)


def inspect_export(path: Path, expected_rows: int) -> dict:
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        expected_sheets = ["Организации"]
        missing = sorted(set(expected_sheets).difference(workbook.sheetnames))
        extra = sorted(set(workbook.sheetnames).difference(expected_sheets))
        sheet = workbook["Организации"] if "Организации" in workbook.sheetnames else None
        rows = max(0, (sheet.max_row if sheet else 0) - 1)
        headers = [str(cell.value or "") for cell in next(sheet.iter_rows())] if sheet else []
        required_columns = {"Название", "Телефоны", "categories_all", "category_first", "opening_hours", "working_status", "close_time", "Средний счёт", "Количество номеров", "Парковка — характеристики"}
        missing_columns = sorted(required_columns.difference(headers))
        forbidden_columns = {"object_key", "source", "snapshot_ids", "assigned_worker", "category_fields_json"}
        present_forbidden = sorted(forbidden_columns.intersection(headers))
        if missing or extra or missing_columns or present_forbidden or rows != expected_rows:
            raise AssertionError(
                f"Invalid export: missing_sheets={missing}, extra_sheets={extra}, missing_columns={missing_columns}, "
                f"forbidden_columns={present_forbidden}, "
                f"rows={rows}, expected_rows={expected_rows}"
            )
        return {"path": str(path), "sheets": workbook.sheetnames, "object_rows": rows}
    finally:
        workbook.close()


def extension_id(context, extension_dir: Path, deadline: float) -> str:
    while time.time() < deadline:
        for worker in context.service_workers:
            if worker.url.startswith("chrome-extension://"):
                return worker.url.split("/")[2]
        time.sleep(0.2)
    return unpacked_extension_id(extension_dir)


def main() -> int:
    args = arguments()
    extension_dir = Path(__file__).resolve().parent.parent
    if args.url:
        objects = objects_from_urls(args.url, max(1, args.limit))
    elif args.xlsx:
        objects = read_objects(args.xlsx.resolve(), max(1, args.limit), args.offset)
    else:
        raise RuntimeError("Provide an XLSX path or at least one --url")
    if not objects:
        raise RuntimeError("No Yandex organization URLs found in the workbook")
    if not EDGE_PATH.exists():
        raise RuntimeError(f"Edge not found: {EDGE_PATH}")

    reports_dir = extension_dir / "tests" / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    profile_dir = Path(tempfile.mkdtemp(prefix="yan-expansion-e2e-"))
    print(json.dumps({"event": "seed", "objects": len(objects), "workers": args.workers}, ensure_ascii=False), flush=True)

    report: dict = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "xlsx": str(args.xlsx.resolve()) if args.xlsx else "",
        "requested": len(objects),
        "workers": args.workers,
        "objects": [{"object_key": item["object_key"], "org_id": item["org_id"], "url": item["url"]} for item in objects],
    }

    try:
        with sync_playwright() as playwright:
            browser_args = [
                f"--disable-extensions-except={extension_dir}",
                f"--load-extension={extension_dir}",
                "--no-first-run",
                "--disable-component-update",
            ]
            if args.headed:
                browser_args.extend(["--window-position=-32000,-32000", "--window-size=1440,1000"])
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                executable_path=str(EDGE_PATH),
                headless=not args.headed,
                ignore_default_args=["--disable-extensions"],
                args=browser_args,
                viewport={"width": 1440, "height": 1000},
            )
            try:
                ext_id = extension_id(context, extension_dir, time.time() + 3)
                dashboard = context.new_page()
                dashboard.goto(f"chrome-extension://{ext_id}/enrichment.html", wait_until="domcontentloaded")
                dashboard.evaluate(
                    """async ({sessionKey, jobKey, resultsKey, session}) => {
                      await chrome.storage.local.remove([jobKey, resultsKey]);
                      await chrome.storage.local.set({[sessionKey]: session});
                    }""",
                    {"sessionKey": SESSION_KEY, "jobKey": JOB_KEY, "resultsKey": RESULTS_KEY, "session": session_from(objects)},
                )
                start_response = dashboard.evaluate(
                    """async (options) => await chrome.runtime.sendMessage({type: 'ENRICHMENT_START', options})""",
                    {
                        "scope": "all",
                        "workers": args.workers,
                        "timeout_ms": max(10, args.timeout) * 1000,
                        "max_attempts": args.attempts,
                        "delay_ms": 800,
                    },
                )
                if not start_response or not start_response.get("ok"):
                    raise RuntimeError(f"Could not start queue: {start_response}")

                deadline = time.time() + args.max_seconds
                last_line = ""
                state = {}
                while time.time() < deadline:
                    state = dashboard.evaluate(
                        """async (jobKey) => (await chrome.storage.local.get(jobKey))[jobKey] || {}""",
                        JOB_KEY,
                    )
                    totals = state.get("totals") or {}
                    line = json.dumps(
                        {
                            "event": "progress",
                            "status": state.get("status"),
                            "success": totals.get("success", 0),
                            "error": totals.get("error", 0),
                            "captcha": totals.get("captcha", 0),
                            "active": totals.get("active", 0),
                            "queued": totals.get("queued", 0),
                        },
                        ensure_ascii=False,
                    )
                    if line != last_line:
                        print(line, flush=True)
                        last_line = line
                    if state.get("status") in TERMINAL_STATES:
                        break
                    time.sleep(1)
                else:
                    dashboard.evaluate("async () => await chrome.runtime.sendMessage({type: 'ENRICHMENT_STOP'})")
                    raise TimeoutError(f"Live test exceeded {args.max_seconds} seconds")

                results = dashboard.evaluate(
                    """async (resultsKey) => (await chrome.storage.local.get(resultsKey))[resultsKey] || {}""",
                    RESULTS_KEY,
                )
                report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                report["job"] = state
                report["results"] = results
                report["summary"] = {
                    "status": state.get("status"),
                    **(state.get("totals") or {}),
                }
                dashboard.screenshot(path=str(reports_dir / "live_smoke_latest.png"), full_page=True)
                if args.check_export:
                    export_path = reports_dir / "live_smoke_latest.xlsx"
                    dashboard.wait_for_function("!document.querySelector('#btnExport').disabled")
                    with dashboard.expect_download(timeout=30_000) as download_info:
                        dashboard.click("#btnExport")
                    download_info.value.save_as(export_path)
                    report["export"] = inspect_export(export_path, len(objects))
            finally:
                context.close()
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)

    report_path = reports_dir / "live_smoke_latest.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"event": "report", "path": str(report_path), "summary": report.get("summary")}, ensure_ascii=False), flush=True)
    return 0 if report.get("summary", {}).get("status") == "completed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
