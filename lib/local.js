/**
 * 여행지 로컬 정보(검증 맛집·카페 + 꼭 가볼 곳) — data/local/<citySlug>.json
 *  - 호텔 좌표(아고다 geo)와 장소 좌표로 직선거리 → 실제 동선 근사(×1.35) → 도보/차량 소요 시간 추정
 *  - 추정치임을 화면에 명시(실제 교통 상황에 따라 다름)
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'local');
const cache = new Map();

function loadLocal(slug) {
  if (!slug) return null;
  if (cache.has(slug)) return cache.get(slug);
  let d = null;
  try { d = JSON.parse(fs.readFileSync(path.join(DIR, slug + '.json'), 'utf8')); } catch (_) {}
  cache.set(slug, d);
  return d;
}

function distM(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 직선거리(m) → { mode, min, label }
function travel(m) {
  if (m == null) return null;
  const road = m * 1.35;
  const walk = Math.max(1, Math.round(road / 75));          // 도보 4.5km/h
  if (walk <= 20) return { mode: 'walk', min: walk, label: `도보 약 ${walk}분` };
  const km = road / 1000;
  const drive = Math.round(km < 30 ? km / 25 * 60 + 5 : km / 55 * 60 + 10);
  if (drive >= 120) return { mode: 'trip', min: drive, label: `차로 약 ${Math.round(drive / 30) / 2}시간(당일 일정)` };
  return { mode: 'drive', min: drive, label: `차로 약 ${drive}분` };
}

const ICON = { restaurant: '🍽️', cafe: '☕', dessert: '🍰', bakery: '🥐', bar: '🍸', shopping: '🛍️', market: '🧺', landmark: '🏛️', street: '🚶', nightlife: '🌃', experience: '✨', nature: '🌿' };
const mapUrl = p => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([p.nameLocal || p.name, p.address].filter(Boolean).join(' '))}`;

// 호텔 1곳 기준 가장 가까운 장소 n곳(맛집+명소)
function nearestFor(geo, local, n = 3) {
  if (!geo || !local) return [];
  const all = [...(local.spots || []).map(p => ({ ...p, cat: 'spot' })), ...(local.food || []).map(p => ({ ...p, cat: 'food' }))]
    .filter(p => p.lat != null)
    .map(p => ({ p, d: distM(geo, p) }))
    .filter(x => x.d != null && travel(x.d).min <= 60)
    .sort((a, b) => a.d - b.d);
  // 명소 2 + 맛집 1 우선 조합
  const spots = all.filter(x => x.p.cat === 'spot').slice(0, 2), food = all.filter(x => x.p.cat === 'food').slice(0, 1);
  return [...spots, ...food].sort((a, b) => a.d - b.d).slice(0, n)
    .map(({ p, d }) => ({ icon: ICON[p.kind || p.type] || '📍', name: p.name, time: travel(d).label }));
}

// 기사용 로컬 섹션 데이터 — 장소마다 '글에 실린 숙소 중 가장 가까운 곳' 기준 이동 시간
function localSections(local, hotels) {
  if (!local) return null;
  const hs = (hotels || []).filter(h => h.geo);
  const short = n => String(n || '').split('(')[0].trim();
  const decorate = p => {
    let best = null;
    if (p.lat != null) for (const h of hs) { const d = distM(h.geo, p); if (d != null && (!best || d < best.d)) best = { d, h }; }
    const t = best ? travel(best.d) : null;
    return { ...p, icon: ICON[p.kind || p.type] || '📍', timeLabel: t ? `${short(best.h.name)}에서 ${t.label}` : '', mapUrl: mapUrl(p),
      proof: (p.proof || []).filter(x => x && x.label).map(x => ({ ...x, hasUrl: !!x.url })) };
  };
  const food = (local.food || []).filter(p => (p.proof || []).some(x => x && x.url)).map(decorate);
  const spots = (local.spots || []).map(decorate);
  return { food, spots, hasFood: food.length > 0, hasSpots: spots.length > 0 };
}

module.exports = { loadLocal, distM, travel, nearestFor, localSections, mapUrl };
