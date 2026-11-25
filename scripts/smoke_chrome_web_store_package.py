"""Load the staged Chrome Web Store package and verify extension-owned pages."""

import shutil
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "release" / "maps-export-overlay-1.12.8-private.zip"
def loaded_extension_id(context, path: Path) -> str:
    deadline = time.time() + 8
    while time.time() < deadline:
        for worker in context.service_workers:
            if worker.url.startswith("chrome-extension://"):
                return worker.url.split("/")[2]
        time.sleep(0.2)
    extensions_page = context.new_page()
    try:
        extensions_page.goto("chrome://extensions", wait_until="domcontentloaded")
        extensions_page.wait_for_timeout(800)
        installed = extensions_page.evaluate(
            """() => {
              const manager = document.querySelector('extensions-manager');
              const list = manager?.shadowRoot?.querySelector('#items-list');
              const items = list?.shadowRoot?.querySelectorAll('extensions-item') || [];
              return [...items].map((item) => ({
                id: item.getAttribute('id') || '',
                name: item.shadowRoot?.querySelector('#name')?.textContent?.trim() || ''
              }));
            }"""
        )
        for item in installed:
            if item.get("name", "").startswith("Maps Export"):
                return item["id"]
        raise RuntimeError(f"Maps Export was not loaded. Installed extensions: {installed}")
    finally:
        extensions_page.close()


def main() -> int:
    if not ARCHIVE.exists():
        raise FileNotFoundError(f"Release archive is missing: {ARCHIVE}")

    temp_root = Path(tempfile.mkdtemp(prefix="maps-export-cws-smoke-"))
    package = temp_root / "extension"
    profile = temp_root / "profile"
    shutil.unpack_archive(ARCHIVE, package)
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile),
                headless=False,
                ignore_default_args=["--disable-extensions"],
                args=[
                    f"--disable-extensions-except={package}",
                    f"--load-extension={package}",
                    "--no-first-run",
                    "--disable-component-update",
                    "--window-position=-32000,-32000",
                    "--window-size=1100,800",
                ],
                viewport={"width": 1100, "height": 800},
            )
            try:
                ext_id = loaded_extension_id(context, package)
                page = context.new_page()
                page.goto(f"chrome-extension://{ext_id}/popup.html", wait_until="domcontentloaded")
                page.wait_for_selector("#btnShowPanel")
                assert "Локальная обработка" in page.locator("aside.privacy-note").inner_text()
                for tag in ("v1.12.8", "v1.12.9"):
                    url = f"https://github.com/segikill/yan_expansion/releases/download/{tag}/maps-export-overlay-{tag[1:]}-private.zip"
                    page.evaluate(
                        """async ({tag, url}) => chrome.storage.local.set({
                            maps_export_release_check_v1: {checkedAt: Date.now(), tag, url}
                        })""",
                        {"tag": tag, "url": url},
                    )
                    page.reload(wait_until="domcontentloaded")
                    indicator = page.locator("#releaseUpdate")
                    if tag == "v1.12.8":
                        assert indicator.is_hidden()
                    else:
                        indicator.wait_for(state="visible")
                        assert page.locator("#releaseZip").is_hidden()
                        indicator.locator("summary").click()
                        assert page.locator("#releaseZip").is_visible()
                        assert page.locator("#releaseZip").get_attribute("href") == url
                page.goto(f"chrome-extension://{ext_id}/privacy.html", wait_until="domcontentloaded")
                assert page.locator("h1").inner_text() == "Конфиденциальность и данные"
                assert "Всё хранится локально" in page.locator(".notice").inner_text()
                print(f"PASS Chrome Web Store staged package: {ext_id}")
            finally:
                context.close()
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
