// 보정 리스트의 각 URL을 HEAD로 최종 랜딩까지 해소(단축/vanity 교정) 후, 바뀐 곳만 재접속 검증.
// 사용: node src/collector/resolve-and-verify.js [corrected.json]
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8");
    for (const line of txt.split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim(); }
  } catch {}
}
loadEnv();
const HOST = process.env.SHIFTER_HOST || "astraeus.p.shifter.io";
const PORTS = (process.env.SHIFTER_PORT_LIST || "10565,10566,10567,10568,10569,10570,10571,10572,10573,10574").split(",").map((s) => Number(s.trim())).filter(Boolean);
const KEY = process.env.HASDATA_API_KEY || "";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BLOCK_RE = /Pardon Our Interruption|Access Denied|Reference #|captcha|cf-browser-verification|are you a robot|verify you are human/i;
const CHAIN_RE = /marriott\.com|hyatt\.com|ihg\.com|fourseasons\.com|hilton\.com/i;
const SRC = process.argv[2] || "/tmp/corrected.json";

function norm(u) { return (u || "").replace(/\/+$/, ""); }
function resolveLanding(url) {
  return new Promise((resolve) => {
    execFile("curl", ["-4", "-sIL", "-m", "20", "-A", UA, "-o", "/dev/null", "-w", "%{http_code} %{url_effective}", url],
      (e, out) => {
        const m = (out || "").match(/^(\d+)\s+(\S+)/);
        if (!m || Number(m[1]) === 0) return resolve(url);
        let f = m[2]; try { const u = new URL(f); if ((u.port === "443" && u.protocol === "https:") || (u.port === "80" && u.protocol === "http:")) { u.port = ""; f = u.href; } } catch {}
        resolve(f);
      });
  });
}
function curlGet(url, port) {
  return new Promise((resolve) => {
    const a = ["-4", "-sL", "-m", "25", "-A", UA, "--max-filesize", "2000000", "-r", "0-30000"];
    if (port) a.push("-x", `http://${HOST}:${port}`);
    a.push("-w", "\n__H__%{http_code}", url);
    execFile("curl", a, { maxBuffer: 8 * 1024 * 1024 }, (e, out) => {
      out = out || ""; const m = out.match(/__H__(\d+)\s*$/);
      resolve({ code: m ? Number(m[1]) : 0, body: out.replace(/\n__H__\d+\s*$/, "") });
    });
  });
}
function hasdataWeb(url) {
  return new Promise((resolve) => {
    execFile("curl", ["-s", "-m", "75", "-X", "POST", "https://api.hasdata.com/scrape/web", "-H", `x-api-key: ${KEY}`, "-H", "Content-Type: application/json", "-d", JSON.stringify({ url, jsRendering: true }), "-w", "\n__A__%{http_code}"],
      { maxBuffer: 64 * 1024 * 1024 }, (e, out) => {
        out = out || ""; const a = (out.match(/__A__(\d+)$/) || [])[1]; const j = out.replace(/\n__A__\d+$/, "");
        let st = null, c = ""; try { const o = JSON.parse(j); st = o.requestMetadata && o.requestMetadata.status; c = o.content || ""; } catch {}
        resolve({ api: Number(a || 0), status: st, chars: c.length, blocked: BLOCK_RE.test(c.slice(0, 4000)) });
      });
  });
}
function classify(code, body) { if (code === 0) return "failed"; if (code >= 200 && code < 400) return BLOCK_RE.test(body || "") ? "blocked" : "ok"; return "http_error"; }

async function verify(url, port) {
  let r = await curlGet(url, port);              // shifter
  let s = classify(r.code, r.body);
  if (s === "ok") return { status: "ok", method: "shifter", code: r.code };
  if (KEY && (CHAIN_RE.test(url) || s === "http_error" || s === "blocked")) {  // 글로벌체인/차단 → HasData 재시도
    for (let t = 0; t < 6; t++) {
      const h = await hasdataWeb(url);
      if (h.api === 200 && h.status === "ok" && h.chars > 1500 && !h.blocked) return { status: "ok", method: "hasdata", tries: t + 1 };
    }
  }
  r = await curlGet(url, null); s = classify(r.code, r.body);  // local
  if (s === "ok") return { status: "ok", method: "local", code: r.code };
  return { status: s, method: "none", code: r.code };
}

async function main() {
  const list = JSON.parse(fs.readFileSync(SRC, "utf8"));
  console.log(`[korea] HEAD 랜딩 해소 — ${list.length}곳`);
  // 1) 전부 HEAD 해소 (동시 10)
  const v2 = [];
  let idx = 0, done = 0;
  async function rw() { while (true) { const k = idx++; if (k >= list.length) break; const h = list[k]; const landing = h.homepage ? await resolveLanding(h.homepage) : null; v2.push({ ...h, landing, changed: landing && norm(landing) !== norm(h.homepage) }); process.stdout.write(`\r  해소 ${++done}/${list.length}`); } }
  await Promise.all(Array.from({ length: 10 }, () => rw()));
  v2.sort((a, b) => a.hotelSno - b.hotelSno);
  console.log("");
  const changed = v2.filter((x) => x.changed);
  console.log(`  랜딩이 바뀐 곳: ${changed.length}\n`);

  // 2) 바뀐 곳만 재접속 검증
  let i = 0, ci = 0; const out = [];
  async function vw(n) { let port = PORTS[n % PORTS.length]; while (true) { const k = ci++; if (k >= changed.length) break; const h = changed[k]; const v = await verify(h.landing, port); port = PORTS[(PORTS.indexOf(port) + 1) % PORTS.length]; out.push({ hotelSno: h.hotelSno, name: h.name, region: h.region, before: h.homepage, after: h.landing, ...v }); process.stdout.write(`\r  검증 ${++i}/${changed.length}`); } }
  await Promise.all(Array.from({ length: 5 }, (_, n) => vw(n)));
  console.log("\n");

  out.sort((a, b) => a.hotelSno - b.hotelSno);
  fs.writeFileSync("/tmp/corrected_v2.json", JSON.stringify(v2.map((x) => ({ hotelSno: x.hotelSno, name: x.name, region: x.region, homepage: x.landing || x.homepage })), null, 2));
  fs.writeFileSync(path.join(__dirname, "..", "..", "data", "raw", "korea", "2026-06-20-corrected", "homepage", "_landing-verify-report.json"), JSON.stringify(out, null, 2));

  const ok = out.filter((x) => x.status === "ok").length;
  console.log(`=== 랜딩 해소 후 재검증 (바뀐 ${changed.length}곳) ===`);
  console.log(`  접속 ok: ${ok} / ${changed.length}`);
  console.log(`\n--- vanity/단축 URL 교정 사례 (경로 추가/축약) ---`);
  for (const r of out.filter((x) => x.status === "ok" && /\/(selcy|cjjpy|seltx|selga|seler|selfg)\b/i.test(x.before) || (x.before && x.before.split("/").length <= 4 && x.after && x.after.split("/").length > x.before.split("/").length && /marriott|hyatt/i.test(x.after))))
    console.log(`  [${r.method}] ${r.name}\n      ${r.before}\n   →  ${r.after}`);
  console.log(`\n--- 재검증 실패(여전히 안 됨) ---`);
  for (const r of out.filter((x) => x.status !== "ok")) console.log(`  [${r.status}] ${r.name} → ${r.after}`);
  console.log(`\n리포트: data/raw/korea/2026-06-20-corrected/homepage/_landing-verify-report.json, /tmp/corrected_v2.json`);
}
main();
