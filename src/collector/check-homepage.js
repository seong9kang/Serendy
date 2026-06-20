// 한국 호텔 — 공식 홈페이지 "루트 접속 가능 여부"만 확인 (파싱/링크추적 없음)
// flow.md 접속 순서: shifter → (HasData) → local. HasData 키 없으면 건너뜀.
// 사용: node src/collector/check-homepage.js [list.json] [date]
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// .env 로드 (의존성 없이 직접 파싱)
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
const HASDATA_KEY = process.env.HASDATA_API_KEY || "";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SRC = process.argv[2] || path.join(__dirname, "..", "..", "data", "hotels", "korea", "list", "latest.json");
const DATE = process.argv[3] || new Date().toISOString().slice(0, 10);
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", DATE, "homepage");

// curl: 루트만, 본문은 차단판정용으로 일부만 받음(-r 0-20000), 상태코드/최종URL 기록
function curlGet(url, { proxyPort = null, timeout = 25 } = {}) {
  return new Promise((resolve) => {
    const args = ["-4", "-sL", "-m", String(timeout), "-A", UA,
      "--max-filesize", "2000000", "-r", "0-30000"];
    if (proxyPort) args.push("-x", `http://${HOST}:${proxyPort}`);
    args.push("-w", "\n__HTTP__%{http_code}__URL__%{url_effective}", url);
    execFile("curl", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const out = stdout || "";
      const m = out.match(/__HTTP__(\d+)__URL__(.*)$/s);
      const code = m ? Number(m[1]) : 0;
      const finalUrl = m ? m[2].trim() : url;
      const body = out.replace(/\n__HTTP__\d+__URL__.*$/s, "");
      resolve({ code, body, finalUrl, err: err ? String(err).slice(0, 50) : null });
    });
  });
}

// HasData Web Scrape (POST /scrape/web). 주의: proxyCountry enum에 KR 없음 →
// 한국 전용 사이트는 HasData로도 실패할 수 있음. 크레딧 절약 위해 jsRendering=false.
function hasdataGet(url, { timeout = 40 } = {}) {
  return new Promise((resolve) => {
    if (!HASDATA_KEY) return resolve({ code: 0, body: "", finalUrl: url, err: "no_key" });
    const payload = JSON.stringify({ url, jsRendering: false });
    execFile("curl", ["-s", "-m", String(timeout), "-X", "POST",
      "https://api.hasdata.com/scrape/web",
      "-H", `x-api-key: ${HASDATA_KEY}`, "-H", "Content-Type: application/json",
      "-d", payload, "-w", "\n__HTTP__%{http_code}"],
      { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        const out = stdout || "";
        const m = out.match(/__HTTP__(\d+)\s*$/);
        const apiCode = m ? Number(m[1]) : 0;
        const json = out.replace(/\n__HTTP__\d+\s*$/, "");
        // HasData 응답 내부 statusCode / content 파싱
        let pageCode = 0, content = "";
        try {
          const o = JSON.parse(json);
          pageCode = o.statusCode || o.status || (apiCode === 200 ? 200 : 0);
          content = o.content || o.html || o.text || "";
        } catch { pageCode = 0; }
        resolve({ code: apiCode === 200 ? (pageCode || 200) : 0, body: content, finalUrl: url,
          err: err ? String(err).slice(0, 50) : (apiCode !== 200 ? `api_${apiCode}` : null) });
      });
  });
}

function looksBlocked(html) {
  return /Pardon Our Interruption|Access Denied|captcha|cf-browser-verification|Request unsuccessful|verify you are human|보안문자/i.test(html);
}

// homepage 문자열 정규화: 공백제거, 스킴 없으면 후보 생성, URL 아니면 null
function normalize(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return [s];
  // 스킴 없음: 도메인 형태인지 검사(점 포함 + 공백 없음)
  if (/^[^\s]+\.[^\s]+$/.test(s) && !/[가-힣]/.test(s)) return [`https://${s}`, `http://${s}`];
  return null; // URL 아님(예: 호텔이름)
}

function classify(r) {
  if (r.code === 0) return "failed";
  if (r.code >= 200 && r.code < 400) {
    if (looksBlocked(r.body)) return "blocked";
    return "ok";
  }
  if (r.code >= 400) return "http_error";
  return "failed";
}

