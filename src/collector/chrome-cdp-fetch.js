// 사용자의 실제 Chrome(원격 디버깅)에 CDP로 붙어서, 그 세션·쿠키로 페이지를 렌더·수집.
// Kasada 등 사람이 통과한 안티봇을 실제 브라우저 세션으로 우회.
//
// 사전: Chrome을 완전히 종료 후, 디버깅 포트로 재실행 (사용자 프로필=쿠키 유지):
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --remote-debugging-port=9222 \
//     --user-data-dir="$HOME/Library/Application Support/Google/Chrome"
//   그 후 해당 Chrome에서 https://www.hyatt.com 한 번 열어 통과시켜 두면 가장 확실.
//
// 사용: node src/collector/chrome-cdp-fetch.js <url1> [url2 ...]
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CDP = process.env.CDP_URL || "http://localhost:9222";
const URLS = process.argv.slice(2);
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", "2026-06-21", "homepage", "cdp");
const BLOCK_RE = /KPSDK|x-kpsdk|ERROR:E60|did something unexpected|Access Denied|Pardon Our Interruption/i;

async function main() {
  if (!URLS.length) { console.error("URL 인자 필요"); process.exit(1); }
  fs.mkdirSync(OUTDIR, { recursive: true });
  let browser;
  try { browser = await chromium.connectOverCDP(CDP); }
  catch (e) { console.error(`CDP 연결 실패(${CDP}): ${e.message}\nChrome을 --remote-debugging-port=9222 로 실행했는지 확인하세요.`); process.exit(1); }

  const ctx = browser.contexts()[0] || await browser.newContext();
  console.log(`[CDP] 연결됨 ${CDP} | 기존 컨텍스트(쿠키) 사용 | ${URLS.length}개 URL\n`);
  const report = [];
  for (const url of URLS) {
    const page = await ctx.newPage();
    try {
      const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      try { await page.waitForLoadState("networkidle", { timeout: 12000 }); } catch {}
      try { await page.waitForFunction(() => ((document.body && document.body.innerText) || "").trim().length > 1000, { timeout: 20000 }); } catch {}
      await page.waitForTimeout(1500);
      const html = await page.content();
      const text = (await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "")).trim();
      const blocked = BLOCK_RE.test(html);
      const ok = (r ? r.status() : 0) < 400 && text.length > 1000 && !blocked;
      if (ok || text.length > 250) { fs.writeFileSync(path.join(OUTDIR, encodeURIComponent(url).slice(0, 80) + ".txt"), text); }
      console.log(`  ${ok ? "✅" : "❌"} http=${r ? r.status() : 0} text=${text.length}자 ${blocked ? "[차단]" : ""} ${url}`);
      if (ok) console.log("     본문:", text.slice(0, 160).replace(/\s+/g, " "));
      report.push({ url, ok, http: r ? r.status() : 0, text: text.length, blocked });
    } catch (e) { console.log(`  ERR ${url}: ${String(e).split("\n")[0].slice(0, 60)}`); report.push({ url, ok: false, err: String(e).slice(0, 80) }); }
    await page.close();
  }
  fs.writeFileSync(path.join(OUTDIR, "_cdp-report.json"), JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  console.log(`\n저장: data/raw/korea/2026-06-21/homepage/cdp/`);
}
main();
