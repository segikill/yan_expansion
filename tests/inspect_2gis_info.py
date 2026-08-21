"""Inspect 2GIS info pages and catalog payload shapes without modifying data."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import re
from pathlib import Path

from playwright.sync_api import sync_playwright


EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
URLS = [
    "https://2gis.ru/blagoveshensk/search/%D0%9F%D0%BE%D0%B5%D1%81%D1%82%D1%8C/firm/70000001090062896/127.524379%2C50.258103/tab/info?m=127.557829%2C50.275848%2F13.92&immersive=on",
    "https://2gis.ru/blagoveshensk/search/%D0%BE%D1%82%D0%B5%D0%BB%D0%B8/rubricId/269/firm/7318877675459195/127.536541%2C50.256789/tab/info?m=127.537829%2C50.286306%2F13.27&immersive=on",
    "https://2gis.ru/blagoveshensk/geo/70030076643273394/127.526279%2C50.278809?m=127.538612%2C50.278281%2F16.01&layer=parkings&immersive=on",
]


def summarize_item(item: dict) -> dict:
    groups = []
    for group in item.get("attribute_groups") or []:
        groups.append({
            "name": group.get("name"),
            "attributes": [
                {key: attribute.get(key) for key in ("name", "tag", "value", "text") if attribute.get(key) is not None}
                for attribute in group.get("attributes") or []
            ],
        })
    interesting = ["id", "type", "name", "address_name", "point", "reviews", "schedule", "description", "capacity", "is_paid", "access", "access_comment", "paving_type", "for_trucks"]
    return {
        "keys": sorted(item.keys()),
        "interesting": {key: item.get(key) for key in interesting if key in item},
        "attribute_groups": groups,
    }


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    profile = Path(tempfile.mkdtemp(prefix="maps-export-2gis-info-"))
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile),
                executable_path=str(EDGE_PATH),
                headless=False,
                args=["--window-position=-32000,-32000", "--window-size=1440,1000", "--no-first-run"],
                viewport={"width": 1440, "height": 1000},
            )
            try:
                page = context.pages[0]
                for url in URLS:
                    payloads: list[dict] = []

                    def capture(response) -> None:
                        if "catalog.api.2gis" not in response.url or "/items" not in response.url:
                            return
                        try:
                            doc = response.json()
                            items = doc.get("result", {}).get("items", []) if isinstance(doc, dict) else []
                            if items and isinstance(items[0], dict):
                                payloads.append({"url": response.url, **summarize_item(items[0])})
                        except Exception:
                            pass

                    page.on("response", capture)
                    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
                    page.wait_for_timeout(8_000)
                    target_match = re.search(r"/(?:firm|geo)/(\d+)", url)
                    target_id = target_match.group(1) if target_match else ""
                    target_item = page.evaluate(
                        r"""async (targetId) => {
                          const urls = performance.getEntriesByType('resource').map(entry => entry.name);
                          const template = urls.find(url => /catalog\.api\.2gis\.[^/]+\/.*\/items\/byid/i.test(url));
                          if (!template || !targetId) return null;
                          const request = new URL(template);
                          request.searchParams.set('id', targetId);
                          const response = await fetch(request);
                          const payload = await response.json();
                          return payload?.result?.items?.[0] || null;
                        }""",
                        target_id,
                    )
                    report = page.evaluate(
                        r"""() => ({
                          url: location.href,
                          title: document.title,
                          body: String(document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 8000)
                        })"""
                    )
                    report["catalog_payloads"] = payloads[-2:]
                    report["target_item"] = summarize_item(target_item) if isinstance(target_item, dict) else None
                    print(json.dumps(report, ensure_ascii=False, indent=2))
                    page.remove_listener("response", capture)
            finally:
                context.close()
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
