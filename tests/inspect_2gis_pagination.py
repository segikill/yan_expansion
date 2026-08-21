"""Print 2GIS pagination arrow DOM metadata for pages 1 and 2."""

from pathlib import Path
import json
import shutil
import tempfile

from playwright.sync_api import sync_playwright


EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
URLS = [
    "https://2gis.ru/blagoveshensk/search/%D0%9F%D0%BE%D0%B5%D1%81%D1%82%D1%8C?m=127.557829%2C50.275848%2F13.92&immersive=on",
    "https://2gis.ru/blagoveshensk/search/%D0%9F%D0%BE%D0%B5%D1%81%D1%82%D1%8C/page/2?m=127.557829%2C50.275848%2F13.92&immersive=on",
]


def main() -> None:
    profile = Path(tempfile.mkdtemp(prefix="maps-export-2gis-pagination-"))
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                str(profile), executable_path=str(EDGE_PATH), headless=False,
                args=["--window-position=-32000,-32000", "--window-size=1440,1000", "--no-first-run"],
                viewport={"width": 1440, "height": 1000},
            )
            page = context.pages[0]
            for url in URLS:
                page.goto(url, wait_until="domcontentloaded", timeout=60_000)
                page.wait_for_timeout(6_000)
                report = page.evaluate(r"""() => [...document.querySelectorAll('div._n5hmn94')].map((node, index) => {
                  const clickable = node.closest('button, a, [role=button]') || node.parentElement || node;
                  const box = clickable.getBoundingClientRect();
                  const svg = node.querySelector('svg');
                  const style = getComputedStyle(clickable);
                  return {
                    index,
                    text: clickable.textContent,
                    ariaLabel: clickable.getAttribute('aria-label'),
                    title: clickable.getAttribute('title'),
                    href: clickable.getAttribute('href'),
                    disabled: Boolean(clickable.disabled) || clickable.getAttribute('aria-disabled'),
                    className: String(clickable.className || ''),
                    parentClass: String(clickable.parentElement?.className || ''),
                    x: Math.round(box.x),
                    y: Math.round(box.y),
                    width: Math.round(box.width),
                    display: style.display,
                    visibility: style.visibility,
                    transform: style.transform,
                    path: svg?.querySelector('path')?.getAttribute('d') || '',
                    html: clickable.outerHTML.slice(0, 1200),
                  };
                })""")
                print(json.dumps({"url": page.url, "arrows": report}, ensure_ascii=False, indent=2))
            context.close()
    finally:
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
