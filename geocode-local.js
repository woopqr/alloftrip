#!/usr/bin/env node
/**
 * data/local/<slug>.json 장소 좌표 채우기 — OpenStreetMap Nominatim(정책: 1초 1회, 식별 UA)
 *  - lat/lng가 이미 있으면 건너뜀(수동 검증값 우선)
 *  - 기준점(도시 중심) 반경 MAX_KM 밖 결과는 오탐으로 보고 버림
 *  - 로컬에서 1회 실행(Actions에서는 실행하지 않음): node geocode-local.js [slug]
 */
const fs = require('fs');
const path = require('path');
const { distM } = require('./lib/local');

const ROOT = __dirname;
const DIR = path.join(ROOT, 'data/local');
const UA = 'AllOfTrip-geocoder/1.0 (+https://alloftrip.com/pages/contact.html)';
const MAX_KM = Number(process.env.MAX_KM) || 120;
const CITY_EN = { tokyo: 'Tokyo', kyoto: 'Kyoto', okinawa: 'Okinawa', niseko: 'Niseko', honolulu: 'Honolulu', 'maui-wailea': 'Maui', guam: 'Guam', hongkong: 'Hong Kong', dubai: 'Dubai', 'abu-dhabi': 'Abu Dhabi', bangkok: 'Bangkok', singapore: 'Singapore', danang: 'Da Nang', 'phu-quoc': 'Phu Quoc', bali: 'Bali', phuket: 'Phuket', 'koh-samui': 'Koh Samui', langkawi: 'Langkawi', paris: 'Paris', london: 'London', rome: 'Rome', nice: 'Nice', amalfi: 'Amalfi', santorini: 'Santorini', zermatt: 'Zermatt', 'new-york': 'New York', cancun: 'Cancun', tulum: 'Tulum' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function search(q) {
  const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  const j = await r.json();
  await sleep(1100);
  return j[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon), display: j[0].display_name } : null;
}

// 도시 기준점: 해당 도시 기사들의 호텔 좌표 평균 → 없으면 도시명 지오코딩
async function cityCenter(slug, cityName) {
  const pts = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'data/articles')).filter(f => f.endsWith('.json'))) {
    try { const a = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/articles', f), 'utf8')); if (a.citySlug === slug) (a.hotels || []).forEach(h => h.geo && pts.push(h.geo)); } catch (_) {}
  }
  if (pts.length) return { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
  return cityName ? await search(cityName) : null;
}

async function run(slug) {
  const file = path.join(DIR, slug + '.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cities = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cities.json'), 'utf8'));
  const center = await cityCenter(slug, d.cityQuery || (cities.find(c => c.slug === slug) || {}).name);
  let ok = 0, miss = 0;
  for (const p of [...(d.food || []), ...(d.spots || [])]) {
    if (p.noGeo) continue;   // 도로·구간처럼 한 지점이 아닌 곳은 거리 계산 제외
    if (p.lat != null && p.lng != null) { ok++; continue; }
    const en = CITY_EN[slug] || '';
    const stripPost = a => String(a || '').replace(/〒?\s?\d{3}-\d{4}/, '').replace(/\b\d{5,6}\b/, '').trim();
    // 층·건물명·괄호 설명 제거한 순수 지번 주소(일본식 '1F ○○ Bldg, 3-14-2 Ginza…' 대응)
    const bare = a => String(a || '').replace(/\([^)]*\)/g, '').split(',').map(x => x.trim())
      .filter(x => x && !/(\b\d+F\b|\bB\d+F\b|\d+F[–-]|Bldg|Building|Floor|Square|Brick|Isetan|Rooftop|Honten$)/i.test(x)).join(', ');
    const tries = [[p.nameLocal, p.address].filter(Boolean).join(', '), p.address, stripPost(p.address), bare(p.address), stripPost(bare(p.address)), p.nameLocal && `${String(p.nameLocal).split('(')[0].trim()}, ${en}`, p.nameLocal]
      .filter(Boolean).filter((q, i, a) => a.indexOf(q) === i);
    let hit = null;
    for (const q of tries) {
      try { hit = await search(q); } catch (e) { console.warn('  ! ' + e.message); }
      if (hit && center && distM(center, hit) / 1000 > MAX_KM) { console.warn(`  ↳ 반경 밖(${Math.round(distM(center, hit) / 1000)}km) 무시: ${p.name} ← "${q}"`); hit = null; }
      if (hit) break;
    }
    if (hit) { p.lat = +hit.lat.toFixed(6); p.lng = +hit.lng.toFixed(6); p.geoSource = 'osm'; ok++; }
    else { miss++; console.warn(`  ✗ 좌표 없음: ${p.name}`); }
  }
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  console.log(`✓ ${slug}: 좌표 ${ok}곳 · 실패 ${miss}곳`);
}

(async () => {
  const only = process.argv[2];
  const slugs = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).filter(s => !only || s === only);
  for (const s of slugs) { try { await run(s); } catch (e) { console.error(`✗ ${s}: ${e.message}`); } }
})();
