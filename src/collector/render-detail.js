// 호텔 상세 — 공식 홈페이지 헤드리스 렌더링 수집 (Playwright + Shifter 프록시)
// JS 렌더링이 필요한 호텔 사이트를 실제 브라우저로 그려서 HTML + 가시 텍스트를 저장한다.
// fetch와 추출 분리: 여기선 렌더 결과 원본만 raw/ 에 저장. 추출은 별도 단계(Claude).
// 사용: node src/collector/render-detail.js [hotels.json] [date] [concurrency]
const { chromium } = require("playwright");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");

// Shifter 로테이팅 프록시. 호스트는 게이트웨이, 출구 IP 로테이션은 포트별로 일어난다.
const PROXY_HOST = "astraeus.p.shifter.io";
// 호스트명을 그대로 주면 Chromium이 IPv6로 접속해 403(ACL) → 런타임에 IPv4(A레코드)로 resolve해서 사용
let PROXY_IP = null; // main()에서 dns.resolve4 로 채움
const PORTS = [10565, 10566, 10567, 10568, 10569, 10570, 10571, 10572, 10573, 10574];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SRC = process.argv[2] || "/tmp/pilot.json";
const DATE = process.argv[3] || new Date().toISOString().slice(0, 10);
const CONC = Number(process.argv[4] || 4);
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", DATE, "homepage");

const BLOCK_RE = /Pardon Our Interruption|Access Denied|잠시 후 다시|비정상적인 접근|captcha|cf-browser-verification|Request unsuccessful|are you a robot/i;

async function renderOnce(browser, url, port) {
  const ctx = await browser.newContext({
    proxy: { server: `http://${PROXY_IP}:${port}` },
    userAgent: UA,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" },
    ignoreHTTPSErrors: true,
  });
  // webdriver 흔적 제거
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    try { await page.waitForLoadState("networkidle", { timeout: 12000 }); } catch (_) {}
    await page.waitForTimeout(1500);
    const html = await page.content();
    const text = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
    const status = resp ? resp.status() : 0;
    const finalUrl = page.url();
    return { ok: true, status, html, text, finalUrl };
  } catch (e) {
    return { ok: false, status: 0, html: "", text: "", err: String(e).split("\n")[0].slice(0, 80) };
  } finally {
    await ctx.close();
  }
}

async function renderWithRetry(browser, url, startPort, tries = 3) {
  let port = startPort, last = null;
  for (let t = 0; t < tries; t++) {
    const r = await renderOnce(browser, url, port);
    last = r;
    if (r.ok && (r.text || "").length > 250 && !BLOCK_RE.test(r.text)) return { ...r, port };
    port = PORTS[(PORTS.indexOf(port) + 1) % PORTS.length];
  }
  return { ...last, port };
}

function classify(r) {
  if (!r || !r.ok || (!r.html && !r.text)) return "failed";
  if (BLOCK_RE.test(r.text) || BLOCK_RE.test(r.html)) return "blocked";
  if ((r.text || "").length < 250) return "thin";
  return "ok";
}

async function main() {
  // Shifter 게이트웨이를 IPv4로 resolve (IPv6 접속 시 ACL 403 방지)
  const a = await dns.resolve4(PROXY_HOST);
  PROXY_IP = a[0];

  const hotels = JSON.parse(fs.readFileSync(SRC, "utf8"))
    .filter((h) => h.homepage && /^https?:\/\//.test(h.homepage));
  fs.mkdirSync(OUTDIR, { recursive: true });
  console.log(`[korea/detail] 헤드리스 렌더 수집 — ${hotels.length}곳 (date=${DATE}, 동시 ${CONC})`);
  console.log(`  프록시: ${PROXY_HOST} → ${PROXY_IP} (IPv4), 포트 로테이션 ${PORTS[0]}~${PORTS[PORTS.length - 1]}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const report = [];
  let done = 0, idx = 0;
  const tally = { ok: 0, thin: 0, blocked: 0, failed: 0 };
  async function worker(n) {
    let port = PORTS[n % PORTS.length];
    while (true) {
      const k = idx++;
      if (k >= hotels.length) break;
      const h = hotels[k];
      const r = await renderWithRetry(browser, h.homepage, port, 3);
      port = PORTS[(PORTS.indexOf(r.port) + 1) % PORTS.length];
      const status = classify(r);
      tally[status]++;
      if (status !== "failed") {
        fs.writeFileSync(path.join(OUTDIR, `${h.hotelSno}.html`), r.html);
        fs.writeFileSync(path.join(OUTDIR, `${h.hotelSno}.txt`), r.text || "");
      }
      report.push({ hotelSno: h.hotelSno, name: h.name, http: r.status, status,
        htmlBytes: (r.html || "").length, textChars: (r.text || "").length, finalUrl: r.finalUrl, err: r.err });
      process.stdout.write(`\r  진행 ${++done}/${hotels.length} (ok ${tally.ok}/thin ${tally.thin}/blocked ${tally.blocked}/fail ${tally.failed})   `);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, hotels.length) }, (_, n) => worker(n)));
  await browser.close();
  console.log("");

  fs.writeFileSync(path.join(OUTDIR, "_render-report.json"), JSON.stringify(report, null, 2));
  console.log("\n=== 헤드리스 렌더 수집 결과 ===");
  for (const r of report.sort((a, b) => a.status.localeCompare(b.status)))
    console.log(`  [${r.status.padEnd(7)}] http=${r.http} text=${String(r.textChars).padStart(6)} ${r.name}`);
  console.log(`\n합계: ok ${tally.ok} / thin ${tally.thin} / blocked ${tally.blocked} / failed ${tally.failed}  (총 ${hotels.length})`);
  console.log(`raw 저장: data/raw/korea/${DATE}/homepage/<hotelSno>.{html,txt}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
