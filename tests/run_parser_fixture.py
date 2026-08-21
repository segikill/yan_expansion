"""Run parser, overlay and enrichment UI fixtures in Edge."""

import os
from pathlib import Path

from playwright.sync_api import sync_playwright


EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")

ENRICHMENT_MOCK = r"""
(() => {
  const now = new Date().toISOString();
  const state = {
    ok: true,
    base_count: 71,
    result_count: 22,
    job: {
      status: "running",
      started_at: new Date(Date.now() - 180000).toISOString(),
      totals: { total: 71, success: 22, active: 2, error: 1, captcha: 0, rate_limited: 0, cancelled: 0 },
      tasks: {
        a: { status: "parsing", title: "Пивоваровъ", org_id: "1769956853", attempts: 1 },
        b: { status: "navigating", title: "Столица", org_id: "1804848648", attempts: 1 },
        c: { status: "success", title: "Винный мир", org_id: "182192061360", attempts: 1, completed_at: now },
        d: { status: "error", title: "Тест ошибки", org_id: "100", attempts: 3, error: "Карточка не загрузилась" },
        e: { status: "queued", title: "Bon Vin", org_id: "1824589782", attempts: 0 }
      },
      workers: [
        { worker_id: "worker_1", status: "parsing", processed: 5, current_object_key: "a", tab_id: 101 },
        { worker_id: "worker_2", status: "waiting_dom", processed: 6, current_object_key: "b", tab_id: 102 }
      ]
    }
  };
  globalThis.chrome = {
    runtime: {
      getURL: (path) => path,
      sendMessage: async (message) => message?.type === "ENRICHMENT_GET_STATE" ? state : { ok: true }
    },
    storage: {
      onChanged: { addListener() {} },
      local: { get: async () => ({}), set: async () => {} }
    }
  };
})();
"""


def check_light_theme(browser) -> tuple[bool, dict]:
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    context.add_init_script(ENRICHMENT_MOCK)
    page = context.new_page()
    try:
        page.goto(Path(__file__).parents[1].joinpath("enrichment.html").resolve().as_uri())
        page.evaluate("""() => {
          const radio = document.querySelector("#theme-light");
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        }""")
        page.wait_for_selector(".worker")
        page.wait_for_timeout(1000)
        checks = page.evaluate(r"""() => {
          const rgb = (selector, property = "backgroundColor") => {
            const value = getComputedStyle(document.querySelector(selector))[property];
            const match = value.match(/[\d.]+/g) || [];
            return match.slice(0, 3).map(Number);
          };
          const isLight = (values) => values.length === 3 && values.reduce((a, b) => a + b, 0) > 620;
          const tableBg = rgb(".table-wrap");
          const workerBg = rgb(".worker");
          const progressColor = rgb(".progress-percent", "color");
          return {
            theme_selected: document.querySelector("#theme-light").checked,
            force_reset_available: document.querySelector("#btnForceReset")?.disabled === false,
            table_is_light: isLight(tableBg),
            worker_is_light: isLight(workerBg),
            table_background_rgb: tableBg.join(","),
            worker_background_rgb: workerBg.join(","),
            progress_is_visible: progressColor.length === 3 && progressColor[2] > 140 && progressColor.reduce((a, b) => a + b, 0) < 650,
            queue_text_is_dark: rgb("tbody td", "color").reduce((a, b) => a + b, 0) < 420,
            no_horizontal_overflow_1440: document.documentElement.scrollWidth <= innerWidth + 1
          };
        }""")

        screenshot = os.environ.get("MAPS_EXPORT_LIGHT_SCREENSHOT", "").strip()
        if screenshot:
            page.screenshot(path=screenshot, full_page=True)

        page.set_viewport_size({"width": 800, "height": 1000})
        page.wait_for_timeout(150)
        checks["no_horizontal_overflow_800"] = page.evaluate(
            "document.documentElement.scrollWidth <= innerWidth + 1"
        )
        checks["workspace_stacks_800"] = page.evaluate(
            "getComputedStyle(document.querySelector('.workspace-grid')).gridTemplateColumns.split(' ').length === 1"
        )

        boolean_checks = [value for value in checks.values() if isinstance(value, bool)]
        return all(boolean_checks), checks
    finally:
        context.close()


def main() -> int:
    fixtures = [
        Path(__file__).with_name("detail_parser.test.html").resolve(),
        Path(__file__).with_name("overlay_ui.test.html").resolve(),
        Path(__file__).with_name("two_gis_collector.test.html").resolve(),
        Path(__file__).with_name("two_gis_detail_parser.test.html").resolve(),
    ]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=str(EDGE_PATH), headless=True)
        try:
            page = browser.new_page()
            passed = True
            for fixture in fixtures:
                page.goto(fixture.as_uri())
                page.wait_for_function("document.documentElement.dataset.testResult")
                result = page.get_attribute("html", "data-test-result")
                print(f"{fixture.name}: {result}")
                if result != "PASS":
                    passed = False
                    print(page.locator("#test-output").inner_text())
            light_passed, light_checks = check_light_theme(browser)
            print(f"enrichment_light_theme: {'PASS' if light_passed else 'FAIL'}")
            if not light_passed:
                passed = False
                print(light_checks)
            return 0 if passed else 1
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
