// 수집 저장 계층 — 파일 기반(날짜 파티션) + 현재상태 + 변동분(change-log)
// 국가/소스 공용. 한국 외 일본·베트남 등 수집기도 동일하게 사용한다.
//
// 레이아웃 (프로젝트 루트 data/):
//   raw/<country>/<date>/<name>.json   원본 API 응답 (감사/재처리용)
//   hotels/<country>/list/latest.json  현재 활성 상태 (배열, PK=hotelSno)
//   history/<country>/changes.jsonl    변동분만 append (한 줄 = 한 변경)
const fs = require("fs");
const path = require("path");

// src/collector/lib/storage.js → ../../../data (프로젝트 루트의 data/)
const ROOT = path.join(__dirname, "..", "..", "..", "data");

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function countryPaths(country) {
  return {
    latest: path.join(ROOT, "hotels", country, "list", "latest.json"),
    changes: path.join(ROOT, "history", country, "changes.jsonl"),
    raw: (date, name) => path.join(ROOT, "raw", country, date, name),
  };
}

// 원본 API 응답 그대로 저장 (재처리·감사용)
function saveRaw(country, date, name, payload) {
  const p = countryPaths(country).raw(date, name);
  ensureDir(p);
  fs.writeFileSync(p, typeof payload === "string" ? payload : JSON.stringify(payload));
  return p;
}

// 현재 상태 로드 → { [pk]: record }
function loadLatest(country, pk = "hotelSno") {
  const p = countryPaths(country).latest;
  if (!fs.existsSync(p)) return {};
  const arr = JSON.parse(fs.readFileSync(p, "utf8"));
  const map = {};
  for (const r of arr) map[r[pk]] = r;
  return map;
}

// 두 레코드의 추적 필드 비교 → [{field, old, new}]
function diffFields(prev, next, fields) {
  const changes = [];
  for (const f of fields) {
    const a = prev[f] ?? null;
    const b = next[f] ?? null;
    // 배열/객체는 JSON 문자열로 비교
    const av = typeof a === "object" ? JSON.stringify(a) : a;
    const bv = typeof b === "object" ? JSON.stringify(b) : b;
    if (av !== bv) changes.push({ field: f, old: a, new: b });
  }
  return changes;
}

// 수집 커밋: 신규/변경/비활성 판별 → latest 갱신 + changes append
//   country   : 'korea'
//   date      : 'YYYY-MM-DD'
//   records   : 정규화된 현재 수집 배열
//   pk        : 기본키 필드명 (기본 hotelSno)
//   track     : 변동 감지 대상 필드 목록
//   nameField : 변경로그에 함께 남길 표시용 이름 필드
function commit(country, { date, records, pk = "hotelSno", track, nameField = "name" }) {
  const ts = new Date().toISOString();
  const prevMap = loadLatest(country, pk);
  const seen = new Set();
  const changeLines = [];
  let nNew = 0, nUpd = 0, nInactive = 0;

  for (const rec of records) {
    const id = rec[pk];
    seen.add(String(id));
    const prev = prevMap[id];
    if (!prev) {
      nNew++;
      changeLines.push(JSON.stringify({ ts, date, country, [pk]: id, name: rec[nameField], type: "new" }));
    } else {
      const fieldChanges = diffFields(prev, rec, track);
      for (const c of fieldChanges) {
        nUpd++;
        changeLines.push(JSON.stringify({ ts, date, country, [pk]: id, name: rec[nameField], type: "update", ...c }));
      }
    }
  }

  // 이전엔 있었으나 이번 수집에 사라진 항목 → 비활성(만료/폐업 추정)
  for (const id of Object.keys(prevMap)) {
    if (!seen.has(String(id))) {
      nInactive++;
      changeLines.push(JSON.stringify({ ts, date, country, [pk]: Number(id) || id, name: prevMap[id][nameField], type: "inactive" }));
    }
  }

  // latest 갱신 (현재 활성 집합으로 교체)
  const latestPath = countryPaths(country).latest;
  ensureDir(latestPath);
  fs.writeFileSync(latestPath, JSON.stringify(records, null, 2));

  // changes append (변동이 있을 때만)
  if (changeLines.length) {
    const chPath = countryPaths(country).changes;
    ensureDir(chPath);
    fs.appendFileSync(chPath, changeLines.join("\n") + "\n");
  }

  return { new: nNew, updated: nUpd, inactive: nInactive, total: records.length, firstRun: Object.keys(prevMap).length === 0 };
}

// ── 상세 프로필 계층 (storage-design.md 참조) ───────────────────────────────
// 정적 프로필: hotels/<country>/profiles/<hotelSno>.json (호텔당 1파일)
// 동적 가격  : prices/<country>/<hotelSno>.jsonl (shortlist만 append)

function profilePaths(country) {
  return {
    dir: path.join(ROOT, "hotels", country, "profiles"),
    file: (sno) => path.join(ROOT, "hotels", country, "profiles", `${sno}.json`),
    index: path.join(ROOT, "hotels", country, "profiles.index.json"),
    price: (sno) => path.join(ROOT, "prices", country, `${sno}.jsonl`),
  };
}

function loadProfile(country, sno) {
  const p = profilePaths(country).file(sno);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

function saveProfile(country, profile) {
  const p = profilePaths(country).file(profile.hotelSno);
  ensureDir(p);
  fs.writeFileSync(p, JSON.stringify(profile, null, 2));
  return p;
}

// 가격 관측 1건 append (섹션 G)
function appendPrice(country, sno, observation) {
  const p = profilePaths(country).price(sno);
  ensureDir(p);
  fs.appendFileSync(p, JSON.stringify(observation) + "\n");
  return p;
}

// 모든 프로필을 훑어 경량 인덱스 재생성 (목록·정렬·검색용)
function rebuildIndex(country) {
  const pp = profilePaths(country);
  if (!fs.existsSync(pp.dir)) return { count: 0 };
  const rows = [];
  for (const f of fs.readdirSync(pp.dir)) {
    if (!f.endsWith(".json")) continue;
    const pr = JSON.parse(fs.readFileSync(path.join(pp.dir, f), "utf8"));
    rows.push({
      hotelSno: pr.hotelSno,
      name: pr.identity?.name ?? null,
      star: pr.identity?.star ?? null,
      area: pr.location?.area ?? null,
      lat: pr.location?.lat ?? null,
      lng: pr.location?.lng ?? null,
      overall: pr.reviews?.overall ?? null,
      review_count: pr.reviews?.count ?? null,
      facility_keys: (pr.facilities || []).filter((x) => x.exists).map((x) => x.facility),
      room_types: (pr.rooms || []).length,
      has_profile: true,
      updated_at: pr.updated_at ?? null,
    });
  }
  rows.sort((a, b) => a.hotelSno - b.hotelSno);
  ensureDir(pp.index);
  fs.writeFileSync(pp.index, JSON.stringify(rows, null, 2));
  return { count: rows.length, index: pp.index };
}

module.exports = {
  ROOT, countryPaths, saveRaw, loadLatest, diffFields, commit,
  profilePaths, loadProfile, saveProfile, appendPrice, rebuildIndex,
};
