#!/usr/bin/env node
/**
 * morestayz 글 생성기 — 테마(오디언스×시즌) × 도시
 *   node gen.js <themeId> <cityId> <citySlug> [yyyy-mm] [N]
 *   예) node gen.js couple 9590 osaka-namba 2026-08 6
 *
 *  - 선행발행: yyyy-mm(여행 시점) 미지정 시 '현재월+1'을 타깃 → 그 시점 가격으로 수집
 *  - 선별: 테마 preferType(커플/가족/혼행/친구) 적합도 + 가성비
 *  - 시각화 데이터: 여행자 유형 분포·유형별 평점(실데이터)
 * 결과: data/articles/<slug>.json  →  node build.js <slug>
 */
const fs = require('fs');
const path = require('path');
const af = require('./lib/agoda-fetch');
const md = require('./lib/morestaz-data');
const agoda = require('./lib/agoda');
const { qualityForHotel, validateArticle } = require('./lib/content-quality');

const ROOT = __dirname;
const THEMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/themes.json'), 'utf8'));
const MIN_REVIEWS = 30;
// 럭셔리 기준(절대 완화하지 않음): 5성급 + 세금 포함 1박 하한가 + 가격 확인된 정식 호텔·리조트만
const MIN_STAR = 5;
const MIN_PRICE_KRW = Number(process.env.MIN_PRICE_KRW) || 200000;
const PAGES = 3;
const MIN_FRESH = 4;     // 같은 도시 다른 테마와 겹치지 않는 숙소 최소 수
const MAX_OVERLAP = 2;   // 같은 도시 다른 테마 글과 겹쳐도 되는 숙소 수

// 같은 도시의 다른 테마 글에 이미 실린 숙소 ID(자기 자신 글은 제외 — 갱신 시 같은 숙소 유지 가능)
function siblingHotelIds() {
  const dir = path.join(ROOT, 'data/articles');
  const ids = new Set();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    if (f === `${themeId}-${citySlug}.json`) continue;
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (d.citySlug !== citySlug) continue;
    for (const h of d.hotels || []) ids.add(String(h.propertyId));
  }
  return ids;
}

const [themeId, cityId, citySlug, ymArg, nArg] = process.argv.slice(2);
const N = Number(nArg) || 6;
if (!themeId || !cityId || !citySlug) {
  console.error('사용법: node gen.js <themeId> <cityId> <citySlug> [yyyy-mm] [N]');
  process.exit(1);
}
const theme = THEMES.themes.find(t => t.id === themeId);
if (!theme) { console.error('알 수 없는 테마: ' + themeId + ' (가능: ' + THEMES.themes.map(t => t.id).join(', ') + ')'); process.exit(1); }

const pad = n => String(n).padStart(2, '0');

// 타깃 여행월
function targetMonth(ym) {
  if (ym && /^\d{4}-\d{2}$/.test(ym)) { const [y, m] = ym.split('-').map(Number); return { y, m }; }
  const d = new Date(); d.setMonth(d.getMonth() + 1);
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}
function daysUntilMid(y, m) {
  const mid = new Date(Date.UTC(y, m - 1, 15, 12));
  const diff = Math.ceil((mid - Date.now()) / 86400000);
  return Math.max(14, Math.min(330, diff)); // 아고다 가격 조회 가능 범위 내
}
function seasonFor(m) {
  const matches = THEMES.seasons.filter(s => s.months.includes(m));
  if (!matches.length) return null;
  matches.sort((a, b) => a.months.length - b.months.length); // 더 구체적인(연휴 등) 우선
  return matches[0];
}
function pick(arr, i) { return arr[((i % arr.length) + arr.length) % arr.length]; }
const shortName = s => String(s).split('(')[0].trim();

