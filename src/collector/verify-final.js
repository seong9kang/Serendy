// 최종 통합 접속 점검 — 모든 기법 총동원.
// 각 호텔: primary → (실패) 구글URL → (실패) 루트. 각 URL: shifter curl → local curl
//   → shifter Playwright stealth → local Playwright stealth → HasData(JS렌더, 재시도).
// 2단계: (A) 전수 curl 빠른 점검 → (B) 실패분만 Playwright/HasData.
// 사용: node src/collector/verify-final.js
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
const BLOCK_RE = /Pardon Our Interruption|Access Denied|Reference #|captcha|cf-browser-verification|are you a robot|verify you are human|보안문자/i;
const DATE = "2026-06-20-corrected";
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", DATE, "homepage");

const V2 = JSON.parse(fs.readFileSync("/tmp/corrected_v2.json", "utf8"));
const G = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "raw", "korea", "2026-06-20", "homepage", "_google-correct-report.json"), "utf8")).report;
const gMap = {}; for (const r of G) gMap[r.hotelSno] = r.googleUrl;

const norm = (u) => (u || "").replace(/\/+$/, "");
const rootOf = (u) => { try { return new URL(u).origin + "/"; } catch { return null; } };
const classify = (code, body) => code === 0 ? "failed" : (code >= 200 && code < 400 ? (BLOCK_RE.test(body || "") ? "blocked" : "ok") : "http_error");

function resolveLanding(url) { return new Promise((res) => { execFile("curl", ["-4", "-sIL", "-m", "20", "-A", UA, "-o", "/dev/null", "-w", "%{http_code} %{url_effective}", url], (e, out) => { const m = (out || "").match(/^(\d+)\s+(\S+)/); if (!m || +m[1] === 0) return res(url); let f = m[2]; try { const u = new URL(f); if ((u.port === "443" && u.protocol === "https:") || (u.port === "80" && u.protocol === "http:")) { u.port = ""; f = u.href; } } catch {} res(f); }); }); }
function curlGet(url, port) { return new Promise((res) => { const a = ["-4", "-sL", "-m", "25", "-A", UA, "--max-filesize", "2000000", "-r", "0-30000"]; if (port) a.push("-x", `http://${HOST}:${port}`); a.push("-w", "\n__H__%{http_code}", url); execFile("curl", a, { maxBuffer: 8 * 1024 * 1024 }, (e, out) => { out = out || ""; const m = out.match(/__H__(\d+)\s*$/); res({ code: m ? +m[1] : 0, body: out.replace(/\n__H__\d+\s*$/, "") }); }); }); }
function hasdataWeb(url) { return new Promise((res) => { execFile("curl", ["-s", "-m", "75", "-X", "POST", "https://api.hasdata.com/scrape/web", "-H", `x-api-key: ${KEY}`, "-H", "Content-Type: application/json", "-d", JSON.stringify({ url, jsRendering: true }), "-w", "\n__A__%{http_code}"], { maxBuffer: 64 * 1024 * 1024 }, (e, out) => { out = out || ""; const a = (out.match(/__A__(\d+)$/) || [])[1]; const j = out.replace(/\n__A__\d+$/, ""); let st = null, c = ""; try { const o = JSON.parse(j); st = o.requestMetadata && o.requestMetadata.status; c = o.content || ""; } catch {} res({ ok: (+a === 200 && st === "ok" && c.length > 1500 && !BLOCK_RE.test(c.slice(0, 4000))) }); }); }); }

let PROXY_IP = null;
async function render(browser, url, port) {
  const ctx = await browser.newContext({ proxy: port ? { server: `http://${PROXY_IP}:${port}` } : undefined, userAgent: UA, locale: "ko-KR", timezoneId: "Asia/Seoul", viewport: { width: 1366, height: 900 }, extraHTTPHeaders: { "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" }, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const page = await ctx.newPage();
  try { const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 }); try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {} await page.waitForTimeout(1000); const txt = await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => ""); return { code: r ? r.status() : 0, body: txt, ok: r && r.status() >= 200 && r.status() < 400 && txt.length > 250 && !BLOCK_RE.test(txt) }; }
  catch { return { code: 0, body: "", ok: false }; } finally { await ctx.close(); }
}

