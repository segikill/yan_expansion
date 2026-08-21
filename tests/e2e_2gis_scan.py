"""Live smoke-test for the unpacked extension on a 2GIS search page."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="https://2gis.ru/blagoveshensk/search/%D0%BE%D1%82%D0%B5%D0%BB%D1%8C")
    parser.add_argument("--warm-seconds", type=int, default=12)
    parser.add_argument("--max-pages", type=int, default=2)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--inspect-dom", action="store_true")
    args = parser.parse_args()

    extension_dir = Path(__file__).resolve().parent.parent
    profile_dir = Path(tempfile.mkdtemp(prefix="maps-export-2gis-e2e-"))
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
                page = context.pages[0]
                page.goto(args.url, wait_until="domcontentloaded", timeout=60_000)
                page.wait_for_timeout(10_000)
                injected_fallback = False
                try:
                    page.wait_for_function("window.__MAPS_EXPORT_COLLECTOR__?.source === '2gis'", timeout=5_000)
                except Exception:
                    injected_fallback = True
                    page.evaluate(
                        """() => {
                          const memory = {};
                          globalThis.chrome = {
                            runtime: {
                              getURL: () => 'data:text/javascript,',
                              onMessage: { addListener() {} },
                              sendMessage: async () => ({ok: true})
                            },
                            storage: { local: {
                              async get(key) { return {[key]: structuredClone(memory[key])}; },
                              async set(patch) { Object.assign(memory, structuredClone(patch)); }
                            }}
                          };
                        }"""
                    )
                    page.add_script_tag(path=str(extension_dir / "content.js"))
                    page.add_script_tag(path=str(extension_dir / "sniffer.js"))
                    page.add_script_tag(path=str(extension_dir / "overlay.js"))
                    page.wait_for_function("window.__MAPS_EXPORT_COLLECTOR__?.source === '2gis'", timeout=10_000)
                map_before = page.evaluate("new URL(location.href).searchParams.get('m') || ''")
                page.evaluate("(maxPages) => { window.__MAPS_EXPORT_COLLECTOR__.startAutoScan({maxPages}); return true; }", max(1, args.max_pages))
                page_history = []
                deadline = page.evaluate("Date.now()") + max(1, args.warm_seconds) * 1000
                while page.evaluate("Date.now()") < deadline:
                    live = page.evaluate("() => ({url: location.href, running: window.__MAPS_EXPORT_COLLECTOR__.getScanState().running})")
                    if not page_history or page_history[-1] != live["url"]:
                        page_history.append(live["url"])
                    if not live["running"]:
                        break
                    page.wait_for_timeout(100)
                if page.evaluate("window.__MAPS_EXPORT_COLLECTOR__.getScanState().running"):
                    page.evaluate("window.__MAPS_EXPORT_COLLECTOR__.stopAutoScan()")
                    page.wait_for_timeout(1_000)
                report = page.evaluate(
                    """() => {
                      const api = window.__MAPS_EXPORT_COLLECTOR__;
                      const rows = api.collect();
                      const host = document.getElementById('maps-export-overlay-host');
                      return {
                        title: document.title,
                        url: location.href,
                        firm_links: document.querySelectorAll('a[href*="/firm/"]').length,
                        overlay_2gis_button: host?.shadowRoot?.getElementById('gis2Scan')?.textContent || '',
                        scan: api.getScanState(),
                        rows: rows.length,
                        invalid_ids: rows.filter(row => !/^\\d{10,}$/.test(String(row.org_id || ''))).length,
                        duplicate_ids: rows.length - new Set(rows.map(row => row.org_id)).size,
                        with_address: rows.filter(row => row.address).length,
                        with_categories: rows.filter(row => row.categories_all).length,
                        with_reviews: rows.filter(row => row.reviews).length,
                        with_coordinates: rows.filter(row => row.lat && row.lon).length,
                        with_base_data: rows.filter(row => [row.rating, row.reviews, row.categories_all, row.address].filter(Boolean).length >= 2).length,
                        missing_base_rows: rows.filter(row => [row.rating, row.reviews, row.categories_all, row.address].filter(Boolean).length < 2).slice(0, 8),
                        missing_coordinate_rows: rows.filter(row => !row.lat || !row.lon).slice(0, 8),
                        raw_anchor_hrefs: Array.from(document.querySelectorAll('a[href*="/firm/"]')).slice(0, 12).map(a => a.href),
                        card_text_samples: Array.from(document.querySelectorAll('a[href*="/firm/"]')).slice(0, 4).map(a => ({
                          href: a.href,
                          text: String((a.closest('[data-id], article, li, [class*="card"], [class*="result"]') || a.parentElement)?.innerText || '').slice(0, 1200),
                          html: String((a.closest('[data-id], article, li, [class*="card"], [class*="result"]') || a.parentElement)?.outerHTML || '').slice(0, 2400)
                        })),
                        first_card_ancestors: (() => {
                          const a = document.querySelector('a[href*="/firm/"]');
                          const out = [];
                          let node = a;
                          for (let level = 0; node && level < 10; level++, node = node.parentElement) out.push({
                            level,
                            tag: node.tagName,
                            cls: node.className,
                            firm_links: node.querySelectorAll?.('a[href*="/firm/"]').length || 0,
                            text: String(node.innerText || '').slice(0, 1200)
                          });
                          return out;
                        })(),
                        sample: rows.slice(0, 5)
                      };
                    }"""
                )
                report["map_before"] = map_before
                if not args.inspect_dom:
                    report.pop("raw_anchor_hrefs", None)
                    report.pop("card_text_samples", None)
                    report.pop("first_card_ancestors", None)
                report["map_after"] = page.evaluate("new URL(location.href).searchParams.get('m') || ''")
                report["map_unchanged"] = report["map_before"] == report["map_after"]
                report["firm_card_not_opened"] = "/firm/" not in page.url
                report["page_history"] = page_history
                page_numbers = [int(match.group(1)) if (match := re.search(r"/page/(\d+)", url)) else 1 for url in page_history]
                report["pages_advance_only"] = all(after > before for before, after in zip(page_numbers, page_numbers[1:]))
                report["injected_fallback"] = injected_fallback
                print(json.dumps(report, ensure_ascii=False, indent=2))
                if not report["overlay_2gis_button"] or report["invalid_ids"] or report["duplicate_ids"] or not report["map_unchanged"] or not report["firm_card_not_opened"] or not report["pages_advance_only"]:
                    return 1
                return 0
            finally:
                context.close()
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
