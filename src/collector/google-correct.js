// 한국 호텔 — 구글 검색(HasData SERP)으로 공식 홈페이지 URL 보정 (flow.md 1단계)
// 자동 덮어쓰기 안 함 — 보정 후보 리포트만 생성. 사용: node src/collector/google-correct.js [list.json] [date]
const { execFile } = require("child_process");
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
const KEY = process.env.HASDATA_API_KEY || "";
if (!KEY) { console.error("HASDATA_API_KEY 없음 (.env 확인)"); process.exit(1); }

const SRC = process.argv[2] || path.join(__dirname, "..", "..", "data", "hotels", "korea", "list", "latest.json");
const DATE = process.argv[3] || new Date().toISOString().slice(0, 10);
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", DATE, "homepage");

// 공식 홈페이지가 아닌 도메인(OTA·블로그·위키·SNS·지도·랭킹)
const DENY = [
  "agoda.", "booking.com", "expedia.", "hotels.com", "trip.com", "traveloka.", "klook.",
  "yanolja.", "goodchoice.", "yeogi.", "hotelscombined.", "kayak.", "trivago.", "stayfolio.",
  "tripadvisor.", "interpark.", "hotelnow.", "naver.com", "blog.naver", "tistory.", "brunch.",
  "namu.wiki", "wikipedia.", "instagram.", "facebook.", "youtube.", "youtu.be", "twitter.", "x.com",
  "tiktok.", "threads.", "daum.net", "google.", "youtube.com", "kakao.com", "pf.kakao",
  "hotelrating.or.kr", "visitkorea.or.kr", "linkedin.", "pinterest.", "djangji.", "ohpennews",
];
function host(u) { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }
// 호스트 경계로 매칭 — 부분문자열 오탐 방지(예: hotels.com ≠ lahanhotels.com)
function isDenied(url) {
  const h = host(url);
  if (!h) return true;
  return DENY.some((d) => {
    const dom = d.replace(/\.$/, "");
    return h === dom || h.endsWith("." + dom) || h.includes("." + dom + ".") || h.startsWith(dom + ".");
  });
}

function serp(q, { timeout = 45 } = {}) {
  return new Promise((resolve) => {
    const qs = `q=${encodeURIComponent(q)}&gl=kr&hl=ko&num=10`;
    execFile("curl", ["-s", "-m", String(timeout),
      `https://api.hasdata.com/scrape/google-light/serp?${qs}`,
      "-H", `x-api-key: ${KEY}`, "-w", "\n__HTTP__%{http_code}"],
      { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        const out = stdout || "";
        const m = out.match(/__HTTP__(\d+)\s*$/);
        const code = m ? Number(m[1]) : 0;
        const json = out.replace(/\n__HTTP__\d+\s*$/, "");
        let results = [];
        try { results = (JSON.parse(json).organicResults || []).map((r) => r.link || r.url).filter(Boolean); } catch {}
        resolve({ code, results, err: err ? String(err).slice(0, 50) : null });
      });
  });
}

