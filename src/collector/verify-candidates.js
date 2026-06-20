// flow.md 2단계 — 후보(seed/maps/serp) 순서대로 접속, 실제 렌더되는 것을 채택.
// 각 URL: shifter(렌더) → HasData(jsRendering) → local(렌더). frameset/하이드레이션 대응.
// 입력: _google-correct-report.json (candidates 포함). 사용: node src/collector/verify-candidates.js [date]
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
const DATE = process.argv[2] || "2026-06-21";
const ONLY = process.argv[3] ? new Set(process.argv[3].split(",").map((s) => Number(s.trim()))) : null; // 특정 hotelSno만 재시도
const HD_TRIES = Number(process.env.HASDATA_TRIES || 4);
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", DATE, "homepage");
let GC = require(path.join(OUTDIR, "_google-correct-report.json")).report;
if (ONLY) GC = GC.filter((r) => ONLY.has(r.hotelSno));

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
    let txt = await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
    if (txt.trim().length < 250 && page.frames().length > 1) { for (const fr of page.frames()) { try { const t = await fr.evaluate(() => (document.body ? document.body.innerText : "")); if (t) txt += "\n" + t; } catch (_) {} } }
    const code = r ? r.status() : 0;
    return { ok: code >= 200 && code < 400 && txt.trim().length > 250 && !BLOCK_RE.test(txt), text: txt.trim().length };
  } catch { return { ok: false, text: 0 }; } finally { await ctx.close(); }
}
function hasdata(url) { return new Promise((res) => { execFile("curl", ["-s", "-m", "75", "-X", "POST", "https://api.hasdata.com/scrape/web", "-H", `x-api-key: ${KEY}`, "-H", "Content-Type: application/json", "-d", JSON.stringify({ url, jsRendering: true }), "-w", "\n__A__%{http_code}"], { maxBuffer: 64 * 1024 * 1024 }, (e, out) => { out = out || ""; const a = (out.match(/__A__(\d+)$/) || [])[1]; const j = out.replace(/\n__A__\d+$/, ""); let st = null, c = ""; try { const o = JSON.parse(j); st = o.requestMetadata && o.requestMetadata.status; c = o.content || ""; } catch {} res({ ok: +a === 200 && st === "ok" && c.length > 1500 && !BLOCK_RE.test(c.slice(0, 4000)) }); }); }); }

// 한 URL: shifter 렌더 → HasData → local 렌더
async function tryUrl(browser, url, port) {
  let r = await render(browser, url, port); if (r.ok) return { tier: "shifter", text: r.text };
  if (KEY) { for (let t = 0; t < HD_TRIES; t++) { if ((await hasdata(url)).ok) return { tier: "hasdata", text: null }; } }
  r = await render(browser, url, null); if (r.ok) return { tier: "local", text: r.text };
  return null;
}

async function main() {
  PROXY_IP = (await dns.resolve4(HOST))[0];
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
  console.log(`[korea] step2 후보-기반 접속 — ${GC.length}곳 | 후보 순서대로 shifter→HasData→local(렌더)\n  프록시 ${HOST}→${PROXY_IP}\n`);
  const report = []; let i = 0, idx = 0; const tally = { ok: 0, ok_fallback: 0, fail: 0, no_url: 0 };
  async function worker(n) {
    let port = PORTS[n % PORTS.length];
    while (true) {
      const k = idx++; if (k >= GC.length) break; const h = GC[k];
      const cands = (h.candidates || []).map((c) => c.landing || c.url).filter((u) => u && /^https?:\/\//.test(u));
      let hit = null, usedIdx = -1;
      for (let ci = 0; ci < cands.length; ci++) {
        const res = await tryUrl(browser, cands[ci], port);
        port = PORTS[(PORTS.indexOf(port) + 1) % PORTS.length];
        if (res) { hit = { url: cands[ci], ...res }; usedIdx = ci; break; }
      }
      let status;
      if (!cands.length) { status = "no_url"; tally.no_url++; }
      else if (hit) { status = "ok"; tally.ok++; if (usedIdx > 0) tally.ok_fallback++; }
      else { status = "fail"; tally.fail++; }
      report.push({ hotelSno: h.hotelSno, name: h.name, region: h.region, status,
        official: hit ? hit.url : (cands[0] || null), source: hit ? (h.candidates[usedIdx].source) : null,
        tier: hit ? hit.tier : null, viaFallback: usedIdx > 0, candidateCount: cands.length,
        maps: h.maps || null });
      process.stdout.write(`\r  진행 ${++i}/${GC.length} (ok ${tally.ok}[fallback ${tally.ok_fallback}] / fail ${tally.fail} / URL없음 ${tally.no_url})   `);
    }
  }
  await Promise.all(Array.from({ length: 6 }, (_, n) => worker(n)));
  await browser.close();
  console.log("\n");
  report.sort((a, b) => a.hotelSno - b.hotelSno);
  if (ONLY) {
    // 재시도 모드: 전체 파일 덮어쓰지 않고 별도 저장 + _official-sites.json 의 해당 항목만 갱신
    fs.writeFileSync(path.join(OUTDIR, "_retry-report.json"), JSON.stringify({ tally, report }, null, 2));
    const osPath = path.join(OUTDIR, "_official-sites.json");
    try {
      const os = JSON.parse(fs.readFileSync(osPath, "utf8"));
      const upd = {}; for (const r of report) upd[r.hotelSno] = r;
      for (const o of os) { const r = upd[o.hotelSno]; if (r && r.status === "ok") { o.official = r.official; o.connected = true; o.tier = r.tier; o.source = r.source; } }
      fs.writeFileSync(osPath, JSON.stringify(os, null, 2));
      console.log("  (_official-sites.json 해당 항목 갱신 완료)");
    } catch (e) { console.log("  os 갱신 실패:", e.message); }
  } else {
    fs.writeFileSync(path.join(OUTDIR, "_verify-candidates-report.json"), JSON.stringify({ tally, report }, null, 2));
    fs.writeFileSync(path.join(OUTDIR, "_official-sites.json"), JSON.stringify(report.map((r) => ({ hotelSno: r.hotelSno, name: r.name, region: r.region, official: r.official, connected: r.status === "ok", tier: r.tier, source: r.source, rating: r.maps && r.maps.rating, reviews: r.maps && r.maps.reviews, coords: r.maps && r.maps.coords })), null, 2));
  }
  const tierBy = {}; for (const r of report) if (r.status === "ok") tierBy[r.tier] = (tierBy[r.tier] || 0) + 1;
  console.log("=== step2 후보-기반 접속 결과 ===");
  console.log(`  접속 ok: ${tally.ok} / ${GC.length}  (단계: ${JSON.stringify(tierBy)})`);
  console.log(`  fallback 후보로 성공: ${tally.ok_fallback}  | 실패 ${tally.fail} / URL없음 ${tally.no_url}`);
  console.log(`\n--- 최종 실패 ---`);
  for (const r of report.filter((x) => x.status !== "ok")) console.log(`  [${r.status}] ${(r.region || "").padEnd(3)} ${r.name} → ${r.official || "(URL없음)"}`);
  console.log(`\n리포트: data/raw/korea/${DATE}/homepage/_verify-candidates-report.json, _official-sites.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
