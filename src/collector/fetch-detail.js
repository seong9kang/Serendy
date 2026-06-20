// 호텔 상세 — 공식 홈페이지 HTML 수집 (Shifter 프록시, IPv4 강제)
// fetch와 추출 분리: 여기선 원본 HTML만 raw/ 에 저장. 추출은 별도 단계(Claude).
// 사용: node src/collector/fetch-detail.js [hotels.json] [date]
//   hotels.json: [{hotelSno, name, homepage}, ...] (기본 /tmp/pilot.json)
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOST = "astraeus.p.shifter.io";
const PORTS = [10565, 10566, 10567, 10568, 10569, 10570, 10571, 10572, 10573, 10574];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SRC = process.argv[2] || "/tmp/pilot.json";
const DATE = process.argv[3] || new Date().toISOString().slice(0, 10);
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", DATE, "homepage");

// IPv4 강제(-4) 필수: 프록시 호스트가 IPv6로 잡히면 화이트리스트 밖 IP로 나가 403
function curlRaw(url, port, timeout = 35) {
  return new Promise((resolve) => {
    execFile("curl", ["-4", "-sL", "-m", String(timeout), "-A", UA,
      "-x", `http://${HOST}:${port}`, "-w", "\n__HTTP__%{http_code}", url],
      { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
        const out = stdout || "";
        const m = out.match(/__HTTP__(\d+)\s*$/);
        const code = m ? Number(m[1]) : 0;
        const body = out.replace(/\n__HTTP__\d+\s*$/, "");
        resolve({ code, body, err: err ? String(err).slice(0, 60) : null });
      });
  });
}

// meta-refresh(<meta http-equiv="refresh" content="0;url=...">) 1회 추적
function metaRefreshTarget(html, baseUrl) {
  const m = html.match(/http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i);
  if (!m) return null;
  try { return new URL(m[1], baseUrl).href; } catch { return null; }
}

function looksBlocked(html) {
  return /Pardon Our Interruption|Access Denied|captcha|cf-browser-verification|Request unsuccessful/i.test(html);
}

function plainText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// 포트 로테이션 + 재시도로 1개 URL 수집
async function fetchWithRetry(url, startPort, tries = 3) {
  let port = startPort;
  for (let t = 0; t < tries; t++) {
    const r = await curlRaw(url, port);
    if (r.code === 200 && r.body.length > 50) return { ...r, port };
    port = PORTS[(PORTS.indexOf(port) + 1) % PORTS.length];
  }
  return await curlRaw(url, port).then((r) => ({ ...r, port }));
}

async function main() {
  const hotels = JSON.parse(fs.readFileSync(SRC, "utf8"))
    .filter((h) => h.homepage && /^https?:\/\//.test(h.homepage));
  fs.mkdirSync(OUTDIR, { recursive: true });
  console.log(`[korea/detail] 홈페이지 HTML 수집 — ${hotels.length}곳 (date=${DATE})`);

  const report = [];
  let i = 0, ok = 0, blocked = 0, redir = 0, failed = 0, idx = 0;
  async function worker(n) {
    let port = PORTS[n % PORTS.length];
    while (true) {
      const k = idx++;
      if (k >= hotels.length) break;
      const h = hotels[k];
      let r = await fetchWithRetry(h.homepage, port, 3);
      let finalUrl = h.homepage, followed = false;
      // meta-refresh 추적 (1회)
      if (r.code === 200) {
        const tgt = metaRefreshTarget(r.body, h.homepage);
        if (tgt && tgt !== h.homepage && plainText(r.body).length < 60) {
          const r2 = await fetchWithRetry(tgt, r.port, 2);
          if (r2.code === 200) { r = r2; finalUrl = tgt; followed = true; }
        }
      }
      const txt = plainText(r.body);
      let status;
      if (r.code !== 200 || r.body.length < 50) { status = "failed"; failed++; }
      else if (looksBlocked(r.body)) { status = "blocked"; blocked++; }
      else if (txt.length < 200) { status = "thin"; redir++; }
      else { status = "ok"; ok++; }

      if (status !== "failed") {
        fs.writeFileSync(path.join(OUTDIR, `${h.hotelSno}.html`), r.body);
      }
      report.push({ hotelSno: h.hotelSno, name: h.name, http: r.code, status,
        bytes: r.body.length, textChars: txt.length, followed, finalUrl, err: r.err });
      process.stdout.write(`\r  진행 ${++i}/${hotels.length} (ok ${ok}/thin ${redir}/blocked ${blocked}/fail ${failed})   `);
    }
  }
  await Promise.all(PORTS.slice(0, 6).map((_, n) => worker(n)));
  console.log("");
  fs.writeFileSync(path.join(OUTDIR, "_fetch-report.json"), JSON.stringify(report, null, 2));

  console.log("\n=== 소스(공식 홈페이지) 수집 결과 ===");
  for (const r of report.sort((a, b) => a.status.localeCompare(b.status)))
    console.log(`  [${r.status.padEnd(7)}] http=${r.http} text=${String(r.textChars).padStart(5)} ${r.followed ? "↪" : " "} ${r.name}`);
  console.log(`\n합계: ok ${ok} / thin ${redir} / blocked ${blocked} / failed ${failed}  (총 ${hotels.length})`);
  console.log(`raw 저장: ${path.relative(path.join(__dirname, "..", ".."), OUTDIR)}/<hotelSno>.html`);
}

main();
