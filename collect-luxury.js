#!/usr/bin/env node
/**
 * 럭셔리 호텔 카탈로그 수집 — 도시별 5성급 전체(가격 높은 순 최대 PAGES페이지)를 data/catalog/<slug>.json에 저장
 *  - 핫리스트(세계·지역·브랜드 TOP)와 도시 총람의 원천 데이터
 *  - 정식 호텔만(개인 렌탈·시크릿 딜·매진·비라틴 이름 제외), 가격 확인된 곳만
 *  - 브랜드 자동 인식, 아고다 '베스트셀러' 배지 기록
 *  node collect-luxury.js [slug]      (STALE_DAYS일 지난 도시만, MAX_CITIES개까지)
 */
const fs = require('fs');
const path = require('path');
const af = require('./lib/agoda-fetch');
const { safeImg } = require('./lib/safe-url');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'data/catalog');
const CITIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cities.json'), 'utf8'));
const PAGES = Number(process.env.PAGES) || 5;
const MIN_KRW = Number(process.env.CATALOG_MIN_KRW) || 200000;
const STALE_DAYS = process.env.STALE_DAYS != null ? Number(process.env.STALE_DAYS) : 6;
const MAX_CITIES = Number(process.env.MAX_CITIES) || 999;

// 럭셔리 브랜드(이름 기준). 순서 = 우선 매칭
const BRANDS = [
  ['aman', '아만', /\baman(?!o)|amanpuri|amankila|amandari|amanoi|amanyara|amangiri|amanzoe|amanemu|amanvari/i],
  ['four-seasons', '포시즌스', /four seasons/i],
  ['rosewood', '로즈우드', /rosewood/i],
  ['ritz-carlton-reserve', '리츠칼튼 리저브', /ritz[- ]carlton reserve|, a ritz-carlton reserve/i],
  ['ritz-carlton', '리츠칼튼', /ritz[- ]carlton/i],
  ['bulgari', '불가리', /bulgari|bvlgari/i],
  ['capella', '카펠라', /capella/i],
  ['six-senses', '식스센스', /six senses/i],
  ['mandarin-oriental', '만다린 오리엔탈', /mandarin oriental/i],
  ['peninsula', '페닌슐라', /the peninsula|peninsula (hong kong|tokyo|bangkok|paris|london|new york|beverly)/i],
  ['park-hyatt', '파크 하얏트', /park hyatt/i],
  ['st-regis', '세인트 레지스', /st\.? regis/i],
  ['waldorf-astoria', '월도프 아스토리아', /waldorf astoria/i],
  ['raffles', '래플스', /raffles/i],
  ['one-and-only', '원앤온리', /one ?& ?only/i],
  ['banyan-tree', '반얀트리', /banyan tree/i],
  ['anantara', '아난타라', /anantara/i],
  ['soneva', '소네바', /soneva/i],
  ['cheval-blanc', '슈발 블랑', /cheval blanc/i],
  ['oetker', '외트커 컬렉션', /h[oô]tel du cap|le bristol|the lanesborough|eden rock|palais namaskar|jumby bay/i],
  ['jumeirah', '주메이라', /jumeirah|burj al arab/i],
  ['conrad', '콘래드', /conrad/i],
  ['intercontinental', '인터컨티넨탈', /intercontinental/i],
  ['shangri-la', '샹그릴라', /shangri-la/i],
  ['w-hotels', 'W 호텔', /^w\s|\bw (hotel|resort|retreat)/i],
  ['jw-marriott', 'JW 메리어트', /jw marriott/i],
  ['hoshinoya', '호시노야', /hoshinoya/i],
  ['como', '코모', /\bcomo\b/i],
];
function brandOf(name) {
  for (const [id, label, re] of BRANDS) if (re.test(name)) return { id, label };
  return null;
}

const isSecretDeal = n => /에 있는 숙소|^\d(\.\d)?-star\b|\bin the .+ neighborhood\b/i.test(n);
const daysAhead = () => 45;

async function collect(c) {
  const seen = new Set(), out = [];
  let cityName = '', checkIn = '';
  for (let page = 1; page <= PAGES; page++) {
    let cs;
    try { cs = await af.fetchCitySearch(Number(c.cityId), { page, daysAhead: daysAhead() }); }
    catch (e) { if (page === 1) throw e; break; }
    if (page === 1) { cityName = cs?.searchResult?.searchInfo?.objectInfo?.cityName || ''; checkIn = cs?._query?.checkIn || ''; }
    const props = cs.properties || [];
    if (!props.length) break;
    for (const p of props) {
      if (seen.has(p.propertyId)) continue; seen.add(p.propertyId);
      const h = af.mapProperty(p);
      if (!h.name || (h.star || 0) < 5 || !h.priceKRW || h.priceKRW < MIN_KRW) continue;
      if (h.propertyType !== 'Hotel' || h.isHostListing || h.resultType !== 'NormalProperty') continue;
      if (isSecretDeal(h.name)) continue;
      if ((h.reviewCount || 0) < 30 || h.score == null) continue;
      const tsp = (p.enrichment?.topSellingPoint || []).map(t => t && t.tspType);
      const brand = brandOf(h.name);
      out.push({
        propertyId: h.propertyId, name: h.name, agodaUrl: h.agodaUrl,
        img: safeImg(h.img ? 'https:' + String(h.img).replace(/^https?:/, '') : ''),
        star: h.star, score: h.score, reviewCount: h.reviewCount, priceKRW: h.priceKRW,
        brand: brand ? brand.id : null, brandLabel: brand ? brand.label : null,
        bestSeller: tsp.includes('BestSeller'),
        geo: h.geo && h.geo.latitude ? { lat: +Number(h.geo.latitude).toFixed(6), lng: +Number(h.geo.longitude).toFixed(6) } : null,
        refLandmark: h.refLandmark || null,
      });
    }
  }
  out.sort((a, b) => b.reviewCount - a.reviewCount);
  return { slug: c.slug, city: c.name, region: c.region, cityId: c.cityId, agodaCityName: cityName,
    fetchedAt: new Date().toISOString(), checkIn, basis: '성인 2명 · 객실 1개 · 1박 · 세금·봉사료 포함(원화)', hotels: out };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.argv[2];
  const stale = c => {
    try { const d = JSON.parse(fs.readFileSync(path.join(OUT, c.slug + '.json'), 'utf8')); return (Date.now() - Date.parse(d.fetchedAt)) / 86400000 >= STALE_DAYS; }
    catch (_) { return true; }
  };
  const targets = CITIES.filter(c => only ? c.slug === only : stale(c)).slice(0, MAX_CITIES);
  let n = 0;
  for (const c of targets) {
    try {
      const d = await collect(c);
      if (!d.hotels.length) { console.warn(`✗ ${c.slug}: 조건 맞는 5성급 0곳 — 기존 유지`); continue; }
      fs.writeFileSync(path.join(OUT, c.slug + '.json'), JSON.stringify(d, null, 1) + '\n');
      n++; console.log(`✓ ${c.slug}: 5성급 ${d.hotels.length}곳 (브랜드 ${d.hotels.filter(h => h.brand).length} · 베스트셀러 ${d.hotels.filter(h => h.bestSeller).length})`);
    } catch (e) { console.error(`✗ ${c.slug}: ${String(e.message).slice(0, 120)}`); }
  }
  console.log(`✓ 카탈로그 갱신 ${n}개 도시`);
})();
