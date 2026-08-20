"""Diagnostic helper for inspecting current Yandex organization page markup."""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("urls", nargs="+")
    parser.add_argument("--wait", type=int, default=15)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--expand-hours", action="store_true")
    parser.add_argument("--expand-features", action="store_true")
    args = parser.parse_args()
    profile = tempfile.mkdtemp(prefix="yan-page-inspect-")
    try:
        with sync_playwright() as playwright:
            browser_args = ["--window-position=-32000,-32000", "--window-size=1440,1000"] if args.headed else []
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=profile,
                executable_path=str(EDGE_PATH),
                headless=not args.headed,
                args=browser_args,
                viewport={"width": 1440, "height": 1000},
            )
            try:
                page = context.pages[0]
                for url in args.urls:
                    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
                    page.wait_for_timeout(max(1, args.wait) * 1000)
                    if args.expand_hours:
                        control = page.locator(".business-working-status-flip-view._clickable").first
                        if control.count():
                            control.click(timeout=5_000)
                            page.wait_for_timeout(1_000)
                    if args.expand_features:
                        control = page.locator(".tabs-select-view__title._name_features").first
                        if control.count():
                            control.click(timeout=5_000)
                            page.wait_for_timeout(2_000)
                    diagnostic = page.evaluate(
                        r"""() => ({
                          requested_url: location.href,
                          title: document.title,
                          ready_state: document.readyState,
                          body_text: String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 6000),
                          selectors: {
                            h1: document.querySelectorAll('h1').length,
                            org_header: document.querySelectorAll('.orgpage-header-view__header').length,
                            contacts: document.querySelectorAll('[class*="business-contacts-view"]').length,
                            json_ld: document.querySelectorAll('script[type="application/ld+json"]').length
                          },
                          hours_nodes: Array.from(document.querySelectorAll('[class*="hours"], [class*="working-status"]')).slice(0, 30).map(el => ({
                            tag: el.tagName,
                            class_name: String(el.className || ''),
                            text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300)
                          })),
                          feature_nodes: Array.from(document.querySelectorAll('[class*="feature"], [class*="attribute"]')).map(el => ({
                            tag: el.tagName,
                            class_name: String(el.className || ''),
                            text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)
                          })).filter((item, index, items) => item.text && !items.slice(0, index).some(old => old.class_name === item.class_name && old.text === item.text)).slice(0, 100),
                          controls: Array.from(document.querySelectorAll('button, [role="button"]')).map(el => ({
                            tag: el.tagName,
                            class_name: String(el.className || ''),
                            text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
                            aria: el.getAttribute('aria-label') || ''
                          })).filter(item => /\u0432\u0440\u0435\u043c|\u0440\u0435\u0436\u0438\u043c|\u0433\u0440\u0430\u0444\u0438\u043a|\u043e\u0442\u043a\u0440\u044b\u0442|\u0437\u0430\u043a\u0440\u044b\u0442|\u043f\u043d|\u0432\u0442|\u0441\u0440|\u0447\u0442|\u043f\u0442|\u0441\u0431|\u0432\u0441/i.test(item.text + ' ' + item.aria)).slice(0, 30)
                        })"""
                    )
                    print(json.dumps(diagnostic, ensure_ascii=False), flush=True)
            finally:
                context.close()
    finally:
        import shutil
        shutil.rmtree(profile, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