async function probe(candidates, port) {
  // flow.md 순서: shifter → HasData → local. 각 후보(스킴) 순차 시도.
  const tiers = ["shifter"];
  if (HASDATA_KEY) tiers.push("hasdata");
  tiers.push("local");
  let last;
  for (const tier of tiers) {
    for (const url of candidates) {
      let r;
      if (tier === "shifter") r = await curlGet(url, { proxyPort: port });
      else if (tier === "hasdata") r = await hasdataGet(url);
      else r = await curlGet(url, {});
      const status = classify(r);
      if (status === "ok") return { ...r, status, tier, tried: url };
      // http_error/blocked/failed면 다음 후보/티어로
      last = { ...r, status, tier, tried: url };
    }
  }
  return last;
}

async function main() {
  const list = JSON.parse(fs.readFileSync(SRC, "utf8"));
  fs.mkdirSync(OUTDIR, { recursive: true });

  const targets = [];
  const noUrl = [];
  for (const h of list) {
    const cands = normalize(h.homepage);
    if (!cands) { noUrl.push({ hotelSno: h.hotelSno, name: h.name, homepage: h.homepage || null, region: h.region }); continue; }
    targets.push({ hotelSno: h.hotelSno, name: h.name, region: h.region, candidates: cands });
  }

  console.log(`[korea] 홈페이지 루트 접속 확인 — 대상 ${targets.length}곳 / URL없음 ${noUrl.length}곳 (총 ${list.length})`);
  console.log(`접속 순서: shifter(프록시) → ${HASDATA_KEY ? "HasData → " : ""}local.${HASDATA_KEY ? "" : "  ※HASDATA_API_KEY 없음 → HasData 건너뜀."}\n`);

  const report = [];
  let done = 0, ok = 0, blocked = 0, httpErr = 0, failed = 0, idx = 0;
  async function worker(n) {
    const port = PORTS[n % PORTS.length];
    while (true) {
      const k = idx++;
      if (k >= targets.length) break;
      const t = targets[k];
      const r = await probe(t.candidates, port);
      if (r.status === "ok") ok++;
      else if (r.status === "blocked") blocked++;
      else if (r.status === "http_error") httpErr++;
      else failed++;
      report.push({ hotelSno: t.hotelSno, name: t.name, region: t.region,
        status: r.status, tier: r.tier, http: r.code, finalUrl: r.finalUrl, tried: r.tried, err: r.err });
      process.stdout.write(`\r  진행 ${++done}/${targets.length}  (ok ${ok} / blocked ${blocked} / http_error ${httpErr} / fail ${failed})    `);
    }
  }
  await Promise.all(PORTS.map((_, n) => worker(n)));
  console.log("\n");

  report.sort((a, b) => (a.hotelSno - b.hotelSno));
  fs.writeFileSync(path.join(OUTDIR, "_reachability-report.json"),
    JSON.stringify({ date: DATE, total: list.length, checked: targets.length, noUrl, report }, null, 2));

  const reachable = ok;
  console.log("=== 한국 호텔 홈페이지 루트 접속 결과 ===");
  console.log(`  접속 성공(ok)   : ${ok}`);
  console.log(`  차단(blocked)   : ${blocked}`);
  console.log(`  HTTP 오류(4xx/5xx): ${httpErr}`);
  console.log(`  접속 실패(failed): ${failed}`);
  console.log(`  URL 없음/무효   : ${noUrl.length}`);
  console.log(`  ─────────────────────────`);
  console.log(`  접속 가능 ${reachable}/${targets.length}곳 (전체 ${list.length}곳 중)`);

  const problems = report.filter((r) => r.status !== "ok");
  if (problems.length) {
    console.log(`\n--- 접속 안 된 ${problems.length}곳 ---`);
    for (const p of problems)
      console.log(`  [${p.status.padEnd(10)}] http=${String(p.http).padStart(3)} ${p.region || ""} ${p.name}  → ${p.tried}`);
  }
  if (noUrl.length) {
    console.log(`\n--- 홈페이지 URL 없음/무효 ${noUrl.length}곳 ---`);
    for (const p of noUrl) console.log(`  ${p.region || ""} ${p.name}  (homepage: ${p.homepage})`);
  }
  console.log(`\n리포트 저장: ${path.relative(path.join(__dirname, "..", ".."), path.join(OUTDIR, "_reachability-report.json"))}`);
}

main();
