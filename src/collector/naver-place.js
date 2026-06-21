// 네이버 플레이스로 호텔 공식 홈페이지 추출 (curl + Shifter, 렌더링 불필요 — __APOLLO_STATE__ 임베드).
// 1) pcmap list → 첫 place id   2) pcmap 상세 → homepages.repr.url(+isDeadUrl)
// Shifter 포트 로테이션으로 네이버 rate-limit 회피. 사용: node src/collector/naver-place.js <targets.json> [outName]
const { execFile } = require("child_process");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");

function loadEnv() { try { const t = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8"); for (const l of t.split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim(); } } catch {} }
loadEnv();
const HOST = process.env.SHIFTER_HOST || "astraeus.p.shifter.io";
const PORTS = (process.env.SHIFTER_PORT_LIST || "10565,10566,10567,10568,10569,10570,10571,10572,10573,10574").split(",").map((s) => Number(s.trim())).filter(Boolean);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SRC = process.argv[2] || "/tmp/naver-target.json";
const OUTNAME = process.argv[3] || "_naver-place-report.json";
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", "2026-06-21", "homepage");
const targets = JSON.parse(fs.readFileSync(SRC, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let IP = null;
const unesc = (s) => s.replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/");

// 네이버 요청 간 최소 간격(rate-limit 회피). ai-fnb-trend HUMAN_DELAY_SEC=10 동일.
const DELAY = 10000;
let lastReq = 0;
async function gate() { const wait = DELAY - (Date.now() - lastReq); if (wait > 0) await sleep(wait); lastReq = Date.now(); }

function curlGet(url, port) {
  return new Promise((res) => {
    execFile("curl", ["-4", "-s", "-m", "30", "-A", UA, "-H", "Referer: https://map.naver.com/", "-x", `http://${HOST}:${port}`, url],
      { maxBuffer: 32 * 1024 * 1024 }, (e, out) => res(out || ""));
  });
}
function alive(url) { return new Promise((res) => execFile("curl", ["-4", "-sIL", "-m", "15", "-A", UA, "-o", "/dev/null", "-w", "%{http_code}", url], (e, o) => res(Number((o || "").trim()) || 0))); }

async function lookup(name, port) {
  // 1) 리스트 → 첫 place id
  await gate();
  const list = await curlGet("https://pcmap.place.naver.com/place/list?query=" + encodeURIComponent(name) + "&display=20", port);
  if (/이용이 제한|과도한 접근/.test(list)) return { rateLimited: true };
  const idm = list.match(/"items":\[\{"__ref":"PlaceListBusinessesItem:(\d+)"/) || list.match(/PlaceListBusinessesItem:(\d+)/);
  const id = idm ? idm[1] : null;
  if (!id) return { id: null };
  // 2) 상세 → homepages.repr.url (+ isDeadUrl). 호텔은 accommodation, fallback place
  for (const seg of ["accommodation", "place"]) {
    await gate();
    const html = await curlGet(`https://pcmap.place.naver.com/${seg}/${id}/home`, port);
    if (/이용이 제한|과도한 접근/.test(html)) return { id, rateLimited: true };
    const block = (html.match(/"homepages":\{[\s\S]{0,600}?"repr":\{[\s\S]{0,400}?\}/) || [])[0];
    if (block) {
      const u = (block.match(/"url":"([^"]+)"/) || [])[1];
      const dead = /"isDeadUrl":true/.test(block);
      if (u) return { id, seg, homepage: unesc(u), naverDead: dead };
    }
    // 상세 자체가 비정상(다른 seg)면 다음 seg
    if (!/__APOLLO_STATE__/.test(html)) continue;
    // APOLLO는 있는데 homepages 블록 없음 = 홈페이지 미등록
    return { id, seg, homepage: null };
  }
  return { id, homepage: null };
}

async function main() {
  IP = (await dns.resolve4(HOST))[0];
  console.log(`[korea] 네이버 플레이스(curl + Shifter ${HOST}→${IP}, 렌더링 없음) — ${targets.length}곳\n`);
  const report = []; let i = 0, found = 0, verified = 0, diff = 0, portIdx = 0;
  for (const t of targets) {
    let r = null;
    for (let a = 0; a < 3; a++) {
      const port = PORTS[portIdx++ % PORTS.length];
      r = await lookup(t.name, port);   // gate()가 요청 간 10초 보장
      if (r && !r.rateLimited) break;
    }
    r = r || {};
    let hpAlive = null;
    if (r.homepage) { found++; const code = await alive(r.homepage); hpAlive = code >= 200 && code < 400; if (hpAlive) verified++; }
    const same = r.homepage && t.googleUrl && r.homepage.replace(/\/+$/, "") === String(t.googleUrl).replace(/\/+$/, "");
    if (r.homepage && !same) diff++;
    report.push({ hotelSno: t.hotelSno, name: t.name, region: t.region, reason: t.reason, googleUrl: t.googleUrl || null,
      naverPlaceId: r.id || null, naverHomepage: r.homepage || null, naverIsDeadUrl: r.naverDead ?? null, naverHpAlive: hpAlive, sameAsGoogle: !!same, rateLimited: !!r.rateLimited, err: r.err });
    console.log(`  ${++i}/${targets.length} ${t.name}\n      네이버: ${r.homepage || (r.rateLimited ? "(rate-limit)" : r.id ? "(홈페이지 미등록)" : "(검색 결과 없음)")}${r.homepage ? (hpAlive ? " ✅접속" : " ❌접속불가") + (r.naverDead ? " [네이버:죽음]" : "") + (same ? " (=구글)" : " (≠구글)") : ""}`);
  }
  fs.writeFileSync(path.join(OUTDIR, OUTNAME), JSON.stringify(report, null, 2));
  console.log(`\n=== 결과 ===`);
  console.log(`  네이버 홈페이지 확보: ${found}/${targets.length} | 접속검증 통과: ${verified} | 구글과 다른 URL: ${diff} | rate-limit: ${report.filter((x) => x.rateLimited).length}`);
  console.log(`  리포트: data/raw/korea/2026-06-21/homepage/${OUTNAME}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
