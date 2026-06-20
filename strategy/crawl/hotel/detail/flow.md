# 호텔 정보 추출 방법

> 접속 transport 상세는 [`transport.md`](./transport.md) 참고.

## 1. 구글 검색을 통해 홈페이지 URL 보정
  - 구글 검색(HasData SERP)에 호텔 이름을 조회, 실제 홈페이지 위치를 찾아냄
  - `data/hotels/korea/list/latest.json` 의 홈페이지와 다르면 실제 URL로 업데이트
  - OTA/블로그/위키/SNS는 제외(호스트 경계로 매칭), 첫 공식 도메인 채택
  - 채택 URL은 **HEAD(`curl -IL`)로 최종 랜딩까지 해소** — 단축/vanity URL(`marriott.com/selcy` → `/…/overview/`) 교정. GET이 403이어도 HEAD는 통과
  - 구글 URL은 보관했다가, 2단계에서 시드 URL 접속 실패 시 fallback으로 사용

## 2. 실제 홈페이지에 접속
  - 모든 접속은 **chromium 기반 실제 크롬처럼 동작 + 렌더링 필수 + SPA 하이드레이션 대기**(본문 텍스트가 채워질 때까지)
  - **redirect 자동 추적 필수**: HTTP 3xx + `<meta http-equiv="refresh">`(meta-refresh, 예: 안동그랜드 → `web/index.php`)
  - **frameset 대응**: 루트 본문이 thin(<250자)인데 `<frame>`이 있으면 모든 frame의 innerText를 합산(예: 동해현진 → `index.htm`)
  - 접속 순서:
    1. shifter로 접속 시도
    2. 실패시 HasData(`/scrape/web`, jsRendering)로 접속 시도 — 차단 간헐적이면 재시도
    3. 실패시 local 장비에서 접속 시도

## 3. 실제 홈페이지 내용 크롤링
  - 루트에서부터 시작해서 필요시 링크를 따라 정보 수집
  - **인트로/스플래시 페이지**(언어선택 등, 예: 온양제일 → `/main/main.asp`)는 본문 링크를 따라가 실제 메인으로 진입
