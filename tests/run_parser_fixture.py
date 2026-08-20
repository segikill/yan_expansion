"""Run the browser-based detail parser fixtures in Edge."""

from pathlib import Path

from playwright.sync_api import sync_playwright


EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


def main() -> int:
    fixture = Path(__file__).with_name("detail_parser.test.html").resolve()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=str(EDGE_PATH), headless=True)
        try:
            page = browser.new_page()
            page.goto(fixture.as_uri())
            page.wait_for_function("document.documentElement.dataset.testResult")
            result = page.get_attribute("html", "data-test-result")
            print(result)
            if result != "PASS":
                print(page.locator("#test-output").inner_text())
            return 0 if result == "PASS" else 1
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