// 기존 homepage → URL 객체(정규화). 깨진 경우 null.
function existingUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  const ms = [...s.matchAll(/https?:\/\//gi)];
  if (ms.length) s = s.slice(ms[ms.length - 1].index).split(/\s/)[0];
  else if (/^[^\s]+\.[^\s]+$/.test(s)) s = "http://" + s.split(/\s/)[0];
  else return null;
  try { return new URL(s); } catch { return null; }
}
function existingHost(raw) { const u = existingUrl(raw); return u ? u.hostname.replace(/^www\./, "").toLowerCase() : ""; }

// HEAD로 리다이렉트를 따라가 최종 랜딩 URL 확정 (단축/vanity URL 교정).
// GET이 Akamai 403이어도 HEAD는 통과하는 경우가 많음(marriott.com/selcy → /overview/).
function resolveLanding(url, { timeout = 20 } = {}) {
  return new Promise((resolve) => {
    execFile("curl", ["-4", "-sIL", "-m", String(timeout), "-A", UA,
      "-o", "/dev/null", "-w", "%{http_code} %{url_effective}", url],
      (err, stdout) => {
        const m = (stdout || "").match(/^(\d+)\s+(\S+)/);
        if (!m || Number(m[1]) === 0) return resolve(url); // 실패 시 원본 유지
        let f = m[2];
        try { const u = new URL(f); if ((u.port === "443" && u.protocol === "https:") || (u.port === "80" && u.protocol === "http:")) { u.port = ""; f = u.href; } } catch {}
        resolve(f);
      });
  });
}

async function main() {
  const list = JSON.parse(fs.readFileSync(SRC, "utf8"));
  fs.mkdirSync(OUTDIR, { recursive: true });
  console.log(`[korea] 구글(HasData SERP)로 공식 홈페이지 URL 보정 — ${list.length}곳\n`);

  const report = [];
  let done = 0, changed = 0, same = 0, notFound = 0, errCnt = 0, idx = 0;
  const CONC = 6;
  async function worker() {
    while (true) {
      const k = idx++;
      if (k >= list.length) break;
      const h = list[k];
      const q = `${h.name} ${h.region || ""} 호텔`.trim();
      const r = await serp(q);
      const official = r.results.find((u) => !isDenied(u)) || null;
      const exHost = existingHost(h.homepage);
      const newHost = official ? host(official) : "";
      let verdict;
      if (r.code !== 200) { verdict = "serp_error"; errCnt++; }
      else if (!official) { verdict = "not_found"; notFound++; }
      else if (exHost && newHost && exHost === newHost) { verdict = "same"; same++; }
      else { verdict = "changed"; changed++; }
      // 채택 URL(보정이면 구글, 아니면 기존)을 HEAD로 최종 랜딩까지 해소 — 단축/vanity URL 교정
      const chosen = verdict === "changed" ? official : (existingUrl(h.homepage) ? existingUrl(h.homepage).href : official);
      const landingUrl = chosen ? await resolveLanding(chosen) : null;
      report.push({ hotelSno: h.hotelSno, name: h.name, region: h.region,
        existing: h.homepage || null, existingHost: exHost,
        googleUrl: official, googleHost: newHost, landingUrl,
        verdict, serpTop: r.results.slice(0, 3), http: r.code, err: r.err });
      process.stdout.write(`\r  진행 ${++done}/${list.length}  (changed ${changed} / same ${same} / not_found ${notFound} / err ${errCnt})    `);
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  console.log("\n");

  report.sort((a, b) => a.hotelSno - b.hotelSno);
  fs.writeFileSync(path.join(OUTDIR, "_google-correct-report.json"),
    JSON.stringify({ date: DATE, total: list.length, changed, same, notFound, errCnt, report }, null, 2));

  console.log("=== 구글 URL 보정 결과 ===");
  console.log(`  보정 후보(changed): ${changed}`);
  console.log(`  기존과 동일(same) : ${same}`);
  console.log(`  공식 못찾음(not_found): ${notFound}`);
  console.log(`  SERP 오류         : ${errCnt}`);
  console.log(`\n--- 보정 후보 (기존 → 구글) ---`);
  for (const r of report.filter((x) => x.verdict === "changed"))
    console.log(`  ${(r.region || "").padEnd(3)} ${r.name}\n      기존: ${r.existing}\n      구글: ${r.googleUrl}`);
  console.log(`\n--- 공식 못찾음 ---`);
  for (const r of report.filter((x) => x.verdict === "not_found"))
    console.log(`  ${(r.region || "").padEnd(3)} ${r.name}  (top: ${r.serpTop[0] || "-"})`);
  console.log(`\n리포트: ${path.relative(path.join(__dirname, "..", ".."), path.join(OUTDIR, "_google-correct-report.json"))}`);
}

main();
