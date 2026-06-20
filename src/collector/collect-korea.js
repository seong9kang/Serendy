// 한국 호텔 수집 (hotelrating.or.kr 공개 API) — Shifter 로테이팅 프록시 경유
// 정책: strategy/crawl/korea.md / 저장: 프로젝트 루트 data/
// 저장: 원본(raw) 보관 + latest.json 비교 → 변경분만 changes.jsonl
// 사용: node src/collector/collect-korea.js
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const storage = require("./lib/storage");
const { extractBrand } = require("./lib/brand");

const COUNTRY = "korea";
const HOST = "astraeus.p.shifter.io";
const PORTS = [10565, 10566, 10567, 10568, 10569, 10570, 10571, 10572, 10573, 10574];
const UA = "Mozilla/5.0";
const BASE = "https://www.hotelrating.or.kr/api";
const IMG = (sno) => `${BASE}/image/${sno}`;
const MIN_GRADE = 3;
const CODES = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "codes.json"), "utf8"));

// 수집 시점 날짜 (YYYY-MM-DD) — 인자로 주입 가능
const DATE = process.argv[2] || new Date().toISOString().slice(0, 10);

// 변동 감지 대상 필드 (가격이 붙으면 여기에 추가)
const TRACK = ["name", "nameEng", "grade", "gradeStatus", "gradeEndDate", "roomCount", "homepage", "tel", "address"];

function curlJSON(url, port, retry = 1) {
  return new Promise((resolve) => {
    execFile("curl", ["-s", "-m", "30", "-A", UA, "-x", `http://${HOST}:${port}`, url],
      { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (!err && stdout) { try { return resolve(JSON.parse(stdout)); } catch (_) {} }
        if (retry > 0) {
          const next = PORTS[(PORTS.indexOf(port) + 1) % PORTS.length];
          return resolve(curlJSON(url, next, retry - 1));
        }
        resolve(null);
      });
  });
}

function normalize(item, detail) {
  const d = detail || {};
  const addr = [d.hotelAddress1, d.hotelAddress2].filter(Boolean).join(" ");
  const statusCode = String(d.lastGradeStatus ?? item.decisionGradeStatus ?? "");
  const { brand, chain, globalChain } = extractBrand(item.hotelName, d.hotelNameEnglish);
  return {
    hotelSno: item.hotelSno,
    applySno: item.applySno,
    name: item.hotelName,
    nameEng: d.hotelNameEnglish || null,
    brand,
    chain,
    globalChain,
    grade: item.decisionGrade,
    gradeStatus: statusCode || null,
    gradeStatusText: CODES.status[statusCode] || null,
    gradeBeginDate: d.lastGradeBeginDate || null,
    gradeEndDate: d.lastGradeEndDate || null,
    typeCode: item.hotelTypeCode || null,
    typeText: CODES.hotelType[item.hotelTypeCode] || null,
    roomCount: item.hotelRoomCount ?? null,
    homepage: item.hotelHomepage || null,
    tel: d.mainTelno || null,
    address: addr || null,
    lat: d.hotelCoordinateY != null ? Number(d.hotelCoordinateY) : null,
    lng: d.hotelCoordinateX != null ? Number(d.hotelCoordinateX) : null,
    areaCode: item.hotelAreaCode || null,
    region: CODES.region[item.hotelAreaCode] || null,
    images: (d.imageList || []).map((im) => IMG(im.fileSno)),
  };
}

async function main() {
  console.log(`[${COUNTRY}] 수집 시작 (date=${DATE})`);

  // 1) 목록 수집 → 원본 보관
  const listResp = await curlJSON(`${BASE}/hotel?page=0&size=1000`, PORTS[0]);
  if (!listResp?.data?.hotelList) { console.error("목록 수집 실패"); process.exit(1); }
  storage.saveRaw(COUNTRY, DATE, "list.json", listResp);
  const all = listResp.data.hotelList.content;
  const filtered = all.filter((h) => h.decisionGrade >= MIN_GRADE);
  // 소스 목록이 동일 호텔을 중복 반환하는 경우가 있어 hotelSno 기준 중복 제거
  // (재심사로 applySno가 여럿이면 가장 최근 신청건 유지)
  const byId = new Map();
  for (const h of filtered) {
    const ex = byId.get(h.hotelSno);
    if (!ex || h.applySno > ex.applySno) byId.set(h.hotelSno, h);
  }
  const targets = [...byId.values()];
  const dups = filtered.length - targets.length;
  console.log(`  목록 ${all.length}곳 → 3성급 이상 ${filtered.length}곳${dups ? ` (중복 ${dups}건 제거 → ${targets.length}곳)` : ""}`);

  // 2) 상세 병렬 수집 (포트 로테이션)
  const records = new Array(targets.length);
  let done = 0, fail = 0, idx = 0;
  async function worker(n) {
    const port = PORTS[n % PORTS.length];
    while (true) {
      const i = idx++;
      if (i >= targets.length) break;
      const item = targets[i];
      const det = await curlJSON(`${BASE}/hotel/${item.hotelSno}?applySno=${item.applySno}`, port);
      if (!det?.data) fail++;
      records[i] = normalize(item, det && det.data);
      if (++done % 50 === 0 || done === targets.length)
        process.stdout.write(`\r  상세 ${done}/${targets.length} (실패 ${fail})   `);
    }
  }
  await Promise.all(PORTS.map((_, n) => worker(n)));
  console.log("");
  storage.saveRaw(COUNTRY, DATE, "hotels-collected.json", JSON.stringify(records, null, 2));

  // 3) 기존 latest 와 비교 → 변경분만 저장
  const r = storage.commit(COUNTRY, { date: DATE, records, track: TRACK });

  console.log(`[${COUNTRY}] 완료 — 총 ${r.total}곳`);
  if (r.firstRun) console.log(`  최초 수집: 전체 ${r.new}곳을 신규 등록`);
  else console.log(`  변경분: 신규 ${r.new} / 변경 ${r.updated} / 비활성 ${r.inactive}`);
  console.log(`  상세 실패 ${fail}곳`);
  console.log(`  저장: data/hotels/${COUNTRY}/list/latest.json · data/history/${COUNTRY}/changes.jsonl · data/raw/${COUNTRY}/${DATE}/`);
}

main();
