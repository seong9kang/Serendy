# 호텔 정보 추출 방법

> 접속 transport 상세는 [`transport.md`](./transport.md) 참고.

## 1. 구글 지도(우선) + 검색(보조)로 공식 URL·기본데이터 확보
  - **1순위 구글 지도**(HasData Maps search, `localResults[0]`): `website` = 호텔이 직접 등록한 공식 URL.
    rating·reviews·gpsCoordinates·address·kgmid·images 를 **동시에** 확보(1석2조). 안티봇 사이트(하얏트 등)도 데이터는 나옴
    - `latest.json` 의 lat/lng로 **`ll=@위도,경도,14z` 좌표 바이어스** → 동명/타지점 오매칭 방지
  - **2순위 구글 검색**(HasData SERP): Maps에 website가 없거나 장소매칭이 애매하면 fallback.
    `organicResults` 에서 OTA/블로그/위키/SNS 제외(호스트 경계로 매칭) 후 첫 공식 도메인
  - 채택 URL은 **HEAD(`curl -IL`)로 최종 랜딩까지 해소** — Maps website가 브랜드 리다이렉트(예: `all.accor.com`)거나 단축/vanity URL(`marriott.com/selcy`)이어도 정식 URL로 교정. GET이 403이어도 HEAD는 통과
  - **시드(기존) URL ≠ 지도 URL 일 때 단일 채택 금지** — 후보(시드/지도/SERP)를 모두 보관하고 **2단계 접속 검증으로 결정**:
    - 실제 본문이 렌더되는 URL을 채택
    - **property-specific URL 우선**(지점명·호텔코드 포함 경로, 예 `ambatel.com/novotel/suwon`, `hyatt.com/.../selph-...`)
    - **제네릭 브랜드 리다이렉트 후순위**(예 `all.accor.com/a/en.html`, `lien_externe`, 도메인 루트만 — 지점 정보 없음)
    - 채택 안 된 후보는 fallback으로 보관해 접속 실패 시 차례로 시도

## 2. 실제 홈페이지에 접속
  - 모든 접속은 **chromium 기반 실제 크롬처럼 동작 + 렌더링 필수 + SPA 하이드레이션 대기**(본문 텍스트가 채워질 때까지)
  - **redirect 자동 추적 필수**: HTTP 3xx + `<meta http-equiv="refresh">`(meta-refresh, 예: 안동그랜드 → `web/index.php`)
  - **frameset 대응**: 루트 본문이 thin(<250자)인데 `<frame>`이 있으면 모든 frame의 innerText를 합산(예: 동해현진 → `index.htm`)
  - 1단계에서 만든 **후보 리스트(property-specific 우선, 제네릭 후순위)를 순서대로** 접속 시도, 실제 렌더되는 것을 채택
  - 각 URL의 접속 순서:
    1. shifter로 접속 시도
    2. 실패시 HasData(`/scrape/web`, jsRendering)로 접속 시도 — 차단 간헐적이면 재시도
    3. 실패시 local 장비에서 접속 시도

## 3. 실제 홈페이지 내용 크롤링
  - 루트에서부터 시작해서 필요시 링크를 따라 정보 수집
  - **인트로/스플래시 페이지**(언어선택 등, 예: 온양제일 → `/main/main.asp`)는 본문 링크를 따라가 실제 메인으로 진입
