// 한국 호텔 — 공식 홈페이지 URL·기본데이터 확보 (flow.md 1단계)
// 1순위 구글 지도(HasData Maps: website + rating/reviews/coords/...), 2순위 구글 검색(SERP).
// 채택 URL은 HEAD로 최종 랜딩까지 해소. 자동 덮어쓰기 안 함 — 리포트만 생성.
// 사용: node src/collector/google-correct.js [list.json] [date]
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
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 공식 홈페이지가 아닌 도메인(OTA·블로그·위키·SNS·지도·랭킹)
const DENY = [
  "agoda.", "booking.com", "expedia.", "hotels.com", "trip.com", "traveloka.", "klook.",
  "yanolja.", "goodchoice.", "yeogi.", "hotelscombined.", "kayak.", "trivago.", "stayfolio.",
  "tripadvisor.", "interpark.", "hotelnow.", "naver.com", "blog.naver", "tistory.", "brunch.",
  "namu.wiki", "wikipedia.", "instagram.", "facebook.", "youtube.", "youtu.be", "twitter.", "x.com",
  "tiktok.", "threads.", "daum.net", "google.", "kakao.com", "pf.kakao",
  "hotelrating.or.kr", "visitkorea.or.kr", "linkedin.", "pinterest.", "djangji.", "ohpennews",
  "skyscanner.", "hotellook.", "trip.com", "rakuten", "hotel.com", "priceline.", "wego.", "makemytrip.",
  "kkday.", "ctrip.", "qunar.", "hotelopia.", "expedia.", "hotwire.", "orbitz.", "trivago",
  "myrealtrip.", "tourvis.", "onda.me", "trazy.", "hotelpass.", "ostrovok.", "hotels.cn",
];
// OTA 예약 딥링크 패턴(도메인 모르는 마켓플레이스도 거름)
function looksBooking(url) {
  return /[?&](check[_]?in|check[_]?out|checkin|checkout|roomcount|adultcount)/i.test(url) ||
    /\/(union|products?|booking|reserve|rooms?)\/\d/i.test(url);
}
function host(u) { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }
function isDenied(url) {
  const h = host(url);
  if (!h) return true;
  return DENY.some((d) => { const dom = d.replace(/\.$/, ""); return h === dom || h.endsWith("." + dom) || h.includes("." + dom + ".") || h.startsWith(dom + "."); });
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
const norm = (u) => (u || "").replace(/\/+$/, "").toLowerCase();

// 제네릭 브랜드 포털(지점 정보 없는 본사 일반 페이지) 판별 → 후순위.
const BRAND_PORTAL = ["all.accor.com", "accor.com", "minor.com", "marriott.com/default.mi"];
function isGeneric(rawUrl, landingUrl) {
  const u = (landingUrl || rawUrl || "");
  if (/lien_externe/i.test(rawUrl || "")) return true;
  const h = host(u);
  if (BRAND_PORTAL.some((b) => h === b || u.toLowerCase().includes(b))) return true;
  // 브랜드 포털류의 얕은 일반 경로(/a/en.html, /en.html, /default.mi 등)
  if (/\/(a\/)?(en|ko|default)\.(html|mi)$/i.test(u)) return true;
  return false;
}

// HEAD로 리다이렉트 따라가 최종 랜딩 URL 확정 (단축/브랜드 리다이렉트 교정).
function resolveLanding(url, { timeout = 20 } = {}) {
  return new Promise((resolve) => {
    execFile("curl", ["-4", "-sIL", "-m", String(timeout), "-A", UA, "-o", "/dev/null", "-w", "%{http_code} %{url_effective}", url],
      (err, stdout) => {
        const m = (stdout || "").match(/^(\d+)\s+(\S+)/);
        if (!m || Number(m[1]) === 0) return resolve(url);
        let f = m[2]; try { const u = new URL(f); if ((u.port === "443" && u.protocol === "https:") || (u.port === "80" && u.protocol === "http:")) { u.port = ""; f = u.href; } } catch {}
        resolve(f);
      });
  });
}

// 1순위: 구글 지도 — website + 기본데이터. ll(좌표)로 장소 바이어스(동명/타지점 오매칭 방지).
function mapsSearch(q, { ll = null, timeout = 45 } = {}) {
  return new Promise((resolve) => {
    let qs = `q=${encodeURIComponent(q)}&hl=ko&gl=kr`;
    if (ll) qs += `&ll=${encodeURIComponent(ll)}`;
    execFile("curl", ["-s", "-m", String(timeout), `https://api.hasdata.com/scrape/google-maps/search?${qs}`,
      "-H", `x-api-key: ${KEY}`, "-w", "\n__HTTP__%{http_code}"],
      { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        const out = stdout || ""; const m = out.match(/__HTTP__(\d+)\s*$/); const code = m ? Number(m[1]) : 0;
        let place = null;
        try {
          const o = JSON.parse(out.replace(/\n__HTTP__\d+\s*$/, ""));
          const pr = o.localResults || o.placeResults || o.places;   // ai-fnb-trend: localResults
          place = Array.isArray(pr) ? pr[0] : pr;
        } catch {}
        resolve({ code, place: place || null, err: err ? String(err).slice(0, 50) : null });
      });
  });
}

// 2순위: 구글 검색(SERP)
function serp(q, { timeout = 45 } = {}) {
  return new Promise((resolve) => {
    const qs = `q=${encodeURIComponent(q)}&gl=kr&hl=ko&num=10`;
    execFile("curl", ["-s", "-m", String(timeout), `https://api.hasdata.com/scrape/google-light/serp?${qs}`,
      "-H", `x-api-key: ${KEY}`, "-w", "\n__HTTP__%{http_code}"],
      { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        const out = stdout || ""; const m = out.match(/__HTTP__(\d+)\s*$/); const code = m ? Number(m[1]) : 0;
        let results = [];
        try { results = (JSON.parse(out.replace(/\n__HTTP__\d+\s*$/, "")).organicResults || []).map((r) => r.link || r.url).filter(Boolean); } catch {}
        resolve({ code, results });
      });
  });
}

async function main() {
  const list = JSON.parse(fs.readFileSync(SRC, "utf8"));
  fs.mkdirSync(OUTDIR, { recursive: true });
  console.log(`[korea] 구글 지도(우선)+검색(보조)로 공식 URL·데이터 확보 — ${list.length}곳\n`);

  const report = [];
  let done = 0, fromMaps = 0, fromSerp = 0, fromSeed = 0, notFound = 0, errCnt = 0, idx = 0;
  const CONC = 5;
  async function worker() {
    while (true) {
      const k = idx++;
      if (k >= list.length) break;
      const h = list[k];
      const q = `${h.name} ${h.region || ""}`.trim();
      const ll = (h.lat && h.lng) ? `@${h.lat},${h.lng},14z` : null;

      // 1) 구글 지도 (좌표 바이어스) — website + 기본데이터
      const mr = await mapsSearch(q, { ll });
      const place = mr.place || {};
      const mapsRaw = place.website && !isDenied(place.website) ? place.website : null;
      const seedRaw = existingUrl(h.homepage) ? existingUrl(h.homepage).href : null;

      // HEAD 랜딩 해소(지도/시드)
      const mapsLanding = mapsRaw ? await resolveLanding(mapsRaw) : null;
      const seedLanding = seedRaw ? await resolveLanding(seedRaw) : null;

      // 2) SERP — 지도 website 없음/제네릭이거나 시드 없을 때 보조
      let serpTop = [], serpRaw = null, serpLanding = null;
      if (!mapsRaw || isGeneric(mapsRaw, mapsLanding) || !seedRaw) {
        const sr = await serp(q);
        serpTop = sr.results.slice(0, 3);
        serpRaw = sr.results.find((u) => !isDenied(u) && !looksBooking(u)) || null;
        serpLanding = serpRaw ? await resolveLanding(serpRaw) : null;
        if (sr.code !== 200 && mr.code !== 200) errCnt++;
      }

      // 3) 후보 구성 → 제네릭 후순위 + 출처 우선순위(maps>seed>serp), 랜딩 기준 중복 제거
      const rawCands = [
        mapsRaw && { source: "maps", url: mapsRaw, landing: mapsLanding },
        seedRaw && { source: "seed", url: seedRaw, landing: seedLanding },
        serpRaw && { source: "serp", url: serpRaw, landing: serpLanding },
      ].filter(Boolean).map((c) => ({ ...c, generic: isGeneric(c.url, c.landing) }));
      const seen = new Set(); const candidates = [];
      const prio = { maps: 0, seed: 1, serp: 2 };
      for (const c of rawCands.sort((a, b) => (a.generic - b.generic) || (prio[a.source] - prio[b.source]))) {
        const k = norm(c.landing || c.url); if (seen.has(k)) continue; seen.add(k);
        candidates.push({ source: c.source, url: c.url, landing: c.landing, generic: c.generic });
      }
      const chosen = candidates[0] || null;
      const official = chosen ? (chosen.landing || chosen.url) : null;
      const source = chosen ? chosen.source : null;

      const exHost = existingHost(h.homepage);
      let verdict;
      if (!official) { verdict = "not_found"; notFound++; }
      else if (exHost && host(official) === exHost) verdict = "same";
      else verdict = "changed";
      if (source === "maps") fromMaps++; else if (source === "serp") fromSerp++; else if (source === "seed") fromSeed++;

      report.push({
        hotelSno: h.hotelSno, name: h.name, region: h.region,
        existing: h.homepage || null, existingHost: exHost,
        officialUrl: official, source, verdict,
        candidates,            // step2 접속 시 순서대로 시도(fallback)
        mapsWebsite: mapsRaw, serpTop,
        maps: place.title ? {
          title: place.title || null, rating: place.rating ?? null, reviews: place.reviews ?? null,
          coords: place.gpsCoordinates || null, address: place.address || null,
          kgmid: place.kgmid || null, phone: place.phone || null,
        } : null,
        mapsHttp: mr.code, err: mr.err,
      });
      process.stdout.write(`\r  진행 ${++done}/${list.length}  (maps ${fromMaps} / seed ${fromSeed} / serp ${fromSerp} / 못찾음 ${notFound})    `);
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  console.log("\n");

  report.sort((a, b) => a.hotelSno - b.hotelSno);
  fs.writeFileSync(path.join(OUTDIR, "_google-correct-report.json"),
    JSON.stringify({ date: DATE, total: list.length, fromMaps, fromSerp, notFound, errCnt, report }, null, 2));

  const withData = report.filter((r) => r.maps).length;
  console.log("=== 공식 URL·데이터 확보 결과 ===");
  console.log(`  URL 출처(1순위 후보): 지도(Maps) ${fromMaps} / 시드(seed) ${fromSeed} / 검색(SERP) ${fromSerp} / 못찾음 ${notFound}`);
  console.log(`  지도 기본데이터(평점·리뷰·좌표) 확보: ${withData}곳`);
  console.log(`  기존과 다른 URL(changed): ${report.filter((r) => r.verdict === "changed").length}`);
  console.log(`\n--- 공식 URL 못 찾음 ---`);
  for (const r of report.filter((r) => r.verdict === "not_found"))
    console.log(`  ${(r.region || "").padEnd(3)} ${r.name}`);
  console.log(`\n리포트: ${path.relative(path.join(__dirname, "..", ".."), path.join(OUTDIR, "_google-correct-report.json"))}`);
}

main();
