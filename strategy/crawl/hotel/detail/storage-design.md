# 호텔 상세 데이터 저장 설계 (data/)

> basic.md 추출 스펙을 실제 `data/`에 어떻게 담을지 정의한다.
> 핵심 원칙은 basic.md 2.1 — **정적 프로필과 동적 가격을 분리**한다.

---

## 1. 설계 원칙 (basic.md → 저장 구조 매핑)

| basic.md 원칙 | 저장 구조에 반영한 방식 |
|---------------|------------------------|
| 2.1 정적/동적 분리 | `hotels/`(프로필) 와 `prices/`(가격 시계열)를 디렉터리부터 분리 |
| 2.2 필터/가중치/등급형 | 저장은 원자료(객체)만 담고, 필터/가중치 판정은 조회 시점에 사용자별로 계산 (저장값에 고정하지 않음) |
| 2.3 시설 = 구조화 객체 | `facilities[]` 를 boolean 아닌 `{exists, attributes, persona_signals}` 3겹 객체로 |
| 2.4 깔때기 / shortlist | 가격은 전체가 아닌 shortlist만 적재 → `prices/` 는 호텔별 파일이 "구독 시점부터" 생김 |
| A. 고유 ID 안정성 | PK = `hotelSno` (등급원천 안정 키). OTA 매칭키는 `identity.external_ids` 에 보존 |
| 7. 좌표 우선 | 좌표는 이미 확보. 거리·소요시간은 저장 시 좌표+지도API로 **계산해서** 채움 |

### 왜 호텔당 1파일인가 (모놀리식 배열 거부)
현재 `latest.json` 은 412곳에 421KB. 여기에 객실·시설·리뷰까지 붙이면 단일 파일이 수 MB로 비대해지고, **한 호텔만 재크롤링해도 전체 파일을 다시 써야** 하며 git diff가 무의미해진다. 따라서 상세 프로필은 **호텔당 1 JSON 파일**로 쪼갠다. 증분 갱신·단건 재수집·리뷰 친화 diff가 모두 깔끔해진다.

---

## 2. 디렉터리 레이아웃

```
data/
  hotels/<country>/
    list/latest.json             # [기존 유지] 섹션 A 식별·등급·좌표 — 등급원천(rating API) 베이스 레이어
    profiles/<hotelSno>.json      # [신규] 섹션 A~F 정적 프로필 (호텔당 1파일)
    profiles.index.json           # [신규] 경량 인덱스 — 목록/정렬/검색용 요약 (프로필 요약본)
  prices/<country>/
    <hotelSno>.jsonl              # [신규] 섹션 G 동적 가격 시계열 (호텔당 append, shortlist만)
  raw/<country>/<date>/
    <source>/<hotelSno>.html|json # [확장] 원본 스냅샷 — 재추출·감사용 (source: homepage/google/agoda…)
  history/<country>/changes.jsonl # [기존 유지] 프로필 변동분 append
```

- `latest.json` 은 **건드리지 않는다**. 등급원천에서 매일 갱신되는 식별·기본 레이어로 유지하고, 프로필은 `hotelSno` 로 이를 참조·확장하는 별도 레이어다.
- `profiles/` 는 멀티소스 병합 결과의 "현재 상태". 원본은 항상 `raw/` 에 스냅샷으로 남겨 재추출 가능하게 한다.

---

## 3. 프로필 스키마 (`profiles/<hotelSno>.json`)

basic.md 섹션 A~F 를 그대로 객체화한다. 미수집 필드는 `null`(스칼라)/`[]`(배열)로 두어 "조회했으나 없음"과 "아직 안 봄"을 추후 `sources` 로 구분한다.

```jsonc
{
  "hotelSno": 3,
  "schema_version": 1,
  "updated_at": "2026-06-20T00:00:00Z",

  // 어떤 소스를 언제 긁었는지 — 멀티소스 병합 추적·재크롤링 판단의 근거
  "sources": [
    { "source": "homepage",    "url": "http://www.hotelnd.com/", "fetched_at": "2026-06-20T00:00:00Z", "ok": true },
    { "source": "google_maps", "ref": "ChIJ…",                    "fetched_at": "2026-06-20T00:00:00Z", "ok": true }
  ],

  "identity": {                                   // A — 대부분 latest.json 승계
    "name": "뉴동해관광호텔",
    "name_eng": "NEWDONGHAE TOURIST HOTEL",
    "brand": null, "chain": null, "global_chain": null,
    "star": 3,
    "url": "http://www.hotelnd.com/",
    "external_ids": { "google": null, "agoda": null, "booking": null, "yanolja": null }
  },

  "location": {                                   // B — 좌표 기반 계산값 포함
    "lat": 37.5263354, "lng": 129.1031012,
    "address": "강원도 동해시 평릉길 1 천곡동",
    "area": "강원", "neighborhood": null,
    "nearest_station": { "name": null, "walk_min": null },
    "transport": [
      // 좌표+지도API로 계산: { type, name, distance_km, duration_min }
    ],
    "landmarks": [],                              // 주요 관광지/랜드마크까지 거리
    "business_district_km": null,
    "airport_shuttle": null,
    "parking": { "available": null, "fee": null }
  },

  "rooms": [                                       // C — 룸타입 배열, 침대는 확장 객체
    {
      "name": "스탠다드 더블",
      "area_m2": null,
      "beds": [ { "type": "double", "count": 1 } ],
      "standard_occupancy": 2,
      "max_occupancy": 3,
      "extra_bed": { "available": null, "fee": null, "max": null },
      "sofa_bed": null,
      "connecting_room": null,
      "kitchen": null,
      "desk": null, "wifi_speed": null
    }
  ],

  "facilities": [                                  // D — 3겹 구조화 객체 (boolean 금지)
    {
      "facility": "swimming_pool",
      "exists": true,
      "attributes": { "count": 1, "indoor_outdoor": "indoor", "has_kids_pool": false, "adults_only": false, "seasonal": false },
      "persona_signals": []
    }
    // breakfast, spa, fitness, kids_club, parking, pet, wheelchair, business_center …
  ],

  "reviews": {                                     // E — 가중치
    "overall": null, "count": null,
    "subscores": { "cleanliness": null, "location": null, "service": null, "value": null },
    "keywords": [],                                // 페르소나 매칭용 ("조용함","조식 훌륭"…)
    "by_source": []                                // [{ source, rating, count }] — OTA별 원점수 보존
  },

  "policies": {                                    // F
    "check_in": null, "check_out": null,
    "cancellation": null,                          // 환불 가능 여부 — 가격 전략에 직결
    "smoking": null, "pet": null
  },

  "media": {                                       // 대표 사진 (latest.json images 승계 + 추가)
    "images": []
  },

  "persona_scores": {                              // 5 — 파생값, 후처리(점수화) 단계에서 채움
    "business": null, "family": null, "couple": null, "backpacker": null, "luxury": null, "workation": null
  }
}
```

