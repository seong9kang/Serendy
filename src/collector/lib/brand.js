// 브랜드/체인 추출 — 호텔명에서 브랜드·체인·글로벌체인을 파생한다.
// 한국 호텔명은 "법인명 + 브랜드"가 섞여 있어(예: "(주)호텔롯데 롯데시티호텔울산"),
// 키워드 규칙으로 추출한다. 구체적 브랜드를 먼저 매칭(첫 매칭 우선).
//
// 반환: { brand, chain, globalChain }
//   brand       : 세부 브랜드 (롯데시티호텔, 코트야드, 신라스테이 …) | null
//   chain       : 모기업/그룹 (롯데, 신라, 메리어트, 아코르 …) | null
//   globalChain : Serendy 프로모션 추적 대상 글로벌 체인 | null
//                 (Marriott/Hilton/Hyatt/IHG/Accor/Wyndham/Best Western)

// [정규식, brand, chain, globalChain] — 위에서부터 첫 매칭 사용
const RULES = [
  // ── 글로벌 프랜차이즈 브랜드 (코브랜드도 글로벌 체인으로 귀속) ──
  // Marriott
  [/리츠[ -]?칼튼|ritz[ -]?carlton/i, "리츠칼튼", "메리어트", "Marriott"],
  [/jw\s?메리어트|jw\s?marriott/i, "JW 메리어트", "메리어트", "Marriott"],
  [/코트야드|courtyard/i, "코트야드", "메리어트", "Marriott"],
  [/포포인츠|four\s?points/i, "포포인츠", "메리어트", "Marriott"],
  [/르\s?메르디앙|meridien/i, "르메르디앙", "메리어트", "Marriott"],
  [/웨스틴|westin/i, "웨스틴", "메리어트", "Marriott"],
  [/쉐라톤|sheraton/i, "쉐라톤", "메리어트", "Marriott"],
  [/오토그래프|autograph/i, "오토그래프", "메리어트", "Marriott"],
  [/목시|moxy/i, "목시", "메리어트", "Marriott"],
  [/\bw\s?(호텔|서울|seoul)/i, "W", "메리어트", "Marriott"],
  [/메리어트|marriott/i, "메리어트", "메리어트", "Marriott"],
  // Hilton
  [/콘래드|conrad/i, "콘래드", "힐튼", "Hilton"],
  [/더블트리|doubletree/i, "더블트리", "힐튼", "Hilton"],
  [/힐튼|hilton/i, "힐튼", "힐튼", "Hilton"],
  // Hyatt
  [/파크\s?하얏트|park\s?hyatt/i, "파크 하얏트", "하얏트", "Hyatt"],
  [/그랜드\s?하얏트|grand\s?hyatt/i, "그랜드 하얏트", "하얏트", "Hyatt"],
  [/안다즈|andaz/i, "안다즈", "하얏트", "Hyatt"],
  [/하얏트|hyatt/i, "하얏트", "하얏트", "Hyatt"],
  // IHG
  [/인터컨티넨탈|intercontinental/i, "인터컨티넨탈", "IHG", "IHG"],
  [/홀리데이\s?인|holiday\s?inn/i, "홀리데이 인", "IHG", "IHG"],
  [/크라운\s?플라자|crowne\s?plaza/i, "크라운 플라자", "IHG", "IHG"],
  [/보코|voco/i, "보코", "IHG", "IHG"],
  [/인디고|indigo/i, "호텔 인디고", "IHG", "IHG"],
  // Accor (코브랜드: 노보텔/이비스/머큐어 앰배서더 등은 Accor로)
  [/소피텔|sofitel/i, "소피텔", "아코르", "Accor"],
  [/풀만|pullman/i, "풀만", "아코르", "Accor"],
  [/노보텔|novotel/i, "노보텔", "아코르", "Accor"],
  [/머큐어|mercure/i, "머큐어", "아코르", "Accor"],
  [/이비스|ibis/i, "이비스", "아코르", "Accor"],
  [/페어몬트|fairmont/i, "페어몬트", "아코르", "Accor"],
  // Wyndham
  [/라마다|ramada/i, "라마다", "윈덤", "Wyndham"],
  [/데이즈\s?호텔|days\s?(hotel|inn)/i, "데이즈호텔", "윈덤", "Wyndham"],
  [/하워드\s?존슨|howard\s?johnson/i, "하워드 존슨", "윈덤", "Wyndham"],
  [/윈덤|wyndham/i, "윈덤", "윈덤", "Wyndham"],
  // Best Western
  [/베스트\s?웨스턴|best\s?western/i, "베스트웨스턴", "베스트웨스턴", "Best Western"],

  // ── 국내 그룹 (globalChain 없음) ──
  // 롯데
  [/시그니엘|signiel/i, "시그니엘", "롯데", null],
  [/롯데시티\s?호텔|롯데시티호텔/i, "롯데시티호텔", "롯데", null],
  [/\bL7\b/i, "L7", "롯데", null],
  [/롯데리조트/i, "롯데리조트", "롯데", null],
  [/롯데호텔|호텔롯데/i, "롯데호텔", "롯데", null],
  // 신라
  [/신라스테이/i, "신라스테이", "신라", null],
  [/호텔\s?신라|신라\s?호텔/i, "신라호텔", "신라", null],
  // 조선호텔앤리조트 (신세계)
  [/조선팰리스/i, "조선팰리스", "조선호텔앤리조트", null],
  [/그랜드\s?조선/i, "그랜드 조선", "조선호텔앤리조트", null],
  [/그래비티/i, "그래비티", "조선호텔앤리조트", null],
  [/레스케이프/i, "레스케이프", "조선호텔앤리조트", null],
  [/조선\s?호텔|조선호텔앤리조트/i, "조선", "조선호텔앤리조트", null],
  // 기타 국내
  [/한화|벨메르|더\s?플라자|the\s?plaza/i, null, "한화", null],
  [/앰배서더|ambassador/i, "앰배서더", "앰배서더", null],
  [/켄싱턴|kensington/i, "켄싱턴", "켄싱턴", null],
  [/파라다이스|paradise/i, "파라다이스", "파라다이스", null],
  [/워커힐|walkerhill/i, "워커힐", "워커힐", null],
  [/글래드|glad/i, "글래드", "글래드", null],
  [/반얀\s?트리|banyan\s?tree/i, "반얀트리", "반얀트리", null],
];

function extractBrand(name, nameEng) {
  const s = `${name || ""} ${nameEng || ""}`;
  for (const [re, brand, chain, globalChain] of RULES) {
    if (re.test(s)) return { brand, chain, globalChain };
  }
  return { brand: null, chain: null, globalChain: null };
}

module.exports = { extractBrand };
