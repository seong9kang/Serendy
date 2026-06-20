// 접속 실패 호텔 재시도 — ①URL정제 ②루트폴백 ③Playwright stealth 통합
// 대상: 보정 후 접속 리포트의 non-ok + URL없음. 사용: node src/collector/rescue-homepage.js [correctedList] [afterReport]
const { execFile } = require("child_process");
const { chromium } = require("playwright");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");

function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}
loadEnv();

const HOST = process.env.SHIFTER_HOST || "astraeus.p.shifter.io";
const PORTS = (process.env.SHIFTER_PORT_LIST || "10565,10566,10567,10568,10569,10570,10571,10572,10573,10574")
  .split(",").map((s) => Number(s.trim())).filter(Boolean);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORRECTED = process.argv[2] || "/tmp/corrected.json";
const AFTER = process.argv[3] || path.join(__dirname, "..", "..", "data", "raw", "korea", "2026-06-20-corrected", "homepage", "_reachability-report.json");
const DATE = "2026-06-20-corrected";
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", DATE, "homepage");

const BLOCK_RE = /Pardon Our Interruption|Access Denied|잠시 후 다시|비정상적인 접근|captcha|cf-browser-verification|Request unsuccessful|are you a robot|verify you are human|보안문자/i;

// ① URL 정제: zero-width 제거, 중복스킴 마지막것, 콤마/중복점 교정, IDN→punycode(new URL 자동)
function cleanUrls(raw) {
  if (!raw) return [];
  let s = String(raw).replace(/[​-‏﻿ ]/g, "").trim();
  const ms = [...s.matchAll(/https?:\/\//gi)];
  if (ms.length > 1) s = s.slice(ms[ms.length - 1].index); // 중복 스킴 → 마지막 URL
  s = s.replace(/www,/i, "www.").replace(/(?<!:)\.\.+/g, ".");
  s = s.split(/\s/)[0]; // 공백 앞부분만
  if (!/^https?:\/\//i.test(s)) {
    if (/^[^\s]+\.[^\s]+$/.test(s) && !/[가-힣]/.test(s.replace(/^[^.]*/, ""))) s = "http://" + s;
    else if (/^[^\s]+\.[^\s]+$/.test(s)) s = "http://" + s;
    else return [];
  }
  let u; try { u = new URL(s); } catch { return []; }
  const full = u.href;
  const root = u.origin + "/"; // ② 루트 폴백
  return full === root ? [full] : [full, root];
}

function classifyHttp(code, body) {
  if (code === 0) return "failed";
  if (code >= 200 && code < 400) return BLOCK_RE.test(body || "") ? "blocked" : "ok";
  return "http_error";
}

// curl 한 방 (shifter 또는 local)
function curlGet(url, port) {
  return new Promise((resolve) => {
    const args = ["-4", "-sL", "-m", "25", "-A", UA, "--max-filesize", "2000000", "-r", "0-30000"];
    if (port) args.push("-x", `http://${HOST}:${port}`);
    args.push("-w", "\n__H__%{http_code}__U__%{url_effective}", url);
    execFile("curl", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const out = stdout || "";
      const m = out.match(/__H__(\d+)__U__(.*)$/s);
      resolve({ code: m ? Number(m[1]) : 0, finalUrl: m ? m[2].trim() : url,
        body: out.replace(/\n__H__\d+__U__.*$/s, "") });
    });
  });
}

// ③ Playwright stealth 한 방
let PROXY_IP = null;
async function renderOnce(browser, url, port) {
  const ctx = await browser.newContext({
    proxy: { server: `http://${PROXY_IP}:${port}` }, userAgent: UA,
    locale: "ko-KR", timezoneId: "Asia/Seoul", viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" }, ignoreHTTPSErrors: true,
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch {}
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
    return { code: resp ? resp.status() : 0, finalUrl: page.url(), body: text };
  } catch (e) {
    return { code: 0, finalUrl: url, body: "", err: String(e).split("\n")[0].slice(0, 70) };
  } finally { await ctx.close(); }
}

async function main() {
  const corrected = JSON.parse(fs.readFileSync(CORRECTED, "utf8"));
  const after = JSON.parse(fs.readFileSync(AFTER, "utf8"));
  const cMap = {}; for (const c of corrected) cMap[c.hotelSno] = c;

  // 대상: non-ok + URL없음
  const failSnos = after.report.filter((r) => r.status !== "ok").map((r) => r.hotelSno);
  const noUrlSnos = after.noUrl.map((r) => r.hotelSno);
  const targets = [...failSnos, ...noUrlSnos].map((sno) => cMap[sno]).filter(Boolean);

  PROXY_IP = (await dns.resolve4(HOST))[0];
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
  console.log(`[korea] 접속 실패 ${targets.length}곳 재시도 — ①정제 ②루트폴백 ③Playwright stealth`);
  console.log(`  프록시 ${HOST}→${PROXY_IP} (IPv4)\n`);

  const report = [];
  let i = 0, idx = 0;
  const tally = { ok: 0, blocked: 0, http_error: 0, failed: 0, no_candidate: 0 };
  async function worker(n) {
    let port = PORTS[n % PORTS.length];
    while (true) {
      const k = idx++;
      if (k >= targets.length) break;
      const h = targets[k];
      const cands = cleanUrls(h.homepage);
      let result = null;
      if (!cands.length) {
        result = { method: "no_candidate", url: null, code: 0, status: "no_candidate" };
      } else {
        // 순서: shifter(정제,루트) → playwright(정제,루트) → local(정제,루트)
        outer:
        for (const method of ["shifter", "playwright", "local"]) {
          for (const url of cands) {
            let r;
            if (method === "shifter") r = await curlGet(url, port);
            else if (method === "playwright") r = await renderOnce(browser, url, port);
            else r = await curlGet(url, null);
            const status = classifyHttp(r.code, r.body);
            const cand = { method, url, code: r.code, finalUrl: r.finalUrl, status };
            if (status === "ok") { result = cand; break outer; }
            if (!result || (result.status === "failed" && status !== "failed")) result = cand;
            port = PORTS[(PORTS.indexOf(port) + 1) % PORTS.length];
          }
        }
      }
      tally[result.status] = (tally[result.status] || 0) + 1;
      report.push({ hotelSno: h.hotelSno, name: h.name, region: h.region,
        original: h.homepage, ...result });
      process.stdout.write(`\r  진행 ${++i}/${targets.length} (ok ${tally.ok}/blocked ${tally.blocked}/http_err ${tally.http_error}/fail ${tally.failed})   `);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, (_, n) => worker(n)));
  await browser.close();
  console.log("\n");

  report.sort((a, b) => a.hotelSno - b.hotelSno);
  fs.writeFileSync(path.join(OUTDIR, "_rescue-report.json"), JSON.stringify({ tally, report }, null, 2));

  const okByMethod = {};
  for (const r of report) if (r.status === "ok") okByMethod[r.method] = (okByMethod[r.method] || 0) + 1;
  console.log("=== 재시도 결과 ===");
  console.log(`  새로 접속(ok): ${tally.ok}  (shifter ${okByMethod.shifter || 0} / playwright ${okByMethod.playwright || 0} / local ${okByMethod.local || 0})`);
  console.log(`  여전히 blocked ${tally.blocked} / http_error ${tally.http_error} / failed ${tally.failed} / URL무효 ${tally.no_candidate || 0}`);
  console.log(`\n--- 살아난 곳 (${tally.ok}) ---`);
  for (const r of report.filter((x) => x.status === "ok"))
    console.log(`  [${r.method.padEnd(10)}] ${(r.region || "").padEnd(3)} ${r.name} → ${r.finalUrl}`);
  console.log(`\n--- 여전히 안 됨 ---`);
  for (const r of report.filter((x) => x.status !== "ok"))
    console.log(`  [${r.status.padEnd(11)}] http=${String(r.code).padStart(3)} ${(r.region || "").padEnd(3)} ${r.name} → ${r.url || r.original}`);
  console.log(`\n리포트: data/raw/korea/${DATE}/homepage/_rescue-report.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