### 침대·시설 객체 규약
- `beds[].type`: `single | double | queen | king | twin | bunk | ondol(온돌)` 등 **정규화 enum**. 사이트 원문은 `raw/` 에 보존.
- `facilities[].facility`: 정규화 키(snake_case) enum. 같은 "수영장"도 `attributes` 로 키즈풀/성인전용/실내외를 구분해 페르소나 신호가 갈리게 한다(basic.md 2.3).
- **필터/가중치 태그는 저장하지 않는다.** 같은 항목이 사용자마다 필터일 수도 가중치일 수도 있으므로(basic.md 2.2·7), 판정은 조회 시점 사용자 설정으로 계산한다.

---

## 4. 인덱스 (`profiles.index.json`)

목록·정렬·검색에서 412개 파일을 매번 열지 않도록 한 줄 요약을 모은 배열.

```jsonc
[
  { "hotelSno": 3, "name": "뉴동해관광호텔", "star": 3, "area": "강원",
    "lat": 37.52, "lng": 129.10, "overall": null, "review_count": null,
    "facility_keys": ["parking"], "has_profile": true, "updated_at": "2026-06-20T..." }
]
```

프로필이 갱신될 때 해당 호텔 한 줄만 다시 써서 동기화한다.

---

## 5. 가격 시계열 (`prices/<country>/<hotelSno>.jsonl`)

basic.md 섹션 G·7. **가격은 항상 "조회 조건"과 묶고**, 세금·수수료 포함 총액으로 정규화한다. shortlist 호텔에만 생긴다(2.4·7 모니터링 범위 제한).

```jsonc
// 한 줄 = 한 시점·한 조건의 가격 관측
{ "ts": "2026-06-20T03:00:00Z", "hotelSno": 3, "source": "agoda",
  "room_type": "Standard Double", "check_in": "2026-07-01", "check_out": "2026-07-02",
  "occupancy": 2, "currency": "KRW",
  "price_display": 90000, "price_total": 99000,         // 표시가 vs 총액(세금·수수료·엑스트라베드 포함)
  "refundable": true, "promo": "회원가 10%", "rooms_left": 3 }
```

> "가장 좋은 가격"은 단순 최저가가 아니라 **환불 가능 여부 + 총액** 기준(basic.md 7). 알람은 `prices/<id>.jsonl` 에서 "지난 N일 중 현재가 최저인가?" 쿼리로 푼다.

---

## 6. 멀티소스 병합 규칙

한 호텔의 프로필은 여러 소스에서 조금씩 채워진다. 충돌 시 필드군별 우선순위:

| 필드군 | 1순위 | 2순위 | 비고 |
|--------|-------|-------|------|
| identity·star·좌표 | 등급원천(rating) | — | 가장 권위 있는 공식값 |
| 객실·시설·정책 | 호텔 공식 홈페이지 | OTA | 공식 설명 우선 |
| 리뷰·세부평점 | OTA/지도 | — | 홈페이지엔 거의 없음 |
| 거리·소요시간 | 좌표+지도API 계산 | — | 사이트 표기 의존 금지(basic.md 7) |

- 병합은 항상 `raw/` 스냅샷에서 재현 가능해야 한다(소스 누가 이겼는지 `sources[]` 로 추적).
- 같은 필드가 소스 간 다르면 1순위 채택, 단 `reviews.by_source[]` 처럼 **원점수는 소스별로 모두 보존**한다.

---

## 7. 코드 변경 범위 (구현 시)

- `src/collector/lib/storage.js` 에 프로필 계층 함수 추가: `loadProfile/saveProfile(country, hotelSno)`, `upsertIndex`, `appendPrice`.
- 신규 수집기 `src/collector/collect-korea-detail.js` — `latest.json` 을 읽어 호텔별로 소스 방문 → 추출 → `profiles/` 저장.
- 기존 `collect-korea.js`(목록·식별 레이어)는 그대로 둔다.

---

*이 문서는 basic.md(추출 스펙)의 구현측 짝이다. 스키마 버전이 오르면 `schema_version` 과 본 문서를 함께 갱신한다.*
