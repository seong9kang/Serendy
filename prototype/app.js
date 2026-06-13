// Serendy 프로토타입 — flow.md 기반 재구성 (순수 바닐라 JS, 빌드 불필요)
(function () {
  const D = window.SERENDY_DATA;
  const won = (n) => n == null ? "—" : "₩" + n.toLocaleString("ko-KR");
  const hotelById = (id) => D.hotels.find((h) => h.id === id);
  const promoById = (id) => D.promotions.find((p) => p.id === id);
  const hotelsByPromo = (pid) => D.hotels.filter((h) => h.promoId === pid);

  const CHANNELS = [
    { key: "official", label: "공식 사이트" },
    { key: "member", label: "체인 회원가" },
    { key: "agoda", label: "Agoda" },
    { key: "booking", label: "Booking.com" },
    { key: "expedia", label: "Expedia" },
  ];

  function bestChannel(prices) {
    let best = null;
    for (const c of CHANNELS) {
      const v = prices[c.key];
      if (v == null) continue;
      if (!best || v < best.value) best = { ...c, value: v };
    }
    return best;
  }

  // 현재 가격 수준 판정 (vs 평균)
  function priceLevel(cur, avg) {
    const r = cur / avg;
    if (r <= 0.90) return { label: "매우 좋음", cls: "lv-great", buy: true };
    if (r <= 0.97) return { label: "좋음", cls: "lv-good", buy: true };
    if (r <= 1.03) return { label: "보통", cls: "lv-mid", buy: false };
    return { label: "높음", cls: "lv-high", buy: false };
  }

  // ── 뷰 전환 ─────────────────────────────────
  function showView(name) {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById("view-" + name).classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  document.querySelectorAll("[data-view]").forEach((el) => {
    el.addEventListener("click", () => showView(el.dataset.view));
  });

  // ════════════════════════════════════════════
  // ① EXPLORE — 대화형 목적 기반 추천 (flow A)
  // ════════════════════════════════════════════
  let exploreState = { purpose: "", month: "", direct: false };

  // 자연어 쿼리에서 조건 추출 (간이 파서 — 실서비스는 LLM 담당)
  function parseQuery(q) {
    const s = { purpose: "", month: "", direct: false };
    const m = q.match(/(\d{1,2})\s*월/);
    if (m) s.month = m[1];
    if (/직항/.test(q)) s.direct = true;
    if (/따뜻|휴양|덥|남쪽/.test(q)) s.purpose = "휴양";
    if (/가족|아이|애들/.test(q)) s.purpose = "가족여행";
    if (/허니문|신혼/.test(q)) s.purpose = "허니문";
    if (/쇼핑|도시/.test(q)) s.purpose = "쇼핑";
    if (/리조트/.test(q)) s.purpose = "리조트";
    return s;
  }

  const flowBox = () => document.getElementById("exploreFlow");

  // 1단계: AI 되묻기 (인원/예산/직항)
  function askFollowUp() {
    const s = exploreState;
    const summary = [s.month ? s.month + "월" : null, s.purpose || null, s.direct ? "직항" : null]
      .filter(Boolean).join(" · ") || "여행 추천";
    flowBox().innerHTML = `
      <div class="chat">
        <div class="bubble user">${summary} 추천해줘</div>
        <div class="bubble ai">
          <p>좋아요! 더 정확히 추천해 드릴게요. 몇 가지만 알려주세요 👇</p>
          <div class="followups">
            <div class="fu-group">
              <span>인원</span>
              <div class="fu-opts" data-key="people">
                <button>혼자</button><button>2인</button><button class="sel">가족</button>
              </div>
            </div>
            <div class="fu-group">
              <span>예산 (1박)</span>
              <div class="fu-opts" data-key="budget">
                <button>~20만</button><button class="sel">20~50만</button><button>50만+</button>
              </div>
            </div>
            <div class="fu-group">
              <span>직항</span>
              <div class="fu-opts" data-key="direct">
                <button class="${s.direct ? "sel" : ""}">선호</button><button class="${s.direct ? "" : "sel"}">상관없음</button>
              </div>
            </div>
          </div>
          <button class="primary sm" id="seeRecs">추천 목적지 보기 →</button>
        </div>
      </div>`;
    // 팔로업 토글
    flowBox().querySelectorAll(".fu-opts").forEach((g) => {
      g.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        g.querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
        b.classList.add("sel");
        if (g.dataset.key === "direct") exploreState.direct = b.textContent === "선호";
      }));
    });
    document.getElementById("seeRecs").addEventListener("click", showRecommendations);
  }

  // 2단계: 목적지 추천 → 호텔
  function showRecommendations() {
    const s = exploreState;
    let dests = D.destinations.filter((d) => {
      if (s.month && !d.warmMonths.includes(parseInt(s.month))) return false;
      if (s.purpose && !d.purposes.includes(s.purpose)) return false;
      if (s.direct && !d.direct) return false;
      return true;
    });
    if (!dests.length) dests = D.destinations.filter((d) => !s.purpose || d.purposes.includes(s.purpose));

    const cards = dests.slice(0, 4).map((d, i) => {
      const h = hotelById(d.hotelIds[0]);
      const best = bestChannel(h.prices);
      const reason = [];
      if (s.month) reason.push(`${s.month}월 평균 ${h.weather.temp}℃`);
      reason.push(d.direct ? `직항 ${d.hours}h` : `경유 ${d.hours}h`);
      if (s.purpose) reason.push(`${s.purpose} 적합`);
      return `
        <div class="dest-card" data-hotel="${h.id}">
          <div class="dest-rank">${i + 1}</div>
          <div class="dest-emoji">${h.image}</div>
          <div class="dest-body">
            <div class="dest-name">${d.city} <span class="muted">${d.country}</span></div>
            <div class="dest-reason">💡 ${reason.join(" · ")}</div>
            <div class="dest-hotel">🏨 ${h.name} · 최저가 <b>${won(best.value)}</b></div>
          </div>
          <div class="dest-go">상세 →</div>
        </div>`;
    }).join("");

    flowBox().insertAdjacentHTML("beforeend", `
      <div class="chat">
        <div class="bubble ai">
          <p>조건에 맞는 <b>추천 목적지</b>예요. 카드를 누르면 호텔 의사결정 정보로 바로 이동합니다.</p>
          <div class="dest-list">${cards || '<div class="empty">조건에 맞는 목적지를 못 찾았어요.</div>'}</div>
        </div>
      </div>`);
    flowBox().querySelectorAll(".dest-card").forEach((c) =>
      c.addEventListener("click", () => openHotel(c.dataset.hotel)));
    flowBox().scrollIntoView({ behavior: "smooth", block: "end" });
  }

  function startExplore() {
    askFollowUp();
    flowBox().scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // 칩 / 입력 / 빠른질문 바인딩
  document.querySelectorAll("#purposeChips .chip").forEach((c) => {
    c.addEventListener("click", () => {
      if (c.dataset.goto) { showView(c.dataset.goto); return; }
      exploreState = { purpose: c.dataset.purpose, month: "", direct: false };
      startExplore();
    });
  });
  document.getElementById("aiAsk").addEventListener("click", () => {
    const q = document.getElementById("aiQuery").value.trim();
    if (!q) return;
    exploreState = parseQuery(q);
    startExplore();
  });
  document.getElementById("aiQuery").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("aiAsk").click();
  });
  document.querySelectorAll(".quick-q .q").forEach((b) =>
    b.addEventListener("click", () => {
      document.getElementById("aiQuery").value = b.textContent;
      document.getElementById("aiAsk").click();
    }));

  // ════════════════════════════════════════════
  // ② PROMOTIONS
  // ════════════════════════════════════════════
  function promoCardHTML(p, compact) {
    return `
      <div class="promo ${p.highlight ? "hl" : ""}" data-promo="${p.id}">
        ${p.highlight ? `<span class="hot-tag">HOT</span>` : ""}
        <span class="chip-chain" style="background:${p.chainColor}">${p.chain}</span>
        <h3>${p.title}</h3>
        <div class="ptype">${p.type} · ${p.regions.join(", ")}</div>
        ${compact ? "" : `<p class="pdesc">${p.desc}</p>
        <div class="value-bar"><span style="width:${p.value}%"></span></div>
        <div style="font-size:11px;color:var(--muted);margin-top:6px">가치 점수 ${p.value}/100 · 적용 호텔 ${hotelsByPromo(p.id).length}곳</div>`}
        <div class="promo-foot">
          <span class="discount-badge">${p.discount}</span>
          <span class="period">${p.period}</span>
        </div>
      </div>`;
  }

  function renderPromos() {
    const sorted = [...D.promotions].sort((a, b) => b.value - a.value);
    document.getElementById("promoGrid").innerHTML = sorted.map((p) => promoCardHTML(p, false)).join("");
    document.getElementById("homePromoStrip").innerHTML = sorted.slice(0, 3).map((p) => promoCardHTML(p, true)).join("");
    document.querySelectorAll("[data-promo]").forEach((el) =>
      el.addEventListener("click", () => openPromo(el.dataset.promo)));
  }

  // 프로모션 상세 → 적용 호텔 목록
  function openPromo(pid) {
    const p = promoById(pid);
    const hotels = hotelsByPromo(pid);
    const sheet = document.getElementById("promoSheet");
    sheet.innerHTML = `
      <button class="close" data-close="promo">✕</button>
      <span class="chip-chain" style="background:${p.chainColor}">${p.chain}</span>
      <h2 class="d-title">${p.title}</h2>
      <div class="d-sub">${p.type} · ${p.period}</div>
      <p class="d-desc">${p.desc}</p>
      <div class="terms">
        <h4>적용 조건</h4>
        <ul>${p.terms.map((t) => `<li>${t}</li>`).join("")}</ul>
      </div>
      <h4 class="applied-head">이 프로모션 적용 호텔 (${hotels.length})</h4>
      <div class="applied-list">
        ${hotels.map((h) => {
          const best = bestChannel(h.prices);
          return `<div class="applied" data-hotel="${h.id}">
            <span class="ae">${h.image}</span>
            <div><div class="an">${h.name}</div><div class="al">${h.country} · ${h.city}</div></div>
            <div class="ap">최저가 <b>${won(best.value)}</b></div>
            <span class="ago">상세 →</span>
          </div>`;
        }).join("") || '<div class="empty">적용 호텔 데이터 준비 중</div>'}
      </div>`;
    sheet.querySelectorAll(".applied").forEach((el) =>
      el.addEventListener("click", () => { closeOverlay("promo"); openHotel(el.dataset.hotel); }));
    openOverlay("promo");
  }

  // ════════════════════════════════════════════
  // ③ HOTELS — 검색 + 목록
  // ════════════════════════════════════════════
  function renderHotelList(filter) {
    const q = (filter || "").trim().toLowerCase();
    const list = D.hotels.filter((h) =>
      !q || (h.name + h.country + h.city + (h.chain || "")).toLowerCase().includes(q));
    const box = document.getElementById("hotelList");
    if (!list.length) { box.innerHTML = `<div class="empty">검색 결과가 없어요.</div>`; return; }
    box.innerHTML = list.map((h) => {
      const best = bestChannel(h.prices);
      const lv = priceLevel(best.value, h.avgPrice);
      const promo = h.promoId ? promoById(h.promoId) : null;
      const chainTag = h.chain ? `<span class="tag chain">${h.chain}</span>` : "";
      return `
      <div class="hotel" data-hotel="${h.id}">
        <div class="h-emoji">${h.image}</div>
        <div>
          <div class="h-name">${h.name}</div>
          <div class="h-loc">${h.country} · ${h.city}</div>
          <div><span class="stars">${"★".repeat(h.grade)}</span><span class="rating">${h.rating} (${h.reviews.toLocaleString()})</span></div>
          <div class="h-tags">${chainTag}${h.purposes.map((t) => `<span class="tag">${t}</span>`).join("")}</div>
        </div>
        <div class="h-right">
          <div class="h-best">최저가 <b>${won(best.value)}</b> <span class="muted">/ ${best.label}</span></div>
          <span class="level ${lv.cls}">현재 ${lv.label}</span>
          ${promo ? `<div class="h-promo">🔥 ${promo.chain} ${promo.discount}</div>` : ""}
          <button class="primary sm">의사결정 정보 보기 →</button>
        </div>
      </div>`;
    }).join("");
    box.querySelectorAll(".hotel").forEach((el) =>
      el.addEventListener("click", () => openHotel(el.dataset.hotel)));
  }
  document.getElementById("hotelSearch").addEventListener("input", (e) => renderHotelList(e.target.value));

  // ════════════════════════════════════════════
  // ★ 호텔 상세 — 가장 중요한 화면 ("검색"이 아닌 "의사결정")
  // ════════════════════════════════════════════
  function sparkline(data, w, h) {
    const min = Math.min(...data), max = Math.max(...data), pad = 8, range = max - min || 1;
    const pts = data.map((v, i) => [
      pad + (i / (data.length - 1)) * (w - pad * 2),
      pad + (1 - (v - min) / range) * (h - pad * 2),
    ]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const area = line + ` L${pts[pts.length-1][0].toFixed(1)} ${h-pad} L${pts[0][0].toFixed(1)} ${h-pad} Z`;
    const dots = pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i===pts.length-1?4:2}" fill="${i===pts.length-1?'#4ad9c0':'#6c8cff'}"/>`).join("");
    return `<svg viewBox="0 0 ${w} ${h}"><defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#6c8cff" stop-opacity="0.35"/><stop offset="100%" stop-color="#6c8cff" stop-opacity="0"/>
      </linearGradient></defs><path d="${area}" fill="url(#sg)"/><path d="${line}" fill="none" stroke="#6c8cff" stroke-width="2.5"/>${dots}</svg>`;
  }

  function openHotel(id) {
    const h = hotelById(id);
    const hist = h.history.map((v) => v * 1000);
    const cur = hist[hist.length - 1];
    const lo = Math.min(...hist), hi = Math.max(...hist);
    const lv = priceLevel(cur, h.avgPrice);
    const best = bestChannel(h.prices);
    const promo = h.promoId ? promoById(h.promoId) : null;

    const channelRows = CHANNELS.filter((c) => h.prices[c.key] != null).map((c) => {
      const isBest = c.key === best.key, diff = h.prices[c.key] - best.value;
      return `<div class="price-row ${isBest ? "best" : ""}">
        <span class="ch">${c.label} ${isBest ? `<span class="best-badge">최저가</span>` : ""}</span>
        <span class="pr">${won(h.prices[c.key])}${!isBest && diff > 0 ? ` <span class="muted" style="font-size:12px">+${won(diff)}</span>` : ""}</span>
      </div>`;
    }).join("");

    let guide;
    if (best.key === "official") guide = `현재 <b>공식 사이트</b>가 가장 저렴합니다.`;
    else if (best.key === "member") guide = `<b>${h.chain} 회원가</b>가 최저가입니다.`;
    else {
      const vs = h.prices.official ? Math.round((1 - best.value / h.prices.official) * 100) : null;
      guide = `<b>${best.label}</b>가 ${vs ? `공식가 대비 ${vs}% ` : ""}저렴합니다.`;
    }

    const verdict = lv.buy
      ? `<div class="verdict buy">✅ <b>지금이 예약하기 좋은 시점입니다.</b><br>현재가가 3개월 평균(${won(h.avgPrice)})보다 ${Math.round((1-cur/h.avgPrice)*100)}% 낮습니다.</div>`
      : `<div class="verdict wait">⏳ <b>조금 더 지켜봐도 좋습니다.</b><br>현재가가 평균 대비 ${cur>h.avgPrice?"+":""}${Math.round((cur/h.avgPrice-1)*100)}% 수준입니다. 프로모션 시즌을 노려보세요.</div>`;

    const sheet = document.getElementById("detailSheet");
    sheet.innerHTML = `
      <button class="close" data-close="detail">✕</button>
      <div class="d-hero">
        <div class="d-emoji">${h.image}</div>
        <div>
          <h2 class="d-title">${h.name}</h2>
          <div class="d-sub">${h.country} · ${h.city} · <span class="stars">${"★".repeat(h.grade)}</span> · ⭐ ${h.rating} (${h.reviews.toLocaleString()})</div>
          <div class="h-tags">${h.chain ? `<span class="tag chain">${h.chain}</span>` : ""}${h.purposes.map((t)=>`<span class="tag">${t}</span>`).join("")}</div>
        </div>
      </div>

      <!-- 핵심: 가격 의사결정 블록 -->
      <div class="d-decision">
        <div class="d-price-head">
          <div>
            <div class="muted sm">현재 최저가 (${best.label})</div>
            <div class="big-price">${won(best.value)}</div>
          </div>
          <div class="lvl-box ${lv.cls}">
            <div class="muted sm">현재 가격 수준</div>
            <div class="lvl-label">${lv.label}</div>
          </div>
        </div>
        <div class="d-trend">
          ${sparkline(hist, 620, 150)}
          <div class="trend-stats">
            <div><span class="muted sm">최근 3개월 평균</span><b>${won(h.avgPrice)}</b></div>
            <div><span class="muted sm">최저 / 최고</span><b>${won(lo)} / ${won(hi)}</b></div>
          </div>
        </div>
        ${verdict}
      </div>

      <div class="d-cols">
        <!-- 채널별 최저가 비교 -->
        <div class="d-card">
          <h4>💰 채널별 가격 비교</h4>
          ${channelRows}
          <div class="guide">💡 ${guide}</div>
        </div>

        <!-- 프로모션 + 포인트 효율 -->
        <div class="d-card">
          <h4>🔥 현재 프로모션 · 포인트</h4>
          ${promo ? `<div class="d-promo" data-promo="${promo.id}">
            <span class="chip-chain" style="background:${promo.chainColor}">${promo.chain}</span>
            <div class="dp-title">${promo.title}</div>
            <span class="discount-badge">${promo.discount}</span>
          </div>` : `<div class="muted sm">현재 진행 중인 체인 프로모션이 없습니다.</div>`}
          <div class="point-eff"><span class="muted sm">포인트 효율</span><div>${h.pointValue}</div></div>
        </div>
      </div>

      <!-- AI 분석 -->
      <div class="d-card ai-analysis">
        <h4>🤖 AI 분석</h4>
        <div class="ai-cols">
          <div><div class="ai-h good">이런 분께 적합</div><ul>${h.ai.fit.map((x)=>`<li>✓ ${x}</li>`).join("")}</ul></div>
          <div><div class="ai-h warn">참고하세요</div><ul>${h.ai.cautions.map((x)=>`<li>! ${x}</li>`).join("")}</ul></div>
        </div>
        <div class="ai-weather muted sm">🌡️ 평균 ${h.weather.temp}℃ · ${h.weather.season} · ✈️ ${h.flight.direct?"직항":"경유"} ${h.flight.hours}h (${h.flight.airport})</div>
      </div>

      <div class="d-actions">
        <button class="ghost" data-watch="${h.id}">🔔 가격 알림 받기</button>
        <a class="primary book" href="#" onclick="return false;">${best.label}에서 예약하기 →</a>
      </div>`;

    // 상세 안에서 프로모션 클릭
    const dp = sheet.querySelector(".d-promo");
    if (dp) dp.addEventListener("click", () => { closeOverlay("detail"); openPromo(dp.dataset.promo); });
    sheet.querySelector("[data-watch]").addEventListener("click", (e) => {
      e.target.textContent = "✅ 알림 설정됨"; e.target.disabled = true;
    });
    openOverlay("detail");
  }

  // ════════════════════════════════════════════
  // ④ MY ALERTS
  // ════════════════════════════════════════════
  function renderAlerts() {
    const box = document.getElementById("alertList");
    box.innerHTML = D.alerts.map((a) => {
      if (a.kind === "price") {
        const h = hotelById(a.hotelId);
        const cur = bestChannel(h.prices).value;
        const hit = cur <= a.target;
        return `<div class="alert ${hit ? "hit" : ""}" data-hotel="${h.id}">
          <span class="ae">${h.image}</span>
          <div class="abody">
            <div class="an">${h.name}</div>
            <div class="al">${a.note} · 목표가 ${won(a.target)}</div>
          </div>
          <div class="astat">
            <div class="muted sm">현재가</div><b>${won(cur)}</b>
            ${hit ? `<span class="hit-badge">목표 도달!</span>` : `<span class="muted sm">${won(cur - a.target)} 남음</span>`}
          </div>
        </div>`;
      } else {
        return `<div class="alert" data-view="promos">
          <span class="ae">🔥</span>
          <div class="abody"><div class="an">${a.chain} 프로모션 알림</div><div class="al">${a.note}</div></div>
          <div class="astat"><span class="muted sm">감시 중</span></div>
        </div>`;
      }
    }).join("");
    box.querySelectorAll("[data-hotel]").forEach((el) => el.addEventListener("click", () => openHotel(el.dataset.hotel)));
    box.querySelectorAll("[data-view]").forEach((el) => el.addEventListener("click", () => showView(el.dataset.view)));
  }

  // ── 오버레이 제어 ────────────────────────────
  function openOverlay(which) {
    const el = document.getElementById(which === "detail" ? "detail" : "promoDetail");
    el.classList.add("open"); el.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }
  function closeOverlay(which) {
    const el = document.getElementById(which === "detail" ? "detail" : "promoDetail");
    el.classList.remove("open"); el.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }
  document.querySelectorAll(".detail-overlay").forEach((ov) => {
    ov.addEventListener("click", (e) => {
      if (e.target === ov) closeOverlay(ov.id === "detail" ? "detail" : "promo");
      const c = e.target.closest("[data-close]");
      if (c) closeOverlay(c.dataset.close);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeOverlay("detail"); closeOverlay("promo"); }
  });

  // ── 초기화 ──────────────────────────────────
  renderPromos();
  renderHotelList("");
  renderAlerts();
})();
