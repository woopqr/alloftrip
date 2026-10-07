/**
 * 럭셔리 핫리스트 — data/catalog/*.json(도시별 5성급 전체)으로
 *   세계 TOP 50 · 지역별 TOP 10 · 브랜드별 컬렉션 페이지를 articles/에 생성
 *  - 순위: 누적 리뷰 수(실투숙 리뷰) 기준, 평점 8.5 이상, 1박 40만원+ 5성급만
 *  - 매월 순위 스냅샷(data/hotlist/YYYY-MM.json) 저장 → 전월 대비 ▲▼·NEW
 *  - 주소 고정(매월 같은 URL에서 갱신)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CAT = path.join(ROOT, 'data/catalog');
const HIST = path.join(ROOT, 'data/hotlist');
const MIN_KRW = 1000000, MIN_SCORE = 8.8;          // 세계·지역 순위(최상위급)
const BRAND_MIN_KRW = 400000, BRAND_MIN_SCORE = 8.5; // 브랜드 모음(그 브랜드 전체)
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } };
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const won = n => n >= 10000 ? `${Math.round(n / 10000).toLocaleString('ko-KR')}만원` : `${Number(n).toLocaleString('ko-KR')}원`;
const ym = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

function loadCatalog() {
  if (!fs.existsSync(CAT)) return [];
  const cities = readJson(path.join(ROOT, 'data/cities.json'), []);
  const all = [];
  let latest = '', checkIn = '';
  for (const f of fs.readdirSync(CAT).filter(f => f.endsWith('.json'))) {
    const d = readJson(path.join(CAT, f), null); if (!d) continue;
    const c = cities.find(x => x.slug === d.slug) || {};
    if (String(d.fetchedAt) > latest) { latest = String(d.fetchedAt); checkIn = d.checkIn || checkIn; }
    for (const h of d.hotels || []) all.push({ ...h, citySlug: d.slug, city: c.name || d.city, region: c.region || d.region });
  }
  all.latest = latest; all.checkIn = checkIn;
  return all;
}

// 도시별 대표 기사(맛집·필수 코스가 붙은 글) 링크
function cityArticleMap() {
  const dir = path.join(ROOT, 'data/articles'), map = {};
  if (!fs.existsSync(dir)) return map;
  const pref = ['ultra', 'honeymoon', 'anniversary', 'wellness', 'golf'];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const d = readJson(path.join(dir, f), null); if (!d) continue;
    const cur = map[d.citySlug];
    if (!cur || pref.indexOf(d.theme) < pref.indexOf(cur.theme)) map[d.citySlug] = { slug: d.slug, theme: d.theme };
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, '/articles/' + v.slug]));
}

// 럭셔리 정의: 그 도시 5성급 가운데 요금 상위 30% + 1박 100만원+ + 평점 8.8+ → 그 안에서 누적 리뷰 순
const TOP_SHARE = 0.3;
function rankList(hs) {
  const byCity = {};
  hs.forEach(h => (byCity[h.citySlug] = byCity[h.citySlug] || []).push(h.priceKRW));
  const cut = {};
  for (const [c, ps] of Object.entries(byCity)) { ps.sort((a, b) => b - a); cut[c] = ps[Math.max(0, Math.ceil(ps.length * TOP_SHARE) - 1)]; }
  return hs.filter(h => h.priceKRW >= MIN_KRW && h.score >= MIN_SCORE && h.priceKRW >= cut[h.citySlug])
    .sort((a, b) => b.reviewCount - a.reviewCount || b.score - a.score);
}

function buildHotlists({ render, site, regions }) {
  const TPL = fs.readFileSync(path.join(ROOT, 'templates/hotlist.template.html'), 'utf8');
  const all = loadCatalog();
  if (!all.length) return [];
  const now = new Date(Date.now() + 9 * 3600000);
  const month = ym(now), issueLabel = `${now.getUTCFullYear()}년 ${now.getUTCMonth() + 1}월호`;
  const updatedLabel = String(all.latest).slice(0, 10);
  const cityLinks = cityArticleMap();
  // 지난달 스냅샷(가장 최근의 이전 달)
  fs.mkdirSync(HIST, { recursive: true });
  const prevFile = fs.readdirSync(HIST).filter(f => /^\d{4}-\d{2}\.json$/.test(f) && f < month + '.json').sort().pop();
  const prev = prevFile ? readJson(path.join(HIST, prevFile), {}) : null;
  const snapshot = {};

  const eligible = rankList(all);
  const totalLux = new Set(all.map(h => h.propertyId)).size;
  const cityCount = new Set(all.map(h => h.citySlug)).size;
  const over10k = eligible.filter(h => h.reviewCount >= 10000).length;
  const B = `https://${site.domain}`;
  const brandsAll = {};
  all.filter(h => h.priceKRW >= BRAND_MIN_KRW && h.score >= BRAND_MIN_SCORE).sort((a, b) => b.reviewCount - a.reviewCount)
    .forEach(h => { if (h.brand) (brandsAll[h.brand] = brandsAll[h.brand] || { label: h.brandLabel, items: [] }).items.push(h); });
  const brandIds = Object.keys(brandsAll).filter(id => brandsAll[id].items.length >= 2).sort((a, b) => brandsAll[b].items.length - brandsAll[a].items.length);
  const regionIds = regions.map(r => r.id).filter(id => eligible.some(h => h.region === id));

  const pages = [
    { slug: 'luxury-hotlist-world', key: 'world', label: '세계', list: eligible.slice(0, 50),
      title: `전 세계 럭셔리 여행자가 가장 많이 머문 5성급 호텔 TOP 50 (${issueLabel})`,
      lede: `${cityCount}개 여행지의 5성급 ${totalLux.toLocaleString('ko-KR')}곳을 비교해, 1박 100만 원 이상 각 여행지 최상위급 호텔 가운데 실제 투숙 리뷰가 가장 많이 쌓인 50곳을 골랐습니다.` },
    ...regionIds.map(id => {
      const r = regions.find(x => x.id === id);
      const list = eligible.filter(h => h.region === id).slice(0, 10);
      return { slug: `luxury-hotlist-${id}`, key: 'region:' + id, label: r.label, list,
        title: `${r.label} 럭셔리 호텔 TOP ${list.length} — 가장 많이 머문 5성급 (${issueLabel})`,
        lede: `${r.label}에서 1박 100만 원 이상 최상위급 5성급 가운데 실제 투숙 리뷰가 가장 많은 ${list.length}곳입니다.` };
    }),
    ...brandIds.map(id => {
      const b = brandsAll[id];
      const list = b.items.slice(0, 30);
      const cs = [...new Set(list.map(h => h.city))];
      return { slug: `luxury-brand-${id}`, key: 'brand:' + id, label: b.label, list, brand: true,
        title: `${b.label} 호텔 전 세계 모음 — ${cs.length}개 여행지 ${list.length}곳 (${issueLabel})`,
        lede: `${b.label}의 ${cs.slice(0, 6).join('·')}${cs.length > 6 ? ' 등' : ''} 호텔을 실제 투숙 리뷰가 많은 순서로 모았습니다. 같은 브랜드라도 여행지마다 분위기와 요금이 다릅니다.` };
    }),
  ];

  const navWorld = [{ label: '세계 TOP 50', url: '/articles/luxury-hotlist-world', key: 'world' },
    ...regionIds.map(id => ({ label: regions.find(r => r.id === id).label, url: `/articles/luxury-hotlist-${id}`, key: 'region:' + id }))];
  const navBrand = brandIds.slice(0, 14).map(id => ({ label: brandsAll[id].label, url: `/articles/luxury-brand-${id}`, key: 'brand:' + id }));

  const metas = [];
  for (const pg of pages) {
    if (!pg.list.length) continue;
    const prevRanks = prev && prev[pg.key] || null;
    snapshot[pg.key] = {};
    const items = pg.list.map((h, i) => {
      const rank = i + 1; snapshot[pg.key][h.propertyId] = rank;
      let move = '', moveCls = '';
      if (prevRanks) {
        const p = prevRanks[h.propertyId];
        if (p == null) { move = 'NEW'; moveCls = 'new'; }
        else if (p > rank) { move = `▲${p - rank}`; moveCls = 'up'; }
        else if (p < rank) { move = `▼${rank - p}`; moveCls = 'down'; }
      }
      return { rank, move, moveCls, name: h.name, img: h.img, agodaUrl: h.agodaUrl, city: h.city,
        brandLabel: pg.brand ? '' : h.brandLabel, brandUrl: h.brand && brandIds.includes(h.brand) ? `/articles/luxury-brand-${h.brand}` : '',
        bestSeller: h.bestSeller, reviewsFmt: Number(h.reviewCount).toLocaleString('ko-KR'), score: h.score,
        priceFmt: won(h.priceKRW), cityArticle: cityLinks[h.citySlug] || '' };
    });
    const top = pg.list[0];
    const prices = pg.list.map(h => h.priceKRW).sort((a, b) => a - b);
    const glance = [
      { k: '1위', v: `${top.name.split('(')[0].trim()}(${top.city}) — 누적 리뷰 ${Number(top.reviewCount).toLocaleString('ko-KR')}건, 평점 ${top.score}` },
      { k: '요금 범위', v: `1박 ${won(prices[0])}~${won(prices[prices.length - 1])} (성인 2명, 세금 포함, ${updatedLabel} 확인)` },
      { k: '비교 규모', v: `${cityCount}개 여행지 5성급 ${totalLux.toLocaleString('ko-KR')}곳 중 선정 · 최상위급 후보 ${eligible.length}곳` },
    ];
    const faq = [
      { q: `${pg.label === '세계' ? '전 세계에서' : pg.label + '에서'} 가장 많이 머문 ${pg.brand ? pg.label + ' 호텔' : '럭셔리 호텔'}은 어디인가요?`,
        a: `${updatedLabel} 기준으로 ${top.name.split('(')[0].trim()}(${top.city})이 누적 리뷰 ${Number(top.reviewCount).toLocaleString('ko-KR')}건으로 가장 많습니다. 평점은 ${top.score}점, 1박 요금은 ${won(top.priceKRW)}부터입니다.` },
      { q: '순위는 어떻게 정하나요?', a: '여행지마다 5성급 요금 상위 30%에 드는 최상위급(1박 100만 원 이상, 평점 8.8 이상)만 후보로 삼고, 그 안에서 누적 리뷰 수(실제 투숙 후 작성된 리뷰)가 많은 순으로 정렬했습니다. 매월 같은 기준으로 다시 계산합니다.' },
      { q: '요금은 정확한가요?', a: `아고다에서 성인 2명·객실 1개·1박(체크인 ${all.checkIn || '약 45일 후'}) 기준으로 세금과 봉사료를 포함해 확인한 요금입니다. 날짜에 따라 바뀌므로 예약 전 실시간 요금을 확인하세요.` },
    ];
    const crumbs = [{ name: '홈', url: '/' }, { name: '럭셔리 핫리스트', url: '/articles/luxury-hotlist-world' }, ...(pg.key === 'world' ? [] : [{ name: pg.label, url: '' }])];
    const canonical = `${B}/articles/${pg.slug}`;
    const ld = [
      { '@context': 'https://schema.org', '@type': 'Article', headline: pg.title, description: pg.lede,
        datePublished: '2026-10-08', dateModified: updatedLabel, isBasedOn: 'https://www.agoda.com/',
        author: { '@type': 'Organization', name: '올오브트립 에디터', url: `${B}/pages/about.html` },
        publisher: { '@type': 'Organization', name: site.name, url: `${B}/` }, mainEntityOfPage: canonical, image: top.img || undefined },
      { '@context': 'https://schema.org', '@type': 'ItemList', name: pg.title, numberOfItems: pg.list.length,
        itemListElement: pg.list.map((h, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@type': 'Hotel', name: h.name, image: h.img || undefined,
          starRating: { '@type': 'Rating', ratingValue: h.star || 5 },
          aggregateRating: { '@type': 'AggregateRating', ratingValue: h.score, bestRating: 10, reviewCount: h.reviewCount },
          priceRange: `1박 ${won(h.priceKRW)}부터`, address: { '@type': 'PostalAddress', addressLocality: h.city } } })) },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url ? B + c.url : canonical })) },
      { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
    ];
    const nav = (pg.brand ? navBrand : navWorld).map(n => ({ ...n, cls: n.key === pg.key ? 'on' : '' }));
    const ctx = {
      site, adsense: site.adsense, canonical, title: pg.title, metaDescription: pg.lede.slice(0, 155), lede: pg.lede,
      ogImage: top.img || '', issueLabel, updatedLabel, checkInLabel: all.checkIn || '약 45일 후', glance, faq, items,
      hasNav: nav.length > 1, nav,
      crumbHtml: crumbs.map((c, i) => i === crumbs.length - 1 ? `<span>${esc(c.name)}</span>` : `<a href="${c.url}">${esc(c.name)}</a>`).join(' <span>›</span> '),
      jsonld: JSON.stringify(ld).replace(/</g, '\\u003c'),
    };
    fs.writeFileSync(path.join(ROOT, 'articles', pg.slug + '.html'), render(TPL, [ctx]));
    metas.push({ slug: pg.slug, theme: 'hotlist', title: pg.title, description: pg.lede, audience: '럭셔리 핫리스트', emoji: '🏆',
      city: pg.label, season: issueLabel, travelMonthLabel: '', heroImg: top.img || '', updated: updatedLabel, sortKey: pg.key === 'world' ? '0' : (pg.brand ? '2' : '1'), indexable: true });
  }
  fs.writeFileSync(path.join(HIST, month + '.json'), JSON.stringify(snapshot) + '\n');
  console.log(`✓ 핫리스트: ${metas.length}페이지 (세계 1 · 지역 ${regionIds.length} · 브랜드 ${brandIds.length}) · 비교 ${totalLux}곳`);
  return metas;
}

module.exports = { buildHotlists, loadCatalog };
