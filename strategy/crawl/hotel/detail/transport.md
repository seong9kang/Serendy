# 수집 Transport 전략 (접속 방식)

> 호텔 상세 수집에서 "어디에 어떻게 접속하느냐"의 검증된 규칙.
> 흐름(flow)은 [`flow.md`](./flow.md), 저장 구조는 [`storage-design.md`](./storage-design.md) 참고.

## 핵심 원칙 — 대상별로 접속 수단이 다르다

| 대상 | 접속 수단 | 이유 |
|------|-----------|------|
| **공식 홈페이지** (객실·시설·정책) | **Shifter 프록시 + Playwright stealth**, 실패 시 HasData → local | JS 렌더링 많음, 안티봇 우회 필요 |
| **구글 검색 / 지도 / 리뷰** | **HasData 전용 Google API** (직접 스크래핑 금지) | Shifter로 접속 시 CAPTCHA 차단 (IP 평판) |

## 1. 공식 홈페이지 접속 — 3단계 폴백

`shifter → HasData → local` 순서로 시도 (flow.md).

### Shifter 프록시 (1순위)
- **반드시 IPv4로 접속.** 호스트(`astraeus.p.shifter.io`)를 그대로 주면 Chromium이 IPv6로 나가 **403(ACL 밖 IP)**.
  - curl: `-4` 플래그 / Playwright: `dns.resolve4`로 게이트웨이를 IPv4 resolve.
- **출구 IP 로테이션은 포트로** (`10565~10574`). 재시도 시 포트 순환.
- Shifter **Authorized IPs**에 현재 egress IP가 등록돼 있어야 함.
- JS 렌더링 사이트가 많아 **Playwright 헤드리스(실제 chrome 채널) + stealth** 필수 (`src/collector/render-detail.js`).
  - 랜딩만 렌더하면 객실·정책이 비어있음 → **서브페이지 링크 따라가기 크롤이 별도 과제.**

### 안티봇 사이트
- **Distil (롯데/시그니엘)**: stealth + 워밍업으로 뚫림. 핑거프린트 기반이라 stealth가 유효.
- **구글**: IP **평판** 기반 차단이라 stealth 무의미 → 반드시 HasData 사용.

### HasData Web Scrape (2순위)
- `POST https://api.hasdata.com/scrape/web` (JS 렌더링 옵션).
- ⚠️ `proxyCountry` enum에 **KR 없음** (JP/SG 등만) → **한국 전용 사이트(예: higwangju.com)는 HasData로도 실패** 가능.

### local (3순위)
- 로컬 장비에서 직접 접속. 한국 전용 사이트엔 가장 확실하지만 안티봇/지오블록엔 약함.

## 2. 구글 검색·지도·리뷰 — HasData 전용 엔드포인트

직접 스크래핑 금지. Shifter+stealth로 `google.com/search` 4회 시도 → 전부 CAPTCHA(IP 평판).
인증: `x-api-key` 헤더, 요청당 약 5 credits. 환경변수 `HASDATA_API_KEY`.
레퍼런스 구현: 사내 `/Users/seong9kang/Projects/ai-fnb-trend`의 `pipeline/collectors/hasdata_maps_client.py`.

| 용도 | 엔드포인트 | 비고 |
|------|-----------|------|
| SERP Light | `GET /scrape/google-light/serp?q=&gl=kr&hl=ko&num=10` | `organicResults[]` — 공식 URL·OTA 링크 탐색 |
| SERP Full | `GET /scrape/google` | |
| Maps Search | `GET /scrape/google-maps/search?q=&hl=ko&gl=kr` | `placeResults{title,rating,reviews,userReviews,website,gpsCoordinates,kgmid,address,images}` — 안티봇 사이트(롯데/시그니엘)도 평점·리뷰 확보 |
| Place Menu | `GET /scrape/google-maps/place-menu?kgmid=` | |
| Web Scrape | `POST /scrape/web` | JS 렌더링. proxyCountry에 KR 없음 |

(베이스 URL: `https://api.hasdata.com`)

## 3. 하이브리드 전략 (확정)

- **Shifter + 헤드리스(stealth)** = 공식 홈페이지 **깊이** (객실/시설/정책)
- **HasData Google API** = **리뷰·평점·좌표·공식 URL 탐색** (안티봇 사이트도 OK)

## 환경변수 (`.env`)

```
SHIFTER_HOST=astraeus.p.shifter.io
SHIFTER_PORT_LIST=10565, 10566, ... , 10574
HASDATA_API_KEY=<key>
```

## 관련 파일

- `src/collector/fetch-detail.js` — Shifter+curl 홈페이지 HTML 수집
- `src/collector/render-detail.js` — Playwright stealth 렌더링
- `src/collector/check-homepage.js` — 홈페이지 루트 접속 가능 여부 점검(파싱 없음)
