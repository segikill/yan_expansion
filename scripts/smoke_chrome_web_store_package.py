"""Load the staged Chrome Web Store package and verify extension-owned pages."""

import json
import shutil
import tempfile
import time
from pathlib import Path

from openpyxl import load_workbook
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
ARCHIVE = ROOT / "release" / f"maps-export-overlay-{VERSION}-private.zip"

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



def check_travel_export(context, temp_root: Path) -> None:
    page = context.new_page()
    search = "https://travel.yandex.ru/hotels/abkhazia/"
    dates = "checkinDate=2026-11-27&checkoutDate=2026-12-11&adults=2&roomCount=1"
    state = {
        "hotels": {"searchHotelsPage": {"search": {"data": {"hotels": [{
            "hotel": {"hotelSlug": "abkhazia/sample", "coordinates": {"lat": 43.076563, "lon": 40.865615}}
        }]}}}}
    }
    card = """<!doctype html><meta charset="utf-8"><h1>Тестовая выдача</h1>
    <article><div><section><div>
      <h3><a href="/hotels/abkhazia/sample/">Тестовый отель</a></h3><div>Абхазия • Гостиница</div>
    </div></section></div><div>73 620 ₽</div><div>14 ночей • 5 258 ₽ за ночь</div>
    <div>Двухместный номер</div><div>До 15% баллами</div></article>"""

    def reply(route):
        state_script = "" if "navigationToken=50" in route.request.url else (
            "<script>window.__PRELOADED_REDUX_STATE__ = " + json.dumps(state) + ";</script>"
        )
        route.fulfill(status=200, content_type="text/html; charset=utf-8", body=card + state_script)

    page.route(f"{search}**", reply)
    panel = page.locator("#maps-export-overlay-host")
    for i in range(2):
        page.goto(f"{search}?{dates}&navigationToken={50 * i}", wait_until="domcontentloaded")
        panel.locator("#fix").click()
        page.wait_for_function(
            """expected => document.getElementById('maps-export-overlay-host')?.shadowRoot
                ?.getElementById('snapshots')?.textContent === expected""", arg=str(i + 1)
        )
    with page.expect_download() as download:
        panel.locator("#xlsx").click()
    path = temp_root / "travel_export_test.xlsx"
    download.value.save_as(path)
    with path.open("rb") as stream:
        workbook = load_workbook(stream, read_only=True, data_only=True)
        data = iter(workbook["objects"].values)
        columns = next(data)
        rows = [dict(zip(columns, cells)) for cells in data]
        workbook.close()
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["Цена за ночь, ₽"] == 5258
    assert row["Номер в предложении"] == "Двухместный номер"
    assert (row["lat"], row["lon"]) == (43.076563, 40.865615)
    print("PASS staged travel extension: price, room, coordinates, deduplication and XLSX")
    page.close()


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
                assert page.evaluate("chrome.runtime.getManifest().version") == VERSION
                major, minor, patch = map(int, VERSION.split("."))
                tags = (f"v{VERSION}", f"v{major}.{minor}.{patch + 1}")
                for tag in tags:
                    url = f"https://github.com/segikill/yan_expansion/releases/download/{tag}/maps-export-overlay-{tag[1:]}-private.zip"
                    page.evaluate(
                        """async ({tag, url}) => chrome.storage.local.set({
                            maps_export_release_check_v1: {checkedAt: Date.now(), tag, url}
                        })""",
                        {"tag": tag, "url": url},
                    )
                    page.reload(wait_until="domcontentloaded")
                    indicator = page.locator("#releaseUpdate")
                    if tag == f"v{VERSION}":
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
                check_travel_export(context, temp_root)
            finally:
                context.close()
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
