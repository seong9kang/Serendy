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

## 접속 실패 복구 파이프라인 (실증, 2026-06-20 전수 412곳)

접속률을 단계적으로 끌어올린 검증된 순서. **최종 400/412 (97%)** — 모든 기법 총동원(`verify-final.js`). 방법별: shifter-curl 334 / local-curl 23 / HasData 31 / shifter-playwright 8 / local-playwright 4.

1. **구글 URL 보정** (`google-correct.js`): HasData SERP로 공식 URL 확정. `latest.json`의 URL이 깨졌거나 OTA여도 교정. ⚠️ OTA/블로그/위키 제외는 **호스트 경계로 매칭**(부분문자열 금지 — `hotels.com`이 `lahanhotels.com`을 오탐).
2. **HEAD 랜딩 해소** (`resolveLanding`): 채택 URL을 `curl -IL`로 리다이렉트 끝까지 따라가 정식 랜딩 확정. 단축/vanity URL(`marriott.com/selcy` → `/…/overview/`) 교정. **GET이 Akamai 403이어도 HEAD는 통과**하는 점 이용.
3. **URL 정제 + 루트 폴백** (`rescue-homepage.js`): zero-width 제거, 중복 스킴은 마지막 URL, 콤마 교정, 한글도메인 **punycode 변환**(`new URL()`이 자동). 깊은 경로가 404면 **`scheme+host` 루트로 폴백**(`…/sb/yy/` 404 → 도메인 루트 200).
4. **구글 URL fallback** (`finalize-homepage.js`/`verify-final.js`): 시드 URL이 접속 실패하면 보관해둔 **구글 SERP URL로 재시도**(같은 호스트라도 경로가 깨진 경우 — 라한 목포 `/mokpo`(404) → 구글 `/mokpo/ko/main.do`). ※"경로 깊은 게 더 정식" 휴리스틱은 안 씀 — 구글 1순위가 객실/패키지/모바일(/m/) 서브페이지인 경우가 많아 루트를 망침(60곳 검증).
5. **Playwright stealth**: JS 봇월(Distil/Cloudflare 챌린지) 사이트는 실브라우저가 챌린지를 실행해 통과(시그니엘 사례).
6. **HasData `/scrape/web` (jsRendering=true)**: 글로벌 체인 Akamai 안티봇 우회.

### ⚠️ 핵심 발견 — 데이터센터 IP는 Akamai에 막힌다
- **Shifter·Playwright 둘 다 Shifter 프록시(DigitalOcean 데이터센터 IP)로 나가므로** Marriott·Hyatt·IHG·Four Seasons의 Akamai가 **IP 평판으로 403** 처리. UA·stealth 무관하게 막힘(구글 CAPTCHA와 같은 원리).
- **HasData `/scrape/web`(jsRendering=true)는 통과** — 포시즌스 268KB, 보코 1.1MB, 씨마크 80KB 실제 HTML 수신. 응답 구조: `requestMetadata.status==="ok"` + `content`(HTML).
- 즉 **글로벌 체인 = Shifter/Playwright가 아니라 HasData 경로.**
- ⚠️ 로컬도 안 통한다: 로컬(한국 IP) curl·headless·**headed 실제 Chrome 모두 403**. 데이터센터 IP만의 문제가 아니라 Akamai가 자동화 신호+IP를 함께 차단 → HasData가 유일.
- **Marriott = HasData 재시도로 회수됨**: 차단은 간헐적(~500자 Access Denied)이라 `content>1500 && !blocked` 기준으로 **최대 6회 재시도**하면 통과(메리어트 전부 회수). 단축 vanity URL은 HEAD로 정식 `/overview/` 확정 후 시도.
- **Hyatt = HasData로도 미해결**: `hyatt.com` 은 jsRendering=true로도 **856자 빈 SPA 셸(가시 텍스트 0자)** 만 반환 → 공식 홈페이지 접속 불가. ⚠️ 판정 시 `content>1500` 같은 길이 기준 필수(>500만 쓰면 빈 셸을 오탐). 하얏트 데이터는 HasData Maps로 우회.

### Hyatt = Kasada → CDP로 해결
- Hyatt은 Akamai 아니라 **Kasada** 안티봇(KPSDK 챌린지 / 403 "We're sorry… **ERROR:E6020**"). shifter·HasData·local·Playwright(chromium/firefox)·residential·wait·reload 전부 실패.
- **해결: 사용자 실제 Chrome에 CDP 연결**(`chrome-cdp-fetch.js`) — 사람이 한 번 통과시킨 세션·쿠키 재사용. 하얏트 6곳 전부 수집 성공(1만~1.6만자). 접속 순서 4순위.

### 그래도 안 되는 유형 (접속 기법 문제 아님)
- 폐업/도메인 파킹(내용 150~200자 빈 페이지) → 구글 재검색
- 공식 홈페이지 부재(OTA만 존재) → HasData Maps로만 데이터

## 관련 파일

- `src/collector/fetch-detail.js` — Shifter+curl 홈페이지 HTML 수집
- `src/collector/render-detail.js` — Playwright stealth 렌더링
- `src/collector/check-homepage.js` — 홈페이지 루트 접속 점검(shifter→HasData→local, 파싱 없음)
- `src/collector/google-correct.js` — HasData SERP로 공식 URL 보정 + HEAD 랜딩 해소
- `src/collector/rescue-homepage.js` — 실패분 재시도(①정제 ②루트폴백 ③Playwright)
- `src/collector/hasdata-rescue.js` — 글로벌 체인 HasData web(JS렌더) 재시도
- `src/collector/resolve-and-verify.js` — HEAD 랜딩 해소 후 변경분 재검증
- `src/collector/finalize-homepage.js` / `verify-final.js` — 최종 통합 점검(전 기법 + 구글 fallback)

## 결과 산출물 (`/data/` 는 gitignore — 코드/문서만 커밋됨)

확정 파일: `data/raw/korea/2026-06-20-corrected/homepage/`
- **`_official-sites.json` / `.csv`** ← **최종 공식 사이트 확정**(412곳: hotelSno·이름·지역·official_url·connected·method)
- `_final-reachability.json` — 전수 접속 상세
- `_failed-urls.json` — 미접속 분류
- `_google-correct-report.json`(상위 `2026-06-20/` 디렉토리) — 구글 보정 원본
