"""Inspect embedded state and resource keys on a direct 2GIS card."""
from pathlib import Path
import json, shutil, tempfile
from playwright.sync_api import sync_playwright

EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
URL = "https://2gis.ru/blagoveshensk/firm/7318877675459195/tab/info"

profile = Path(tempfile.mkdtemp(prefix="maps-export-2gis-embedded-"))
try:
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(str(profile), executable_path=str(EDGE), headless=False, args=["--window-position=-32000,-32000", "--no-first-run"])
        page = context.pages[0]
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(8000)
        report = page.evaluate(r"""() => {
          const queue = [{value: window.initialState, path: 'initialState'}];
          const seen = new WeakSet();
          let found = null;
          for (let index = 0; index < queue.length && index < 100000 && !found; index += 1) {
            const {value, path} = queue[index];
            if (!value || typeof value !== 'object' || seen.has(value)) continue;
            seen.add(value);
            if (String(value.id || '').match(/^\d+/)?.[0] === '7318877675459195') {
              found = {path, keys: Object.keys(value), item: value};
              break;
            }
            for (const [key, child] of Object.entries(value)) {
              if (child && typeof child === 'object') queue.push({value: child, path: `${path}.${key}`});
            }
          }
          const scripts = [...document.scripts].map((script, index) => ({
            index, type: script.type, id: script.id, length: script.textContent.length,
            hasTarget: script.textContent.includes('7318877675459195'),
            hasAttributes: script.textContent.includes('attribute_groups'),
            sample: script.textContent.includes('7318877675459195') ? script.textContent.slice(Math.max(0, script.textContent.indexOf('7318877675459195') - 300), script.textContent.indexOf('7318877675459195') + 1000) : ''
          })).filter(item => item.hasTarget || item.hasAttributes);
          return {
            url: location.href,
            resources: performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /catalog|2gis/i.test(url)).slice(-100),
            scripts,
            htmlHasTarget: document.documentElement.innerHTML.includes('7318877675459195'),
            htmlHasAttributes: document.documentElement.innerHTML.includes('attribute_groups'),
            globals: Object.keys(window).filter(key => /initial|state|redux|apollo|data/i.test(key)).slice(0, 100)
            ,initialStateType: typeof window.initialState
            ,found: found ? {path: found.path, keys: found.keys, item: found.item} : null
          };
        }""")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        context.close()
finally:
    shutil.rmtree(profile, ignore_errors=True)
