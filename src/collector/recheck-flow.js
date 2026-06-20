// flow.md 충실 재접속 — step2: Chromium 렌더링+하이드레이션 대기, 순서 shifter→HasData→local.
// 입력 = _official-sites.json (step1 구글보정+HEAD해소 끝난 공식 URL). 사용: node src/collector/recheck-flow.js
const { execFile } = require("child_process");
const { chromium } = require("playwright");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");

function loadEnv() { try { const t = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8"); for (const l of t.split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim(); } } catch {} }
loadEnv();
const HOST = process.env.SHIFTER_HOST || "astraeus.p.shifter.io";
const PORTS = (process.env.SHIFTER_PORT_LIST || "10565,10566,10567,10568,10569,10570,10571,10572,10573,10574").split(",").map((s) => Number(s.trim())).filter(Boolean);
const KEY = process.env.HASDATA_API_KEY || "";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BLOCK_RE = /Pardon Our Interruption|Access Denied|Reference #\d|cf-browser-verification|are you a robot|verify you are human|보안문자|잠시 후 다시|비정상적인 접근/i;
const DATE = "2026-06-20-corrected";
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", DATE, "homepage");
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(OUTDIR, "_official-sites.json");
const TARGETS = require(SRC);

let PROXY_IP = null;
async function render(browser, url, port) {
  const ctx = await browser.newContext({ proxy: port ? { server: `http://${PROXY_IP}:${port}` } : undefined, userAgent: UA, locale: "ko-KR", timezoneId: "Asia/Seoul", viewport: { width: 1366, height: 900 }, extraHTTPHeaders: { "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" }, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const page = await ctx.newPage();
  try {
    const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    try { await page.waitForLoadState("networkidle", { timeout: 12000 }); } catch {}
    try { await page.waitForFunction(() => ((document.body && document.body.innerText) || "").trim().length > 250, { timeout: 18000 }); } catch {}
    await page.waitForTimeout(1200);
    // frameset 대응: 모든 프레임 가시 텍스트 합산
    let txt = await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
    if (txt.trim().length < 250 && page.frames().length > 1) {
      for (const fr of page.frames()) { try { const t = await fr.evaluate(() => (document.body ? document.body.innerText : "")); if (t) txt += "\n" + t; } catch (_) {} }
    }
    const code = r ? r.status() : 0;
    const ok = code >= 200 && code < 400 && txt.trim().length > 250 && !BLOCK_RE.test(txt);
    return { ok, code, text: txt.trim().length };
  } catch (e) { return { ok: false, code: 0, text: 0, err: String(e).split("\n")[0].slice(0, 60) }; } finally { await ctx.close(); }
}
function hasdata(url) { return new Promise((res) => { execFile("curl", ["-s", "-m", "75", "-X", "POST", "https://api.hasdata.com/scrape/web", "-H", `x-api-key: ${KEY}`, "-H", "Content-Type: application/json", "-d", JSON.stringify({ url, jsRendering: true }), "-w", "\n__A__%{http_code}"], { maxBuffer: 64 * 1024 * 1024 }, (e, out) => { out = out || ""; const a = (out.match(/__A__(\d+)$/) || [])[1]; const j = out.replace(/\n__A__\d+$/, ""); let st = null, c = ""; try { const o = JSON.parse(j); st = o.requestMetadata && o.requestMetadata.status; c = o.content || ""; } catch {} res({ ok: +a === 200 && st === "ok" && c.length > 1500 && !BLOCK_RE.test(c.slice(0, 4000)) }); }); }); }

async function main() {
  PROXY_IP = (await dns.resolve4(HOST))[0];
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
  console.log(`[korea] flow.md 재접속 — ${TARGETS.length}곳 | 순서: shifter(렌더)→HasData→local(렌더), 하이드레이션 대기\n  프록시 ${HOST}→${PROXY_IP}\n`);
  const report = []; let i = 0, idx = 0; const tally = { shifter: 0, hasdata: 0, local: 0, fail: 0, no_url: 0 };
  async function worker(n) {
    let port = PORTS[n % PORTS.length];
    while (true) {
      const k = idx++; if (k >= TARGETS.length) break; const h = TARGETS[k];
      const url = h.official;
      let via = null, detail = null;
      if (!url || !/^https?:\/\//.test(url)) { via = "no_url"; }
      else {
        let r = await render(browser, url, port);                       // 1) shifter + 렌더
        if (r.ok) { via = "shifter"; detail = r; }
        else { if (KEY) { for (let t = 0; t < 4 && !via; t++) { const hd = await hasdata(url); if (hd.ok) { via = "hasdata"; } } }  // 2) HasData
          if (!via) { r = await render(browser, url, null); if (r.ok) { via = "local"; detail = r; } }  // 3) local + 렌더
        }
        port = PORTS[(PORTS.indexOf(port) + 1) % PORTS.length];
      }
      const status = (via && via !== "no_url") ? "ok" : (via === "no_url" ? "no_url" : "fail");
      tally[via || "fail"] = (tally[via || "fail"] || 0) + 1;
      report.push({ hotelSno: h.hotelSno, name: h.name, region: h.region, url, status, via, text: detail ? detail.text : null });
      process.stdout.write(`\r  진행 ${++i}/${TARGETS.length} (shifter ${tally.shifter}/hasdata ${tally.hasdata}/local ${tally.local}/fail ${tally.fail}/URL없음 ${tally.no_url})   `);
    }
  }
  await Promise.all(Array.from({ length: 6 }, (_, n) => worker(n)));
  await browser.close();
  console.log("\n");
  report.sort((a, b) => a.hotelSno - b.hotelSno);
  fs.writeFileSync(path.join(OUTDIR, "_recheck-flow-report.json"), JSON.stringify({ tally, report }, null, 2));
  const okN = report.filter((r) => r.status === "ok").length;
  console.log("=== flow.md 재접속 결과 ===");
  console.log(`  접속 ok: ${okN} / ${TARGETS.length}  (shifter ${tally.shifter} / HasData ${tally.hasdata} / local ${tally.local})`);
  console.log(`  실패 ${tally.fail} / URL없음 ${tally.no_url || 0}`);
  console.log(`\n--- 실패 목록 ---`);
  for (const r of report.filter((x) => x.status !== "ok")) console.log(`  [${(r.status === "no_url" ? "URL없음" : "fail").padEnd(7)}] ${(r.region || "").padEnd(3)} ${r.name} → ${r.url || "(없음)"}`);
  console.log(`\n리포트: data/raw/korea/${DATE}/homepage/_recheck-flow-report.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
