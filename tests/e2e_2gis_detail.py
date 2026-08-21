"""Live check of the 2GIS structured-detail bridge and category adapters."""

from __future__ import annotations

import json
import argparse
import shutil
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
CASES = [
    ("food", "70000001090062896", "https://2gis.ru/blagoveshensk/firm/70000001090062896/tab/info"),
    ("hotel", "7318877675459195", "https://2gis.ru/blagoveshensk/firm/7318877675459195/tab/info"),
    ("parking", "70030076643273394", "https://2gis.ru/blagoveshensk/geo/70030076643273394/tab/info"),
]


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=len(CASES))
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    profile = Path(tempfile.mkdtemp(prefix="maps-export-2gis-detail-"))
    reports = []
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                str(profile), executable_path=str(EDGE_PATH), headless=False,
                args=["--window-position=-32000,-32000", "--window-size=1440,1000", "--no-first-run"],
                viewport={"width": 1440, "height": 1000},
            )
            page = context.pages[0]
            for expected_adapter, org_id, url in CASES[:max(1, args.limit)]:
                page.goto(url, wait_until="domcontentloaded", timeout=60_000)
                page.wait_for_timeout(8_000)
                page.add_script_tag(path=str(root / "two_gis_detail_bridge.js"))
                page.add_script_tag(path=str(root / "two_gis_detail_parser.js"))
                item = page.evaluate(
                    r"""({orgId}) => new Promise((resolve) => {
                      const requestId = `e2e_${Date.now()}_${Math.random()}`;
                      const timer = setTimeout(() => { removeEventListener('message', receive); resolve(null); }, 22000);
                      function receive(event) {
                        const message = event.data || {};
                        if (!message.__MAPS_EXPORT_2GIS_DETAIL_RESPONSE__ || message.request_id !== requestId) return;
                        clearTimeout(timer);
                        removeEventListener('message', receive);
                        resolve({item: message.item || null, error: message.error || '', request_url: message.request_url || ''});
                      }
                      addEventListener('message', receive);
                      postMessage({__MAPS_EXPORT_2GIS_DETAIL_REQUEST__: true, request_id: requestId, org_id: orgId}, '*');
                    })""",
                    {"orgId": org_id},
                )
                bridge_result = item or {"item": None, "error": "timeout", "request_url": ""}
                structured_item = bridge_result.get("item")
                result = page.evaluate("(item) => Maps2gisDetailParser.parseDocument(document, location.href, item)", structured_item)
                reports.append({
                    "expected_adapter": expected_adapter,
                    "loaded_url": page.url,
                    "structured": structured_item is not None,
                    "bridge_error": bridge_result.get("error"),
                    "request_url": bridge_result.get("request_url"),
                    "result": result,
                })
            context.close()
    finally:
        shutil.rmtree(profile, ignore_errors=True)

    if args.verbose:
        output = reports
    else:
        output = [
            {
                "adapter": report["result"].get("category_data", {}).get("adapter_id"),
                "structured": report["structured"],
                "title": report["result"].get("title"),
                "working_status": report["result"].get("working_status"),
                "close_time": report["result"].get("close_time"),
                "opening_days": len(report["result"].get("opening_hours") or []),
                "lat": report["result"].get("lat"),
                "lon": report["result"].get("lon"),
                "fields": report["result"].get("category_data", {}).get("fields", {}),
            }
            for report in reports
        ]
    print(json.dumps(output, ensure_ascii=False, indent=2))
    for report in reports:
        result = report["result"]
        if result.get("category_data", {}).get("adapter_id") != report["expected_adapter"]:
            return 1
        if not result.get("title"):
            return 1
        if not result.get("opening_hours") or not result.get("working_status"):
            return 1
        if not result.get("lat") or not result.get("lon"):
            return 1
        if not report["structured"]:
            return 1
        fields = result.get("category_data", {}).get("fields", {})
        if report["expected_adapter"] == "food" and (not fields.get("average_bill") or not fields.get("seats")):
            return 1
        if report["expected_adapter"] == "hotel" and (not fields.get("room_count") or not fields.get("registry_number")):
            return 1
        if report["expected_adapter"] == "parking" and (fields.get("paid") is not False or not fields.get("capacity")):
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
