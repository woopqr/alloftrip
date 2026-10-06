#!/usr/bin/env node
/**
 * 올오브트립 자동 생성 — 도시 × 테마 조합당 글 1개(에버그린 주소)
 *  refill({ count })   : 아직 없는 조합의 글을 최대 count개 생성
 *  refresh({ count })  : 가장 오래 갱신되지 않은 글 count개를 같은 주소로 재수집(요금·순위 최신화)
 *  슬러그 = <theme>-<citySlug> → 파일 존재 여부가 곧 상태(별도 큐 불필요)
 *  여행 시점(가격 조회 기준)은 다가오는 달(monthsAhead 첫 값)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const THEMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/themes.json'), 'utf8'));
const CITIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cities.json'), 'utf8'));
const ART = path.join(ROOT, 'data/articles');
// 숙소 부족·중복으로 건너뛴 조합 기록 → RETRY_DAYS 동안 재시도하지 않음(매 실행 아고다 조회 낭비 방지)
const SKIP = path.join(ROOT, 'data/skipped.json');
const RETRY_DAYS = 30;
const loadSkip = () => { try { return JSON.parse(fs.readFileSync(SKIP, 'utf8')); } catch (_) { return {}; } };
const saveSkip = m => fs.writeFileSync(SKIP, JSON.stringify(m, null, 2) + '\n');
const pad = n => String(n).padStart(2, '0');

function targetYm() {
  const a = (THEMES.calendar.monthsAhead || [1])[0];
  const d = new Date(); d.setMonth(d.getMonth() + a);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// 생성 우선순위: 도시(cities.json 순) → 테마(themes.json 순). 테마 순서가 곧 같은 도시 안의 숙소 우선권.
function combos() {
  const ym = targetYm();
  const out = [];
  // 계절 감각: 여행 시점(targetYm)이 베스트 시즌인 여행지부터 선행 소개
  const m = Number(String(ym).split('-')[1]);
  const ordered = [...CITIES].sort((a, b) => ((b.bestMonths || []).includes(m) ? 1 : 0) - ((a.bestMonths || []).includes(m) ? 1 : 0));
  for (const c of ordered)
    for (const t of THEMES.themes)
      if (!t.onlyCities || t.onlyCities.includes(c.slug)) out.push({ theme: t.id, city: c, ym, slug: `${t.id}-${c.slug}` });
  return out;
}

function runGen(k) {
  execSync(`node gen.js ${k.theme} ${k.city.cityId} ${k.city.slug} ${k.ym}`, { cwd: ROOT, stdio: 'inherit', timeout: 180000 });
}

function refill({ count = 3 } = {}) {
  if (count <= 0) { console.log('✓ refill: 신규 발행 없음'); return 0; }
  fs.mkdirSync(ART, { recursive: true });
  let made = 0;
  const skip = loadSkip();
  const fresh = d => d && Date.now() - Date.parse(d) < RETRY_DAYS * 86400000;
  for (const k of combos()) {
    if (made >= count) break;
    const file = path.join(ART, k.slug + '.json');
    if (fs.existsSync(file) || fresh(skip[k.slug])) continue;
    try {
      console.log(`▶ 생성: ${k.slug}`);
      runGen(k);
      if (fs.existsSync(file)) made++;
    } catch (e) {
      skip[k.slug] = new Date().toISOString().slice(0, 10);
      console.error(`  ↳ 건너뜀(${RETRY_DAYS}일 후 재시도): ${k.slug}`);
    }
  }
  saveSkip(skip);
  console.log(`✓ refill: 신규 ${made}개`);
  return made;
}

function refresh({ count = 1 } = {}) {
  if (count <= 0 || !fs.existsSync(ART)) return 0;
  const byslug = new Map(combos().map(k => [k.slug, k]));
  const stale = fs.readdirSync(ART).filter(f => f.endsWith('.json'))
    .map(f => { const d = JSON.parse(fs.readFileSync(path.join(ART, f), 'utf8')); return { slug: d.slug, at: d._meta?.fetchedAt || d.updated || '' }; })
    .filter(x => byslug.has(x.slug))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(0, count);
  let done = 0;
  for (const x of stale) {
    try { console.log(`▶ 갱신: ${x.slug} (마지막 ${String(x.at).slice(0, 10)})`); runGen(byslug.get(x.slug)); done++; }
    catch (e) { console.error(`  ↳ 갱신 실패(기존 글 유지): ${x.slug} — ${String(e.message).split('\n')[0].slice(0, 160)}`); }
  }
  console.log(`✓ refresh: ${done}개 갱신`);
  return done;
}

if (require.main === module) {
  const n = Number(process.argv[2]) || 3;
  refill({ count: n });
}
module.exports = { refill, refresh, combos, targetYm };