async function main() {
  console.log(`[korea] 최종 통합 접속 점검 — ${V2.length}곳`);
  // === Phase A: 전수 curl (shifter→local) 빠른 점검 ===
  const result = {}; // sno -> {status, method, url}
  let aIdx = 0, aDone = 0, aOk = 0;
  async function aWorker(n) {
    let port = PORTS[n % PORTS.length];
    while (true) { const k = aIdx++; if (k >= V2.length) break; const h = V2[k]; const cands = [h.homepage, gMap[h.hotelSno]].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
      let hit = null;
      for (const url of cands) { let r = await curlGet(url, port); if (classify(r.code, r.body) === "ok") { hit = { method: "shifter-curl", url }; break; } r = await curlGet(url, null); if (classify(r.code, r.body) === "ok") { hit = { method: "local-curl", url }; break; } port = PORTS[(PORTS.indexOf(port) + 1) % PORTS.length]; }
      result[h.hotelSno] = hit ? { status: "ok", ...hit } : { status: "fail" };
      if (hit) aOk++;
      process.stdout.write(`\r  [A/curl] ${++aDone}/${V2.length} (ok ${aOk})   `);
    }
  }
  await Promise.all(PORTS.map((_, n) => aWorker(n)));
  console.log("");

  // === Phase B: 실패분만 Playwright stealth + HasData ===
  const failed = V2.filter((h) => result[h.hotelSno].status !== "ok");
  console.log(`  [B] curl 실패 ${failed.length}곳 → Playwright/HasData 총동원\n`);
  PROXY_IP = (await dns.resolve4(HOST))[0];
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
  let bIdx = 0, bDone = 0, bOk = 0;
  async function bWorker(n) {
    let port = PORTS[n % PORTS.length];
    while (true) {
      const k = bIdx++; if (k >= failed.length) break; const h = failed[k];
      // 후보: primary, 구글landing, 루트들
      const prim = h.homepage; const g = gMap[h.hotelSno]; const gl = g ? await resolveLanding(g) : null;
      const cands = [prim, gl, rootOf(prim), gl ? rootOf(gl) : null].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
      let hit = null;
      outer: for (const url of cands) {
        let r = await render(browser, url, port); if (r.ok) { hit = { method: "shifter-playwright", url }; break outer; }
        r = await render(browser, url, null); if (r.ok) { hit = { method: "local-playwright", url }; break outer; }
        if (KEY) { for (let t = 0; t < 6; t++) { const hd = await hasdataWeb(url); if (hd.ok) { hit = { method: `hasdata(${t + 1})`, url }; break outer; } } }
        port = PORTS[(PORTS.indexOf(port) + 1) % PORTS.length];
      }
      if (hit) { result[h.hotelSno] = { status: "ok", ...hit }; bOk++; }
      else result[h.hotelSno] = { status: "fail", url: prim };
      process.stdout.write(`\r  [B] ${++bDone}/${failed.length} (ok ${bOk})   `);
    }
  }
  await Promise.all(Array.from({ length: 4 }, (_, n) => bWorker(n)));
  await browser.close();
  console.log("\n");

  // === 집계 + 공식사이트 확정 ===
  const rows = V2.map((h) => { const r = result[h.hotelSno]; return { hotelSno: h.hotelSno, name: h.name, region: h.region, official: r.status === "ok" ? r.url : (gMap[h.hotelSno] || h.homepage || null), connected: r.status === "ok", method: r.method || "" }; });
  fs.writeFileSync(path.join(OUTDIR, "_official-sites.json"), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(OUTDIR, "_official-sites.csv"), ["hotelSno,name,region,official_url,connected,method"].concat(rows.map((r) => [r.hotelSno, `"${r.name}"`, r.region, r.official || "", r.connected, r.method].join(","))).join("\n"));
  const byMethod = {}; for (const r of rows) if (r.connected) byMethod[r.method.replace(/\(\d+\)/, "")] = (byMethod[r.method.replace(/\(\d+\)/, "")] || 0) + 1;
  const okN = rows.filter((r) => r.connected).length;
  console.log("=== 최종 통합 점검 결과 ===");
  console.log(`  접속 ok: ${okN} / ${V2.length}`);
  console.log("  방법별:", JSON.stringify(byMethod));
  console.log(`\n--- 최종 미접속 ---`);
  for (const r of rows.filter((x) => !x.connected)) console.log(`  ${(r.region || "").padEnd(3)} ${r.name} → ${r.official || "(URL없음)"}`);
  console.log(`\n저장: ${path.relative(path.join(__dirname, "..", ".."), path.join(OUTDIR, "_official-sites.json"))} (+.csv)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