(async () => {
  const tm = targetMonth(ymArg);
  const daysAhead = daysUntilMid(tm.y, tm.m);
  const season = seasonFor(tm.m);
  const travelMonthLabel = `${tm.y}년 ${tm.m}월`;
  console.log(`▶ ${theme.audience} · ${citySlug} · 여행시점 ${travelMonthLabel}(D+${daysAhead}) · top ${N}`);

  // 5성급만·가격 높은 순으로 PAGES페이지 수집
  const cs = await af.fetchCitySearch(Number(cityId), { daysAhead });
  const q = cs._query;
  const rawProps = [...(cs.properties || [])];
  for (let pg = 2; pg <= PAGES; pg++) {
    try { rawProps.push(...((await af.fetchCitySearch(Number(cityId), { daysAhead, page: pg })).properties || [])); }
    catch (e) { console.warn(`  (page ${pg} 실패 — 앞 페이지만 사용)`); }
  }
  const rawCityName = cs?.searchResult?.searchInfo?.objectInfo?.cityName || '';
  // 표시용 도시명은 data/cities.json의 한국어 이름 우선(아고다 도시명은 "호놀룰루 (HI)"처럼 다듬어지지 않은 경우가 있음)
  const cityCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cities.json'), 'utf8')).find(c => c.slug === citySlug);
  const city = (cityCfg && cityCfg.name) || rawCityName.split('/')[0].trim() || citySlug;

  const seenIds = new Set();
  const props = rawProps.map(p => md.mapPropertyRich(p)).filter(h => !seenIds.has(h.propertyId) && seenIds.add(h.propertyId));
  // 시크릿 딜(호텔명 비공개: "○○에 있는 숙소 (5성급)") 제외
  const isSecretDeal = h => /에 있는 숙소|^\d(\.\d)?-star\b|\bin the .+ neighborhood\b/i.test(h.name);
  const eligible = props.filter(h => h.name && h.score != null && h.agodaUrl && h.reviewCount >= MIN_REVIEWS
    && (h.star || 0) >= MIN_STAR && h.priceKRW && h.priceKRW >= MIN_PRICE_KRW
    && h.propertyType === 'Hotel' && !h.isHostListing && h.resultType === 'NormalProperty' // 정식 호텔·리조트만(개인 렌탈·매진·시크릿딜 제외)
    && !isSecretDeal(h));
  if (eligible.length < 3) throw new Error(`5성급·${MIN_PRICE_KRW / 10000}만원+ 숙소 부족(${eligible.length}곳) — 건너뜀`);

  // 어메니티 필터: 테마가 특정 시설을 요구하면 실제 보유 숙소만 선정(부정확한 글 방지)
  function featureMatch(h, req) {
    if (req === 'pool') return !!h.hasKidsPool;
    if (req === 'pet') return (h.featureTitles || []).some(t => /pet|반려|애견|강아지|dog|animal/i.test(String(t)));
    return true;
  }
  let candidates = eligible;
  if (theme.requireFeature) {
    const matched = eligible.filter(h => featureMatch(h, theme.requireFeature));
    if (matched.length < 3) throw new Error(`'${theme.requireFeature}' 보유 숙소 부족(${matched.length}곳) — 건너뜀`);
    candidates = matched;
  }

  // ★ 럭셔리 선정: 최고가 우선 + 리뷰 많은순 + 5성 + 리조트/풀빌라 우선
  // 테마 신호: 이름·시설·리뷰 문구에 테마 키워드가 있으면 가산(themes.json fit)
  const fitRe = theme.fit ? new RegExp(theme.fit.pattern, 'i') : null;
  const themeFit = h => {
    if (!fitRe) return 0;
    const text = [h.name, ...(h.featureTitles || []), ...(h.reviews || []).map(r => r.text)].join(' ');
    return fitRe.test(text) ? theme.fit.weight : 0;
  };
  const isLux = h => /resort|villa|pool ?villa|리조트|빌라|풀빌라|스위트|suite/i.test(
    `${h.accommodationType || ''} ${h.propertyType || ''} ${h.name || ''}`);
  const score = h => {
    const price = h.priceKRW || 0;                       // 최고가 우선(지배적)
    const revs = Math.log10((h.reviewCount || 0) + 1);   // 리뷰 많은순(1~5)
    const star = h.star || 0;
    const aff = md.affinityFor(theme.preferType, h.travelerTypes); // 테마 적합(부가)
    return price * 1.0
      + themeFit(h)
      + revs * 130000        // 리뷰 많을수록 상위
      + star * 150000        // 5성 우대
      + (isLux(h) ? 250000 : 0)  // 리조트/풀빌라/스위트 우대
      + (h.score || 0) * 15000
      + aff * 1500;
  };
  // 같은 도시의 다른 테마 글과 숙소가 겹치지 않게: 겹침은 최대 MAX_OVERLAP곳, 새 숙소가 MIN_FRESH곳 미만이면 이 테마 글은 만들지 않음(중복 콘텐츠 방지)
  // 테마 필수 신호(예: 골프): 테마 키워드가 확인된 숙소가 require곳 미만이면 글을 만들지 않음(부정확한 제목 방지)
  if (theme.fit && theme.fit.require) {
    const n = candidates.filter(h => themeFit(h) > 0).length;
    if (n < theme.fit.require) throw new Error(`'${theme.audience}' 시설 확인 숙소 부족(${n}곳) — 건너뜀`);
    candidates = candidates.filter(h => themeFit(h) > 0);
  }
  const used = siblingHotelIds();
  const ranked = candidates.sort((a, b) => score(b) - score(a));
  const fresh = ranked.filter(h => !used.has(String(h.propertyId)));
  if (fresh.length < MIN_FRESH) throw new Error(`같은 도시 다른 테마와 겹치지 않는 숙소 부족(${fresh.length}곳) — 중복 방지로 건너뜀`);
  const reused = ranked.filter(h => used.has(String(h.propertyId))).slice(0, MAX_OVERLAP);
  const pool = fresh.length >= N ? fresh.slice(0, N) : [...fresh, ...reused].sort((a, b) => score(b) - score(a)).slice(0, N);
  const picked = pool.map((h, i) => ({ ...h, rank: i + 1, isLux: isLux(h) }));

  // 비한국어 리뷰 번역(무료 구글)
  let tr = 0;
  for (const h of picked) for (const r of (h.reviews || [])) {
    if (/[가-힣]/.test(r.text)) continue;
    const ko = await af.translateToKo(r.text);
    if (ko && /[가-힣]/.test(ko)) { r.original = r.text; r.text = ko; r.translated = true; tr++; }
    await new Promise(res => setTimeout(res, 120));
  }
  if (tr) console.log(`  ↳ 리뷰 ${tr}건 번역`);

  // 집계 여행자 유형(이 글의 숙소 전체)
  const aggAcc = {};
  for (const h of picked) for (const d of (h.travelerTypes?.distribution || [])) {
    const a = aggAcc[d.key] || (aggAcc[d.key] = { key: d.key, label: d.label, count: 0 });
    a.count += d.count;
  }
  const aggArr = Object.values(aggAcc);
  const aggTotal = aggArr.reduce((n, g) => n + g.count, 0);
  const aggregate = aggTotal ? {
    total: aggTotal,
    distribution: aggArr.map(g => ({ ...g, pct: Math.round(g.count / aggTotal * 100) }))
      .sort((a, b) => b.count - a.count),
  } : null;

  // 제목/메타/본문
  const hook = pick(theme.hooks, Number(cityId) + tm.m);
  const title = theme.titlePattern.replace('{city}', city).replace('{hook}', hook);
  const top = picked[0];
  const topPrice = (top.priceText.split('·')[1] || '').trim();
  const themeShareTxt = aggregate
    ? (() => { const g = aggregate.distribution.find(d => d.key === theme.preferType); return g ? `이 숙소들의 리뷰 중 약 ${g.pct}%가 ${g.label} 여행자의 리뷰입니다. ` : ''; })()
    : '';
  const verdict = `${themeShareTxt}${theme.audience} 기준 1순위는 <b>${shortName(top.name)}</b>입니다 (평점 ${top.score} · 리뷰 ${Number(top.reviewCount).toLocaleString('ko-KR')}건${topPrice ? ` · ${topPrice.trim()}` : ''}). ${theme.viewpoint}`;

  const hotels = picked.map(h => {
    const tt = h.travelerTypes;
    const tags = [];
    if (h.priceKRW) tags.push('💰 1박 약 ' + Math.round(h.priceKRW / 10000).toLocaleString('ko-KR') + '만원');
    tags.push('📝 리뷰 ' + Number(h.reviewCount).toLocaleString('ko-KR') + '건');
    if (h.star) tags.push('⭐ ' + h.star + '성급');
    if (h.isLux) tags.push('🏝️ 리조트·빌라');
    if (tt?.topLabel) tags.push('👥 ' + tt.topLabel + ' 선호');
    const refLabel = h.refLandmark || '중심가';
    const prefGroup = tt ? (tt.distribution.find(d => d.key === theme.preferType) || {}) : null;
    const typeTxt = prefGroup && prefGroup.pct ? `${prefGroup.label} 리뷰 비중 ${prefGroup.pct}%` : '';
    const blurb = `평점 ${h.score} · 리뷰 ${Number(h.reviewCount).toLocaleString('ko-KR')}건.${h.walkMin ? ` ${refLabel}까지 도보 ${h.walkMin}분,` : ''} ${h.priceText}.${typeTxt ? ' ' + typeTxt + '.' : ''}`;
    const hotel = {
      rank: h.rank, name: h.name, agodaUrl: h.agodaUrl,
      img: h.img ? 'https:' + h.img.replace(/^https?:/, '') : '',
      score: h.score, reviewCount: h.reviewCount,
      reviewCountFmt: '리뷰 ' + Number(h.reviewCount).toLocaleString('ko-KR') + '건',
      priceText: h.priceText, walkMin: h.walkMin, refLabel,
      star: h.star || null,
      propertyId: h.propertyId,
      geo: h.geo && h.geo.latitude ? { lat: +Number(h.geo.latitude).toFixed(6), lng: +Number(h.geo.longitude).toFixed(6) } : null,
      priceKRW: h.priceKRW || null,
      priceStatus: h.priceKRW ? '조회됨' : '조회 시점 가격 확인 불가',
      distanceM: h.distanceM ?? null,
      locationStatus: h.distanceM != null && h.refLandmark ? '조회됨' : '위치 상세 확인 필요',
      facilities: h.featureTitles || [],
      blurb, metaTags: tags,
      travelerTypes: tt ? { topLabel: tt.topLabel, topPct: tt.topPct, distribution: tt.distribution } : null,
      reviews: (h.reviews || []).map(r => ({
        text: r.text, score: r.rating != null ? String(r.rating) : '★',
        country: r.country || '', date: r.date || '', translated: !!r.translated,
      })),
    };
    hotel.quality = qualityForHotel(hotel);
    return hotel;
  });

  const heroImg = hotels[0].img || '';
  const slug = `${theme.id}-${citySlug}`; // 도시×테마당 1개 글 — 매 갱신마다 같은 주소에 최신 요금·순위 반영
  const data = {
    slug, theme: theme.id, audience: theme.audience, emoji: theme.emoji,
    city, citySlug, cityId: Number(cityId),
    cityUrl: agoda.citySearchById(Number(cityId)),
    season: season?.label || '', seasonNote: season?.note || '',
    travelMonthLabel,
    title,
    metaDescription: `${travelMonthLabel} ${city} ${theme.audience} — 5성급 중에서도 가장 높은 가격대와 풍부한 실제 리뷰를 갖춘 최고급 호텔·리조트 ${hotels.length}곳을 아고다 실데이터로 엄선했습니다. 1박 요금·평점·투숙객 유형까지 비교하세요.`,
    intro: theme.intro, viewpoint: theme.viewpoint, verdict,
    aggregate,
    heroImg, heroAlt: `${city} ${theme.audience} 최고급 숙소`,
    updated: new Date().toISOString().slice(0, 10),
    hotels,
    methodology: {
      source: '아고다 citySearch 검색 응답',
      fetchedAt: new Date().toISOString(),
      searchCondition: `5성급 한정 · 성인 ${q.adults}명 · 객실 1개 · 1박 · 체크인 ${q.checkIn} · 원화(세금·봉사료 포함)`,
      checkIn: q.checkIn, adults: q.adults,
      sampleNotice: '여행자 유형 비중은 전체 리뷰가 아니라 검색 응답에 포함된 리뷰 스니펫 표본을 집계한 값입니다.',
    },
    _meta: { fetchedAt: new Date().toISOString(), source: 'agoda citySearch', daysAhead, targetMonth: `${tm.y}-${pad(tm.m)}`, count: hotels.length },
  };

  const validation = validateArticle(data);
  data._meta.quality = validation;
  if (!validation.ok) throw new Error('품질 검증 실패: ' + validation.errors.join(' / '));

  const outPath = path.join(ROOT, 'data/articles', slug + '.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`✓ data/articles/${slug}.json (${hotels.length}곳, 테마=${theme.id}, city="${city}")`);
  console.log('  다음: node build.js ' + slug);
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
