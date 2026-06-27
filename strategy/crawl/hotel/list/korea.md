# 수집 정책

## 수집 호텔 
- 3성급 이상의 호텔
- 아래 사이트에서 확인 가능
  - https://www.hotelrating.or.kr/hotel 

## ⚠️ 소스 2종 — 본토 16개 시도 + 제주(별도)
한국관광공사 등급제(hotelrating.or.kr)는 **제주를 포함하지 않는다.** 제주는 **제주특별자치도관광협회**가 별도 등급 결정 → 엑셀로만 제공.

1. **본토 16개 시도** (서울~경남, SIDO0001~0016): API `GET https://www.hotelrating.or.kr/api/hotel?page=0&size=1000` → `data.hotelList.content` (전국 853곳, 제주 0). 3성↑ 412곳. (`collect-korea.js`)
   - ⚠️ API의 `areaCode`/`searchKeyword` 파라미터는 **무시됨**(필터 안 됨). 제주를 이 API로는 못 받음.
2. **제주** (SIDO0017): 엑셀 다운로드
   - URL: `https://www.hotelrating.or.kr/api/static/exceldownload/제주특별자치도관광협회_호텔업등급결정현황.xlsx`
   - 시트: `전체`/`5성`/`4성`/`3성`/`2성`/`1성`. `전체` 시트 헤더: NO·등급인정처·호텔업구분·결정등급(`5성`)·등급유효기간·지역·호텔명·객실수·주소·전화번호
   - 파싱: openpyxl, `전체` 시트, 3성↑ **78곳**(5성20/4성18/3성40). hotelSno = `900000+NO`(본토와 충돌 방지)
   - ⚠️ 엑셀엔 **좌표·홈페이지 없음** → `google-correct.js`(구글 지도)로 좌표·공식URL·평점 보완
   - 저장: `data/hotels/korea/list/jeju.json`, 원본 `data/raw/korea/jeju/jeju-hotels.xlsx`

→ **한국 전체 = 412(본토) + 78(제주) = 490곳**

## 수집 주기
- 새벽에 하루 한 번 수집
- 수집 범위
  - 호텔 이름 (한글/영문 모두) 
  - 등급, 방 수 등등
  - 호텔 이미지
  - 주소와 위치 
  - 홈페이지 