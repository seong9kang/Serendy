// 남은 접속 실패 — HasData /scrape/web (jsRendering=true)로 최종 재시도
// 글로벌 체인 안티봇(Akamai)은 Shifter/Playwright 데이터센터 IP로 403 → HasData가 우회.
// 사용: node src/collector/hasdata-rescue.js [rescueReport]
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}
loadEnv();
const KEY = process.env.HASDATA_API_KEY || "";
if (!KEY) { console.error("HASDATA_API_KEY 없음"); process.exit(1); }

const DATE = "2026-06-20-corrected";
const OUTDIR = path.join(__dirname, "..", "..", "data", "raw", "korea", DATE, "homepage");
const RESCUE = process.argv[2] || path.join(OUTDIR, "_rescue-report.json");
const BLOCK_RE = /Pardon Our Interruption|Access Denied|captcha|cf-browser-verification|are you a robot|verify you are human/i;

function hasdataWeb(url, { timeout = 70 } = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ url, jsRendering: true });
    execFile("curl", ["-s", "-m", String(timeout), "-X", "POST",
      "https://api.hasdata.com/scrape/web", "-H", `x-api-key: ${KEY}`,
      "-H", "Content-Type: application/json", "-d", payload, "-w", "\n__API__%{http_code}"],
      { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        const out = stdout || "";
        const m = out.match(/__API__(\d+)\s*$/);
        const apiCode = m ? Number(m[1]) : 0;
        const json = out.replace(/\n__API__\d+\s*$/, "");
        let pageStatus = null, content = "";
        try {
          const o = JSON.parse(json);
          pageStatus = (o.requestMetadata && o.requestMetadata.status) || null;
          content = o.content || "";
        } catch {}
        resolve({ apiCode, pageStatus, contentChars: content.length, blocked: BLOCK_RE.test(content.slice(0, 5000)),
          err: err ? String(err).slice(0, 50) : null });
      });
  });
}

async function main() {
  const rescue = JSON.parse(fs.readFileSync(RESCUE, "utf8"));
  // 대상: 아직 ok 아니고, URL 후보가 있는 것 (no_candidate 제외)
  const targets = rescue.report.filter((r) => r.status !== "ok" && r.url);
  const skipped = rescue.report.filter((r) => r.status !== "ok" && !r.url);
  console.log(`[korea] HasData web(JS렌더) 최종 재시도 — ${targets.length}곳 (URL없음 ${skipped.length}곳 제외)\n`);

  const report = [];
  let i = 0, idx = 0, ok = 0, still = 0;
  async function worker() {
    while (true) {
      const k = idx++;
      if (k >= targets.length) break;
      const t = targets[k];
      const r = await hasdataWeb(t.url);
      const good = r.apiCode === 200 && r.pageStatus === "ok" && r.contentChars > 500 && !r.blocked;
      if (good) ok++; else still++;
      report.push({ hotelSno: t.hotelSno, name: t.name, region: t.region, url: t.url,
        ok: good, apiCode: r.apiCode, pageStatus: r.pageStatus, contentChars: r.contentChars, blocked: r.blocked, err: r.err });
      process.stdout.write(`\r  진행 ${++i}/${targets.length} (ok ${ok} / 실패 ${still})   `);
    }
  }
  await Promise.all(Array.from({ length: 5 }, () => worker()));
  console.log("\n");

  report.sort((a, b) => a.hotelSno - b.hotelSno);
  fs.writeFileSync(path.join(OUTDIR, "_hasdata-rescue-report.json"), JSON.stringify({ ok, still, skipped: skipped.map((s) => ({ hotelSno: s.hotelSno, name: s.name })), report }, null, 2));

  console.log(`=== HasData 최종 재시도 ===`);
  console.log(`  HasData로 접속 성공: ${ok} / ${targets.length}`);
  console.log(`\n--- HasData로 살아난 곳 ---`);
  for (const r of report.filter((x) => x.ok))
    console.log(`  ${(r.region || "").padEnd(3)} ${r.name} (${r.contentChars.toLocaleString()} chars) → ${r.url}`);
  console.log(`\n--- HasData로도 안 됨 ---`);
  for (const r of report.filter((x) => !x.ok))
    console.log(`  api=${r.apiCode} page=${r.pageStatus} ${(r.region || "").padEnd(3)} ${r.name} → ${r.url}`);
  console.log(`\n--- URL없음(공식홈페이지 부재, Maps 필요) ---`);
  for (const s of skipped) console.log(`  ${(s.region || "")} ${s.name}`);
  console.log(`\n리포트: data/raw/korea/${DATE}/homepage/_hasdata-rescue-report.json`);
}

main();
