// 최종 접속 확정 — 현재 프로세스(시드+HEAD해소) 유지 + 구글 URL fallback.
// 각 호텔: 1차 = primary(HEAD 해소된 시드/구글 채택 URL). 실패시 = 구글 URL(HEAD 해소)로 재시도.
// 각 URL은 shifter → (글로벌체인/차단이면) HasData 재시도 → local 순.
// 사용: node src/collector/finalize-homepage.js
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

function loadEnv() {
  try { const txt = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8");
    for (const line of txt.split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim(); } } catch {}
}
loadEnv();
const HOST = process.env.SHIFTER_HOST || "astraeus.p.shifter.io";
const PORTS = (process.env.SHIFTER_PORT_LIST || "10565,10566,10567,10568,10569,10570,10571,10572,10573,10574").split(",").map((s) => Number(s.trim())).filter(Boolean);
const KEY = process.env.HASDATA_API_KEY || "";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BLOCK_RE = /Pardon Our Interruption|Access Denied|Reference #|captcha|cf-browser-verification|are you a robot|verify you are human/i;
const CHAIN_RE = /marriott\.com|hyatt\.com|ihg\.com|fourseasons\.com|hilton\.com/i;
const DATE = "2026-06-20-corrected";
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", DATE, "homepage");

const V2 = JSON.parse(fs.readFileSync("/tmp/corrected_v2.json", "utf8"));        // primary(HEAD 해소)
const G = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "raw", "korea", "2026-06-20", "homepage", "_google-correct-report.json"), "utf8")).report;
const gMap = {}; for (const r of G) gMap[r.hotelSno] = r.googleUrl;

const norm = (u) => (u || "").replace(/\/+$/, "");
function resolveLanding(url) {
  return new Promise((res) => { execFile("curl", ["-4", "-sIL", "-m", "20", "-A", UA, "-o", "/dev/null", "-w", "%{http_code} %{url_effective}", url],
    (e, out) => { const m = (out || "").match(/^(\d+)\s+(\S+)/); if (!m || +m[1] === 0) return res(url); let f = m[2]; try { const u = new URL(f); if ((u.port === "443" && u.protocol === "https:") || (u.port === "80" && u.protocol === "http:")) { u.port = ""; f = u.href; } } catch {} res(f); }); });
}
function curlGet(url, port) {
  return new Promise((res) => { const a = ["-4", "-sL", "-m", "25", "-A", UA, "--max-filesize", "2000000", "-r", "0-30000"]; if (port) a.push("-x", `http://${HOST}:${port}`); a.push("-w", "\n__H__%{http_code}", url);
    execFile("curl", a, { maxBuffer: 8 * 1024 * 1024 }, (e, out) => { out = out || ""; const m = out.match(/__H__(\d+)\s*$/); res({ code: m ? +m[1] : 0, body: out.replace(/\n__H__\d+\s*$/, "") }); }); });
}
function hasdataWeb(url) {
  return new Promise((res) => { execFile("curl", ["-s", "-m", "75", "-X", "POST", "https://api.hasdata.com/scrape/web", "-H", `x-api-key: ${KEY}`, "-H", "Content-Type: application/json", "-d", JSON.stringify({ url, jsRendering: true }), "-w", "\n__A__%{http_code}"],
    { maxBuffer: 64 * 1024 * 1024 }, (e, out) => { out = out || ""; const a = (out.match(/__A__(\d+)$/) || [])[1]; const j = out.replace(/\n__A__\d+$/, ""); let st = null, c = ""; try { const o = JSON.parse(j); st = o.requestMetadata && o.requestMetadata.status; c = o.content || ""; } catch {} res({ api: +a || 0, status: st, chars: c.length, blocked: BLOCK_RE.test(c.slice(0, 4000)) }); }); });
}
const classify = (code, body) => code === 0 ? "failed" : (code >= 200 && code < 400 ? (BLOCK_RE.test(body || "") ? "blocked" : "ok") : "http_error");

