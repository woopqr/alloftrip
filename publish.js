#!/usr/bin/env node
/**
 * 올오브트립 발행 — 하루 1회 묶음 배포(빌드 절약: 1 push = 1 build)
 *  1) auto-fetch.refill 로 신규 글 BATCH개 생성
 *  2) build-all.rebuildAll 로 전체 재빌드 + index/sitemap 갱신
 *  GitHub Actions가 변경분을 1커밋으로 push → Cloudflare 빌드 1회
 *
 *  env: BATCH — 회당 신규 글 수, REFRESH(기본 1) — 회당 갱신할 가장 오래된 글 수
 */
const { execSync } = require('child_process');
const { refill, refresh } = require('./auto-fetch');
const { rebuildAll } = require('./build-all');

const parsedBatch = Number(process.env.BATCH);
const BATCH = Number.isFinite(parsedBatch) ? Math.max(0, parsedBatch) : 0;
const parsedRefresh = Number(process.env.REFRESH);
const REFRESH = Number.isFinite(parsedRefresh) ? Math.max(0, parsedRefresh) : 1;

(async function main() {
  const made = refill({ count: BATCH });
  refresh({ count: REFRESH });
  // 럭셔리 카탈로그(핫리스트·브랜드 모음 원천) 순환 갱신 — 6일 지난 도시 7곳씩
  try { execSync('node collect-luxury.js', { cwd: __dirname, stdio: 'inherit', timeout: 600000, env: { ...process.env, MAX_CITIES: process.env.CATALOG_CITIES || '7' } }); }
  catch (e) { console.error('카탈로그 갱신 실패(기존 유지): ' + String(e.message).slice(0, 120)); }
  try { await require('./observe-prices').observe(); }
  catch (e) { console.error('가격 관찰 실패(기존 데이터 유지): ' + String(e.message).slice(0, 160)); }
  // 특별기획(국내) 숙소 실시간 수집 — cityId 있는 특별글만, 실패해도 계속
  try { execSync('node gen-special.js', { cwd: __dirname, stdio: 'inherit', timeout: 180000 }); }
  catch (e) { console.error('특별기획 수집 실패(건너뜀): ' + String(e.message).slice(0, 120)); }
  const metas = rebuildAll();
  console.log(`✓ publish 완료: 신규 ${made}개 · 전체 ${metas.length}개`);
})().catch(e => { console.error(e); process.exit(1); });
