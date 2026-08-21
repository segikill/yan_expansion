"""Create deterministic Chrome Web Store assets from the real extension UI."""

import base64

from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "store-assets"
ICONS = ROOT / "icons"
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")

MOCK = r"""
(() => {
  const now = new Date().toISOString();
  const state = {
    ok: true,
    base_count: 71,
    result_count: 22,
    job: {
      source: "2gis",
      status: "running",
      started_at: new Date(Date.now() - 180000).toISOString(),
      totals: { total: 71, success: 22, active: 4, error: 0, captcha: 0, rate_limited: 0, cancelled: 0 },
      tasks: {
        a: { status: "parsing", title: "Цветок солнца", org_id: "70000001090062896", attempts: 1 },
        b: { status: "navigating", title: "Гостиница Азия", org_id: "7318877675459195", attempts: 1 },
        c: { status: "success", title: "Острова", org_id: "70000001052264802", attempts: 1, completed_at: now },
        d: { status: "queued", title: "Империал", org_id: "70000001101212105", attempts: 0 },
        e: { status: "queued", title: "Плаза", org_id: "70000001079582519", attempts: 0 }
      },
      workers: [
        { worker_id: "worker_1", status: "parsing", processed: 5, current_object_key: "a", tab_id: 101 },
        { worker_id: "worker_2", status: "waiting_dom", processed: 6, current_object_key: "b", tab_id: 102 },
        { worker_id: "worker_3", status: "parsing", processed: 4, current_object_key: "c", tab_id: 103 },
        { worker_id: "worker_4", status: "navigating", processed: 3, current_object_key: "d", tab_id: 104 }
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
      local: { get: async () => ({ maps_export_theme_v1: "theme-dark" }), set: async () => {} }
    }
  };
})();
"""


def make_icons() -> None:
    source = ASSETS / "icon-source.svg"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=str(EDGE), headless=True)
        page = browser.new_page(viewport={"width": 512, "height": 512}, device_scale_factor=1)
        page.goto(source.as_uri())
        page.screenshot(path=str(ASSETS / "icon-512.png"), omit_background=True)
        browser.close()

    ICONS.mkdir(parents=True, exist_ok=True)
    with Image.open(ASSETS / "icon-512.png") as image:
        image = image.convert("RGBA")
        for size in (16, 32, 48, 128):
            resized = image.resize((size, size), Image.Resampling.LANCZOS)
            resized.save(ICONS / f"icon-{size}.png", optimize=True)
        image.resize((128, 128), Image.Resampling.LANCZOS).save(ASSETS / "icon-128.png", optimize=True)


def make_promo(browser) -> None:
    page = browser.new_page(viewport={"width": 440, "height": 280}, device_scale_factor=1)
    icon_data = base64.b64encode((ASSETS / "icon-512.png").read_bytes()).decode("ascii")
    icon_uri = f"data:image/png;base64,{icon_data}"
    page.set_content(f"""
      <!doctype html><style>
      *{{box-sizing:border-box}} body{{margin:0;width:440px;height:280px;overflow:hidden;background:#050c17;color:#edf5ff;font-family:Inter,Segoe UI,Arial,sans-serif}}
      .tile{{position:relative;width:440px;height:280px;padding:34px;display:flex;align-items:center;gap:25px;background:radial-gradient(circle at 12% 8%,rgba(55,214,255,.22),transparent 180px),radial-gradient(circle at 100% 100%,rgba(88,124,255,.2),transparent 210px),linear-gradient(145deg,#0a1a2c,#06101d 65%,#050b14)}}
      .tile:after{{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(120,160,200,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(120,160,200,.05) 1px,transparent 1px);background-size:24px 24px;mask-image:linear-gradient(90deg,#000,transparent)}}
      img{{position:relative;z-index:1;width:132px;height:132px;filter:drop-shadow(0 18px 30px rgba(0,0,0,.35))}}
      .copy{{position:relative;z-index:1;min-width:0}} .eyebrow{{color:#8deeff;font-size:11px;font-weight:800;letter-spacing:.14em}} h1{{margin:7px 0 8px;font-size:29px;line-height:.96;letter-spacing:-.04em}} p{{margin:0;color:#9dafc4;font-size:12px;line-height:1.45}}
      </style><div class="tile"><img src="{icon_uri}"/><div class="copy"><div class="eyebrow">MAPS EXPORT</div><h1>Данные карт<br/>в XLSX</h1><p>Базовый сбор<br/>и досбор по URL</p></div></div>
    """)
    page.screenshot(path=str(ASSETS / "promo-small-440x280.png"))
    page.close()


def make_screenshot(browser) -> None:
    context = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
    context.add_init_script(MOCK)
    page = context.new_page()
    page.goto((ROOT / "enrichment.html").as_uri(), wait_until="domcontentloaded")
    page.wait_for_selector(".worker")
    page.wait_for_timeout(900)
    page.screenshot(path=str(ASSETS / "screenshot-enrichment-1280x800.png"))
    context.close()


def main() -> int:
    ASSETS.mkdir(parents=True, exist_ok=True)
    make_icons()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=str(EDGE), headless=True)
        make_promo(browser)
        make_screenshot(browser)
        browser.close()
    print(f"Created Chrome Web Store assets in {ASSETS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