// 한 URL을 shifter → (체인/차단)HasData재시도 → local 로 시도
async function tryUrl(url, port) {
  let r = await curlGet(url, port);
  if (classify(r.code, r.body) === "ok") return { ok: true, method: "shifter" };
  if (KEY && (CHAIN_RE.test(url) || classify(r.code, r.body) !== "failed")) {
    for (let t = 0; t < 6; t++) { const h = await hasdataWeb(url); if (h.api === 200 && h.status === "ok" && h.chars > 1500 && !h.blocked) return { ok: true, method: "hasdata", tries: t + 1 }; }
  }
  r = await curlGet(url, null);
  if (classify(r.code, r.body) === "ok") return { ok: true, method: "local" };
  return { ok: false, method: "none", code: r.code };
}

async function main() {
  console.log(`[korea] 최종 접속 확정 — ${V2.length}곳 (1차 primary → 실패시 구글 URL fallback)\n`);
  const report = [];
  let i = 0, idx = 0; const tally = { ok: 0, ok_google: 0, fail: 0, no_url: 0 };
  async function worker(n) {
    let port = PORTS[n % PORTS.length];
    while (true) {
      const k = idx++; if (k >= V2.length) break;
      const h = V2[k];
      const primary = h.homepage || null;
      const gUrl = gMap[h.hotelSno] || null;
      let status = "no_url", used = null, method = null, fallback = false;
      if (primary) {
        const a = await tryUrl(primary, port);
        port = PORTS[(PORTS.indexOf(port) + 1) % PORTS.length];
        if (a.ok) { status = "ok"; used = primary; method = a.method; }
        else if (gUrl && norm(gUrl) !== norm(primary)) {                 // 구글 URL fallback
          const gLanding = await resolveLanding(gUrl);
          const b = await tryUrl(gLanding, port);
          port = PORTS[(PORTS.indexOf(port) + 1) % PORTS.length];
          if (b.ok) { status = "ok"; used = gLanding; method = b.method; fallback = true; }
          else { status = "fail"; used = primary; }
        } else { status = "fail"; used = primary; }
      }
      if (status === "ok") { tally.ok++; if (fallback) tally.ok_google++; }
      else if (status === "no_url") tally.no_url++;
      else tally.fail++;
      report.push({ hotelSno: h.hotelSno, name: h.name, region: h.region, status, urlUsed: used, method, googleFallback: fallback, primary, googleUrl: gUrl });
      process.stdout.write(`\r  진행 ${++i}/${V2.length} (ok ${tally.ok} [구글fallback ${tally.ok_google}] / fail ${tally.fail} / URL없음 ${tally.no_url})   `);
    }
  }
  await Promise.all(PORTS.map((_, n) => worker(n)));
  console.log("\n");
  report.sort((a, b) => a.hotelSno - b.hotelSno);
  fs.writeFileSync(path.join(OUTDIR, "_final-reachability.json"), JSON.stringify({ tally, report }, null, 2));
  // 최종 접속 가능 호텔 리스트(profiles 수집용)
  fs.writeFileSync(path.join(OUTDIR, "_final-urls.json"), JSON.stringify(report.filter((r) => r.status === "ok").map((r) => ({ hotelSno: r.hotelSno, name: r.name, region: r.region, homepage: r.urlUsed, viaGoogle: r.googleFallback })), null, 2));

  console.log("=== 최종 접속 확정 ===");
  console.log(`  접속 ok: ${tally.ok} / ${V2.length}  (그중 구글 URL fallback으로 성공: ${tally.ok_google})`);
  console.log(`  실패: ${tally.fail}  / URL없음: ${tally.no_url}`);
  console.log(`\n--- 구글 URL fallback으로 살아난 곳 ---`);
  for (const r of report.filter((x) => x.googleFallback)) console.log(`  [${r.method}] ${(r.region || "").padEnd(3)} ${r.name}\n      primary: ${r.primary}\n      구글:    ${r.urlUsed}`);
  console.log(`\n--- 최종 실패 ---`);
  for (const r of report.filter((x) => x.status !== "ok")) console.log(`  [${r.status}] ${(r.region || "").padEnd(3)} ${r.name} → ${r.primary || "(URL없음)"}`);
  console.log(`\n리포트: data/raw/korea/${DATE}/homepage/_final-reachability.json`);
}
main();
