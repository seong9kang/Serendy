# 호텔 데이터/예약 API 비교

> Serendy MVP에서 **가격·재고 데이터 수집**과 **어필리에이트 수익**을 어느 API로 시작할지 결정하기 위한 비교 정리.
> (조사 기준: 2026-06. 커미션율·요율은 협상/실적에 따라 달라지므로 실제 계약 시 재확인 필요)

---

## 한눈에 보기

| API | 비용 모델 | 비용 | 커미션 | 승인 난이도 | 강점 | 데이터 수집 적합성 |
|---|---|---|---|---|---|---|
| **Booking.com Demand API** | 커미션 | API 무료 | 예약당 수수료 | **높음** (Managed 파트너 승인) | 글로벌 최대 재고, 유럽 압도적 | ◎ (승인 후) |
| **Agoda Connect API** | 커미션 | API 무료 | 약 3~12% (평균 5% 내외) | 중간 | **아시아·APAC 최강** | ◎ (승인 후) |
| **Expedia Rapid (EPS)** | 커미션 / 네트요율 | API 무료 | 약 15~25% (Expedia Collect) | **높음** (개별 협상, 공개가 없음) | 북미 강세, 패키지 | ◎ (승인 후) |
| **Amadeus Self-Service** | **호출당 과금** | 무료 쿼터 후 호출당 €0.0008~0.025 | 없음(데이터만) | **낮음** (즉시 가입·키 발급) | 즉시 시작, 항공 포함 | ○ (예약 전환 X) |

---

## 1. Booking.com — Demand API

- **API 사용료: 무료.** 구독료·호출당 과금 없음. 커미션 기반 모델.
- **제휴 가입: 무료** (선입금·초기비용 없음).
- **수익: 예약 발생 시 커미션.**
- **접근 조건 (관문은 돈이 아니라 "승인"):**
  1. Booking.com **Managed Affiliate Partner** 등록 (Partner Centre 접근)
  2. Partner Centre에서 **API key + X-Affiliate-Id** 발급
  3. 모든 요청에 두 값 인증 전달
- **현실 경로:** Managed 파트너 승인은 트래픽/예약 실적 또는 사업 검토를 요구하는 경우가 많음 → 초기엔 일반 어필리에이트(링크/위젯)로 시작 후 실적 쌓고 Demand API 승인.
- **주의:** 가격 표시·캐싱·장기 저장에 대한 **이용약관 제약** 확인 필요 (가격 시계열 저장 용도).

## 2. Agoda — Connect / Affiliate API

- **API 사용료: 무료.** 커미션 기반.
- **커미션: 약 3~12%** (숙소 유형·지역에 따라 변동, 평균 5% 내외 사례 다수).
- **접근 조건:** 어필리에이트 프로그램 가입 승인 → 대시보드/레퍼럴 링크. API 직접 접근은 **월 거래량·콘텐츠·기술지원 수준에 따라 개별 견적**.
- **강점: 아시아·APAC 재고가 가장 강함** → Serendy의 한국인 아웃바운드(동남아 중심) 타깃과 정확히 일치.

## 3. Expedia — Rapid API (EPS)

- **API 사용료: 무료.** 두 가지 상거래 모델:
  - **Expedia Collect:** 사후 정산, 파트너가 예약가의 **약 15~25%** 수취
  - **Partner Collect:** 네트요율 결제 + 마크업 차익 수취
- **모든 요율은 EPS와 개별 협상** — **공개 가격표 없음.**
- **승인 난이도 높음.** 북미·패키지에 강점.

## 4. Amadeus — Self-Service API

- **유일하게 "호출당 과금" 모델** (예약 커미션 아님, 순수 데이터).
- **무료 쿼터:** API별 월 200~10,000 호출 무료.
- **초과 시:** 호출당 약 **€0.0008 ~ €0.025** (~$0.024).
- **승인 난이도 낮음:** 즉시 가입·API 키 발급 → **테스트/프로토타입에 최적.**
- **한계:** 예약 전환(커미션)이 직접 붙지 않음. 항공 포함은 장점.

---

## Serendy 적용 전략 (이원 전략)

```text
[ 지금 (MVP / 데이터 수집 검증) ]
  Amadeus Self-Service  → 즉시 가입, 호텔 가격 데이터로 가격추세·역검색 PoC
  + 일반 어필리에이트 링크(Booking/Agoda) → 수익 채널 먼저 오픈

        ↓ (트래픽·예약 실적 축적)

[ 다음 (스케일업) ]
  Agoda Connect 승인     → 아시아 재고 + 커미션 (한국인 아웃바운드 핵심)
  Booking Demand API 승인 → 글로벌 재고 + 커미션
  Expedia Rapid (선택)    → 북미/패키지 보강
```

### 결정 포인트
- **데이터 수집 즉시 시작**이 필요하면 → **Amadeus** (승인 장벽 없음, 호출당 과금만 관리)
- **수익(커미션) 우선**이면 → 일반 **어필리에이트 링크**부터 (API 승인 불필요)
- **타깃(동남아 아웃바운드) 정합성**은 → **Agoda**가 가장 높음
- 가격 **장기 시계열 저장**(Serendy의 핵심 해자)은 각 API **약관 검토 필수** — 스크래핑은 법적 리스크로 후순위

---

## 참고 출처
- Booking.com Demand API — developers.booking.com/demand
- Agoda Affiliate / Connect — getlasso.co/affiliate/agoda, zentrumhub.com (Agoda Hotel API Guide)
- Expedia Rapid (EPS) — developer.expediapartnersolutions.com, altexsoft.com (Expedia TAAP & Rapid)
- Amadeus Self-Service Pricing — developers.amadeus.com/pricing
