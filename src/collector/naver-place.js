// 네이버 플레이스 호텔 홈페이지 추출 — ai-fnb-trend식 (Playwright 세션재사용 + 4 포트 병렬워커).
// 핵심: 워커마다 브라우저+컨텍스트 1개 재사용(세션 연속) + 전용 shifter 포트(=전용 IP) → rate-limit 분산.
// 데이터는 window.__APOLLO_STATE__ 에서 읽음(렌더링 불필요, curl 아님). 사용: node src/collector/naver-place.js <targets.json> [outName] [date]
const { chromium } = require("playwright");
const { execFile } = require("child_process");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");

function loadEnv() { try { const t = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8"); for (const l of t.split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim(); } } catch {} }
loadEnv();
const HOST = process.env.SHIFTER_HOST || "astraeus.p.shifter.io";
const ALL_PORTS = (process.env.SHIFTER_PORT_LIST || "10565,10566,10567,10568,10569,10570,10571,10572,10573,10574").split(",").map((s) => Number(s.trim())).filter(Boolean);
const WORKER_PORTS = ALL_PORTS.slice(0, 4);   // ai-fnb-trend: 4 포트 = 4 워커 = 4 IP
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SRC = process.argv[2] || "/tmp/naver-target.json";
const OUTNAME = process.argv[3] || "_naver-place-report.json";
const DATE = process.argv[4] || "2026-06-21";
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", DATE, "homepage");
const targets = JSON.parse(fs.readFileSync(SRC, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RENDER_WAIT = 1800;   // Apollo 채워질 때까지 페이지 대기
const RL_BACKOFF = 15000;   // rate-limit 시 백오프
let IP = null;

function aliveCheck(url) { return new Promise((res) => execFile("curl", ["-4", "-sIL", "-m", "15", "-A", UA, "-o", "/dev/null", "-w", "%{http_code}", url], (e, o) => res(Number((o || "").trim()) || 0))); }

// 한 페이지 열어 평가. RL 감지 시 {rateLimited:true}
async function evalPage(ctx, url, fn) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(RENDER_WAIT);
    const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : "").catch(() => "");
    if (/이용이 제한|과도한 접근/.test(body)) { await page.close(); return { rateLimited: true }; }
    const out = await page.evaluate(fn).catch(() => null);
    await page.close();
    return { out };
  } catch (e) { await page.close().catch(() => {}); return { err: String(e).split("\n")[0].slice(0, 50) }; }
}

async function lookup(ctx, name) {
  // 1) list → 첫 place id. 런타임 __APOLLO_STATE__는 축약본이라 원본 HTML(임베드 state) 정규식으로 추출.
  const r1 = await evalPage(ctx, "https://pcmap.place.naver.com/place/list?query=" + encodeURIComponent(name) + "&display=20", () => {
    const h = document.documentElement.outerHTML;
    const m = h.match(/"items":\[\{"__ref":"PlaceListBusinessesItem:(\d+)"/) || h.match(/PlaceListBusinessesItem:(\d+)/);
    return m ? m[1] : null;
  });
  if (r1.rateLimited) return { rateLimited: true };
  const id = r1.out;
  if (!id) return { id: null };
  // 2) 상세 → 본문텍스트의 "홈페이지 {url}" + 원본 HTML의 isDeadUrl
  for (const seg of ["accommodation", "place"]) {
    const r2 = await evalPage(ctx, `https://pcmap.place.naver.com/${seg}/${id}/home`, () => {
      const t = document.body ? document.body.innerText : "";
      const url = (t.match(/홈페이지\s+(https?:\/\/[^\s]+)/) || [])[1] || null;
      let dead = null;
      if (url) { const blk = (document.documentElement.outerHTML.match(/"homepages":\{[\s\S]{0,600}?"repr":\{[\s\S]{0,400}?\}/) || [])[0]; if (blk) dead = /"isDeadUrl":true/.test(blk); }
      const hasState = document.documentElement.outerHTML.includes("__APOLLO_STATE__");
      return { url, dead, hasState };
    });
    if (r2.rateLimited) return { id, rateLimited: true };
    if (r2.out && r2.out.url) return { id, seg, homepage: r2.out.url, naverDead: r2.out.dead };
    if (r2.out && r2.out.hasState) return { id, seg, homepage: null };  // 상세 정상이나 홈페이지 미등록
  }
  return { id, homepage: null };
}

async function worker(port, slice, report, tally) {
  const browser = await chromium.launch({ headless: true, proxy: { server: `http://${IP}:${port}` }, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR", viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "Referer": "https://map.naver.com/" }, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  for (const t of slice) {
    let r = await lookup(ctx, t.name);
    if (r.rateLimited) { await sleep(RL_BACKOFF); r = await lookup(ctx, t.name); }  // 백오프 후 1회 재시도
    let hpAlive = null;
    if (r.homepage) { tally.found++; const code = await aliveCheck(r.homepage); hpAlive = code >= 200 && code < 400; if (hpAlive) tally.verified++; }
    const same = r.homepage && t.googleUrl && r.homepage.replace(/\/+$/, "") === String(t.googleUrl).replace(/\/+$/, "");
    if (r.homepage && !same) tally.diff++;
    if (r.rateLimited) tally.rl++;
    report.push({ hotelSno: t.hotelSno, name: t.name, region: t.region, reason: t.reason, googleUrl: t.googleUrl || null,
      naverPlaceId: r.id || null, naverHomepage: r.homepage || null, naverIsDeadUrl: r.naverDead ?? null, naverHpAlive: hpAlive, sameAsGoogle: !!same, rateLimited: !!r.rateLimited, port });
    tally.done++;
    process.stdout.write(`\r  진행 ${tally.done}/${targets.length} (확보 ${tally.found} / rate-limit ${tally.rl})   `);
    await sleep(1500);   // 업체 간 가벼운 간격(세션 재사용이라 큰 delay 불필요)
  }
  await browser.close().catch(() => {});
}

async function main() {
  IP = (await dns.resolve4(HOST))[0];
  console.log(`[korea] 네이버 플레이스 — ai-fnb-trend식 (Playwright 세션재사용 + ${WORKER_PORTS.length} 포트 병렬워커, ${HOST}→${IP})`);
  console.log(`  대상 ${targets.length}곳, 포트 ${WORKER_PORTS.join(",")}\n`);
  // 호텔을 4 워커로 분배 (라운드로빈)
  const slices = WORKER_PORTS.map(() => []);
  targets.forEach((t, i) => slices[i % WORKER_PORTS.length].push(t));
  const report = []; const tally = { done: 0, found: 0, verified: 0, diff: 0, rl: 0 };
  await Promise.all(WORKER_PORTS.map((p, i) => worker(p, slices[i], report, tally)));
  console.log("\n");
  report.sort((a, b) => a.hotelSno - b.hotelSno);
  fs.writeFileSync(path.join(OUTDIR, OUTNAME), JSON.stringify(report, null, 2));
  console.log("=== 결과 ===");
  console.log(`  네이버 홈페이지 확보: ${tally.found}/${targets.length} | 접속검증 통과: ${tally.verified} | 구글과 다른 URL: ${tally.diff} | rate-limit: ${report.filter((x) => x.rateLimited).length}`);
  console.log(`  리포트: data/raw/korea/${DATE}/homepage/${OUTNAME}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
