#!/usr/bin/env node
/**
 * morestayz 정적 글 생성기 (매거진형)
 *  data/articles/<slug>.json + templates/article.template.html → articles/<slug>.html
 *  - 데이터 시각화(여행자 유형 도넛·유형별 막대)는 여기서 인라인 SVG/HTML로 생성($0, 외부 JS 불필요)
 *
 *  node build.js            # 전체
 *  node build.js <slug>     # 특정 글
 */
const fs = require('fs');
const path = require('path');
const agoda = require('./lib/agoda');
const LOCAL = require('./lib/local');

const ROOT = __dirname;
const TPL = fs.readFileSync(path.join(ROOT, 'templates/article.template.html'), 'utf8');
const SPECIAL_TPL = fs.existsSync(path.join(ROOT, 'templates/special.template.html')) ? fs.readFileSync(path.join(ROOT, 'templates/special.template.html'), 'utf8') : '';
const MAG_TPL = fs.existsSync(path.join(ROOT, 'templates/magazine.template.html')) ? fs.readFileSync(path.join(ROOT, 'templates/magazine.template.html'), 'utf8') : '';
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/site.json'), 'utf8'));

// ── 무의존성 Mustache(부분집합) 렌더러 ──
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function lookup(stack, key) {
  if (key === '.') return stack[stack.length - 1];
  const parts = key.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    let value = stack[i], found = true;
    for (const part of parts) {
      if (!value || typeof value !== 'object' || !(part in value)) { found = false; break; }
      value = value[part];
    }
    if (found) return value;
  }
  return undefined;
}
function findClose(tpl, from, name) {
  const re = new RegExp('\\{\\{([#/])\\s*' + name.replace(/\./g, '\\.') + '\\s*\\}\\}', 'g');
  re.lastIndex = from; let depth = 1, m;
  while ((m = re.exec(tpl))) { if (m[1] === '#') depth++; else if (--depth === 0) return { start: m.index, end: re.lastIndex }; }
  throw new Error('unclosed section: ' + name);
}
function render(tpl, stack) {
  const re = /\{\{([#\/]?)(\{?)\s*([\w.]+)\s*\}?\}\}/g;
  let out = '', last = 0, m;
  while ((m = re.exec(tpl))) {
    out += tpl.slice(last, m.index);
    const sigil = m[1], triple = m[2] === '{', name = m[3];
    if (sigil === '#') {
      const close = findClose(tpl, re.lastIndex, name);
      const inner = tpl.slice(re.lastIndex, close.start);
      const val = lookup(stack, name);
      if (Array.isArray(val)) val.forEach(item => out += render(inner, stack.concat([item])));
      else if (val) out += render(inner, stack.concat([typeof val === 'object' ? val : {}]));
      re.lastIndex = close.end; last = close.end; continue;
    }
    const val = lookup(stack, name);
    const s = val == null ? '' : String(val);
    out += triple ? s : escapeHtml(s);
    last = re.lastIndex;
  }
  return out + tpl.slice(last);
}

// ── 데이터 시각화 ──
const TYPE_COLOR = { couple: '#d36c8f', family: '#88a37a', solo: '#6f93b8', friends: '#d2a24c', group: '#9d83b3', business: '#8a8f98' };
const colorOf = k => TYPE_COLOR[k] || '#8a8f98';

// 집계 도넛 + 범례 (여행자 유형 분포)
function aggregateChart(agg, themeKey) {
  if (!agg || !agg.distribution.length) return '';
  const r = 54, cx = 70, cy = 70, sw = 22, C = 2 * Math.PI * r;
  let acc = 0, segs = '';
  for (const d of agg.distribution) {
    const len = (d.pct / 100) * C;
    segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colorOf(d.key)}" stroke-width="${sw}" `
      + `stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    acc += len;
  }
  const top = agg.distribution[0];
  const svg = `<svg viewBox="0 0 140 140" class="donut" role="img" aria-label="여행자 유형 분포">`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"/>`
    + segs
    + `<text x="${cx}" y="${cy - 4}" text-anchor="middle" class="dnum">${top.pct}%</text>`
    + `<text x="${cx}" y="${cy + 14}" text-anchor="middle" class="dlab">${escapeHtml(top.label)}</text></svg>`;
  const legend = agg.distribution.map(d =>
    `<li><span class="dot" style="background:${colorOf(d.key)}"></span>`
    + `<span class="lb${d.key === themeKey ? ' on' : ''}">${escapeHtml(d.label)}</span>`
    + `<span class="pc">${d.pct}%</span></li>`).join('');
  return `<div class="chart"><div class="donutwrap">${svg}</div><ul class="legend">${legend}</ul></div>`;
}

// 호텔별 유형 막대
function typeBars(tt, themeKey) {
  if (!tt || !tt.distribution.length) return '';
  const rows = tt.distribution.map(d => {
    const on = d.key === themeKey ? ' on' : '';
    const rt = d.rating != null ? `<span class="rt">★${d.rating}</span>` : '';
    return `<div class="tbar${on}"><span class="tl">${escapeHtml(d.label)}</span>`
      + `<span class="trk"><i style="width:${d.pct}%;background:${colorOf(d.key)}"></i></span>`
      + `<span class="tp">${d.pct}%</span>${rt}</div>`;
  }).join('');
  return `<div class="types"><div class="tcap">여행자 유형 · 유형별 평점 <span>(실제 리뷰 기준)</span></div>${rows}</div>`;
}

// ── 컨텍스트 ──
// ── 글마다 고유한 intro 생성(중복 보일러플레이트 방지) — JSON 데이터만 사용, 재수집 불필요 ──
function shortName(s) { return String(s || '').split('(')[0].trim(); }
function hashStr(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
const INTRO_OPENERS = [
  '{aud} 여행에서는 어디에 묵느냐가 여행의 절반을 결정합니다.',
  '같은 일정이라도 어떤 숙소를 고르느냐가 평범한 여행과 잊지 못할 여행을 가릅니다.',
  '단 하나의 완벽한 숙소를 고르면 {city} 일정 전체가 자연스럽게 완성됩니다.',
  '{city}는 주소와 객실이 여행의 경험을 크게 좌우하는 곳입니다.',
  '성수기에는 평판 좋은 최고급 숙소가 예상보다 훨씬 빨리 마감됩니다.',
  '실망시키지 않는 숙소는 언제나 깊고 꾸준한 리뷰를 가진 곳입니다.',
  '중요한 여행일수록 검증된 최고급 숙소의 가치는 더 커집니다.',
];
function uniqueIntro(data) {
  const city = data.city || '', mon = data.travelMonthLabel || '', aud = (data.audience || '럭셔리');
  const n = (data.hotels || []).length;
  const top = (data.hotels || [])[0];
  const topType = data.aggregate && data.aggregate.distribution && data.aggregate.distribution[0];
  const opener = INTRO_OPENERS[hashStr(data.slug || city) % INTRO_OPENERS.length].replace('{aud}', aud).replace('{city}', city);
  let s = opener + ' ';
  s += `이번 호에서는 ${mon ? mon + ' 기준 ' : ''}${city}의 ${aud} 숙소 ${n}곳을 비교합니다. 5성급 가운데서도 가장 높은 가격대와 탄탄한 리뷰를 갖춘 호텔·리조트·프라이빗 빌라를 아고다 실데이터로 골랐습니다.`;
  if (topType && topType.pct) s += ` 선정 숙소 리뷰의 약 ${topType.pct}%가 ${topType.label} 여행자의 리뷰로, 실제로 어떤 여행자에게 사랑받는 곳인지 보여줍니다.`;
  if (top && top.score != null) s += ` 데이터 기준 1위는 ${shortName(top.name)}(평점 ${top.score})입니다.`;
  return s;
}

// gen.js가 만든 큐레이션 제목 우선, 없으면 설명형 제목으로 대체
function editorialTitle(data) {
  if (data.title) return data.title;
  const month = data.travelMonthLabel ? ` · ${data.travelMonthLabel}` : '';
  return `${data.city || ''} ${data.audience || '럭셔리'} — 최고급 숙소 큐레이션${month}`;
}

function editorialDescription(data) {
  if (data.metaDescription) return data.metaDescription;
  const count = (data.hotels || []).length;
  return `${data.city} ${data.audience || '럭셔리'} 최고급 숙소 ${count}곳 — 5성급 중에서도 가장 높은 가격대와 풍부한 리뷰를 갖춘 호텔·리조트를 아고다 실데이터로 엄선했습니다.`;
}

function isCurrentOrFuture(data, now = new Date()) {
  const ym = data._meta?.targetMonth || /^(\d{4})-(\d{2})/.exec(String(data.slug || '').match(/\d{4}-\d{2}$/)?.[0] || '')?.[0];
  if (!ym) return true;
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + m >= now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;
}

function buildContext(data) {
  const themeKey = data.theme;
  const hotels = data.hotels.map(h => ({
    ...h,
    reviewCountFmt: h.reviewCountFmt || ('리뷰 ' + Number(h.reviewCount).toLocaleString('ko-KR') + '건'),
    rankBadge: (h.rank === 1 ? '🏆 ' : '') + h.rank + '위',
    rankClass: h.rank === 1 ? 'top' : '',
    hasReviews: Array.isArray(h.reviews) && h.reviews.length > 0,
    hasTypes: !!(h.travelerTypes && h.travelerTypes.distribution && h.travelerTypes.distribution.length),
    typeBarsHtml: typeBars(h.travelerTypes, themeKey),
    img: h.img || data.heroImg,
    hasPrice: !!h.priceKRW || !/unavailable|price varies|가격 변동|확인 불가/i.test(h.priceText || ''),
    priceStatus: h.priceStatus || (/unavailable|price varies|가격 변동/i.test(h.priceText || '') ? '조회 시점 가격 확인 불가' : '조회됨'),
    locationStatus: h.locationStatus || (h.walkMin && h.refLabel ? '조회됨' : '위치 상세 확인 필요'),
    sampleCount: h.travelerTypes?.total || (h.travelerTypes?.distribution || []).reduce((n, d) => n + (d.count || 0), 0),
  }));
  // 로컬 정보: 호텔별 가까운 명소·맛집 + 검증 맛집/꼭 가볼 곳 섹션(1위 숙소 기준 이동 시간)
  const local = LOCAL.loadLocal(data.citySlug);
  hotels.forEach(h => {
    const near = LOCAL.nearestFor(h.geo, local, 3);
    h.nearbyHtml = near.length ? `<div class="nearby"><span class="nb-t">가까운 곳</span>${near.map(x => `<span class="nb-i">${x.icon} ${escapeHtml(x.name)} <b>${x.time}</b></span>`).join('')}</div>` : '';
  });
  const localCtx = LOCAL.localSections(local, hotels);
  const canonical = `https://${SITE.domain}/articles/${data.slug}`;
  const fetchedAt = data.methodology?.fetchedAt || data._meta?.fetchedAt || data.updated;
  const sampleTotal = data.aggregate?.total || 0;
  const title = editorialTitle(data);
  const metaDescription = editorialDescription(data);
  return {
    ...data, title, metaDescription, site: SITE, hotels,
    local: localCtx, hasLocalFood: !!localCtx?.hasFood, hasLocalSpots: !!localCtx?.hasSpots,
    ...(() => { try { const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog', data.citySlug + '.json'), 'utf8')); const n = (c.hotels || []).filter(h => h.score >= 8).length;
      return n >= 3 ? { directoryUrl: `/articles/luxury-hotels-${data.citySlug}`, directoryCount: n } : {}; } catch (_) { return {}; } })(),
    intro: uniqueIntro(data),
    hasAggregate: !!data.aggregate,
    aggregateChartHtml: aggregateChart(data.aggregate, themeKey),
    canonical,
    ogImage: data.heroImg || '',
    adsense: SITE.adsense,
    sourceName: data.methodology?.source || '아고다 citySearch 검색 응답',
    fetchedAtLabel: fetchedAt ? new Date(fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long', timeStyle: 'short' }) + ' (KST)' : '',
    searchCondition: data.methodology?.searchCondition || `${data.travelMonthLabel || ''} 중순 기준 검색 조건`,
    sampleTotal,
    sampleReliability: sampleTotal >= 50 ? '참고 가능한 표본' : '작은 표본 · 경향 참고용',
    sampleNotice: data.methodology?.sampleNotice || '여행자 유형 비중은 전체 리뷰가 아니라 검색 응답에 포함된 리뷰 스니펫 표본을 집계한 값입니다.',
    // 독자용 요금 기준 한 줄(출처·조회 조건·표본 같은 작성자용 정보는 아래 JSON-LD에만)
    rateNote: (() => {
      const md = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? `${+m[2]}월 ${+m[3]}일` : ''; };
      const ci = md(data.methodology?.checkIn), seen = fetchedAt ? md(new Date(new Date(fetchedAt).getTime() + 9 * 3600000).toISOString()) : '';
      const parts = [ci && `${ci} 체크인`, `${data.methodology?.adults || 2}인 1박`, '세금·봉사료 포함 요금', seen && `${seen} 기준`].filter(Boolean);
      return ci ? parts.join(' · ') : '';
    })(),
    robotsContent: isCurrentOrFuture(data) ? 'index,follow,max-image-preview:large' : 'noindex,follow',
    authorName: '올오브트립 데이터 데스크',
    updatedLabel: data.updated || String(fetchedAt || '').slice(0, 10),
    jsonld: JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Article',
      headline: title, description: metaDescription,
      datePublished: data.updated, dateModified: data.updated,
      image: data.heroImg || undefined,
      inLanguage: 'ko-KR',
      author: { '@type': 'Organization', name: '올오브트립 데이터 데스크', url: `https://${SITE.domain}/pages/about.html` },
      publisher: { '@type': 'Organization', name: SITE.name, url: `https://${SITE.domain}/` },
      about: [{ '@type': 'Thing', name: data.city }, { '@type': 'Thing', name: data.audience }],
      isPartOf: { '@type': 'WebSite', name: SITE.name, url: `https://${SITE.domain}/` },
      mainEntityOfPage: canonical,
      isBasedOn: {
        '@type': 'Dataset', name: data.methodology?.source || '아고다 citySearch 검색 응답',
        description: [data.methodology?.searchCondition, data.methodology?.sampleNotice].filter(Boolean).join(' / '),
        dateModified: fetchedAt || undefined,
        variableMeasured: ['세금·봉사료 포함 1박 요금(KRW)', '아고다 누적 평점', '리뷰 수', `여행자 유형 리뷰 표본 ${sampleTotal}건`],
      },
    }).replace(/</g, '\\u003c'),
  };
}

function buildOne(slug) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/articles', slug + '.json'), 'utf8'));
  const html = render(TPL, [buildContext(data)]);
  fs.mkdirSync(path.join(ROOT, 'articles'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'articles', slug + '.html'), html);
  console.log('✓ articles/' + slug + '.html (' + data.hotels.length + '곳)');
}

// ── 국내 특별 기획(에디토리얼) 렌더러 ──
const AGODA_ULLEUNG = agoda.citySearchById(182676);
function buildSpecialContext(data, hotels) {
  hotels = hotels || [];
  const canonical = `https://${SITE.domain}/articles/${data.slug}`;
  const agodaUrl = data.agodaUrl || AGODA_ULLEUNG;
  const faqLd = (data.faq && data.faq.length) ? {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: data.faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  } : null;
  const artLd = {
    '@context': 'https://schema.org', '@type': 'Article',
    headline: data.title, description: data.metaDescription,
    datePublished: data.updated, dateModified: data.updated,
    author: { '@type': 'Organization', name: SITE.name },
    publisher: { '@type': 'Organization', name: SITE.name },
    mainEntityOfPage: canonical,
  };
  const jsonld = JSON.stringify(faqLd ? [artLd, faqLd] : artLd).replace(/</g, '\\u003c');
  const hero = data.hero || {};
  const region = data.region || 'the destination';
  return {
    site: SITE, adsense: SITE.adsense, canonical, jsonld, agodaUrl,
    slug: data.slug, title: data.title, metaDescription: data.metaDescription,
    keywordsCsv: (data.keywords || []).join(', '),
    heroEyebrow: hero.eyebrow || '', heroHeadline: escapeHtml(hero.headline || '').replace(/\n/g, '<br>'), heroSub: hero.sub || '',
    keywords: data.keywords || [],
    intro: data.intro || '',
    sections: data.sections || [],
    stays: (data.stays || []).map(s => ({ ...s, url: s.url || agodaUrl })),
    nearbyFood: (data.nearby && data.nearby.food) || [],
    nearbyCafe: (data.nearby && data.nearby.cafe) || [],
    faq: data.faq || [],
    hotels: hotels,
    hasHotels: hotels.length > 0,
    hotelCount: hotels.length,
    hotelHeading: data.hotelHeading || `🏨 Real stays in ${region}`,
    topCtaText: data.topCtaText || `🏨 Compare the best rates in ${region} →`,
    staysHeading: data.staysHeading || `🏨 Where to stay in ${region}`,
    nearbyHeading: data.nearbyHeading || `🍽️ Dining & cafés near ${region}`,
    faqHeading: data.faqHeading || `❓ Frequently asked questions (${region})`,
    bottomCtaText: data.bottomCtaText || `🏨 Check availability in ${region} →`,
    disc: data.disc || 'Some links are affiliate links and we may earn a commission on bookings, at no extra cost to you. Details about shows, attractions and venues are compiled from publicly available sources and may change over time.',
  };
}
function buildSpecial(fileSlug) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/specials', fileSlug + '.json'), 'utf8'));
  const sidecar = path.join(ROOT, 'data/specials', fileSlug + '.hotels.json');
  let hotels = [];
  if (fs.existsSync(sidecar)) { try { hotels = JSON.parse(fs.readFileSync(sidecar, 'utf8')).hotels || []; } catch (e) {} }
  const html = render(SPECIAL_TPL, [buildSpecialContext(data, hotels)]);
  fs.mkdirSync(path.join(ROOT, 'articles'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'articles', data.slug + '.html'), html);
  console.log('✓ articles/' + data.slug + '.html (특별기획: ' + (data.region || data.slug) + ')');
  return data;
}

// ── 매거진(data/magazine/<slug>.json → articles/<slug>.html) ──
// kind: 'news'(럭셔리 트래블 뉴스) | 'guide'(여행 가이드). 아고다 수집 없이 에디토리얼 본문만으로 빌드.
const MAG_KINDS = {
  news: { catId: 'news', catLabel: '럭셔리 트래블 뉴스', keysLabel: '핵심 요약' },
  guide: { catId: 'insider', catLabel: '럭셔리 여행 가이드', keysLabel: '한눈에 보기' },
};
const koDate = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '';
function magazineRelated(data) {
  const want = new Set(data.relatedCities || []);
  const dir = path.join(ROOT, 'data/articles');
  if (!want.size || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(d => want.has(d.citySlug) && isCurrentOrFuture(d))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .slice(0, 6)
    .map(d => ({ slug: d.slug, emoji: d.emoji, title: editorialTitle(d) }));
}
function buildMagazineContext(data) {
  const kind = MAG_KINDS[data.kind] ? data.kind : 'guide';
  const K = MAG_KINDS[kind];
  const canonical = `https://${SITE.domain}/articles/${data.slug}`;
  const sections = (data.sections || []).map((s, i) => ({ ...s, id: s.id || `s${i + 1}` }));
  const faq = data.faq || [];
  const chars = [data.intro, ...sections.map(s => s.body), ...faq.map(f => f.q + ' ' + f.a)].join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
  const artLd = {
    '@context': 'https://schema.org', '@type': kind === 'news' ? 'NewsArticle' : 'Article',
    headline: data.title, description: data.metaDescription, inLanguage: 'ko-KR',
    datePublished: data.published || data.updated, dateModified: data.updated,
    author: { '@type': 'Organization', name: SITE.name, url: `https://${SITE.domain}/pages/about.html` },
    publisher: { '@type': 'Organization', name: SITE.name, logo: { '@type': 'ImageObject', url: `https://${SITE.domain}/favicon.svg` } },
    mainEntityOfPage: canonical,
    // 출처는 독자 화면이 아니라 구조화 데이터로만 제공
    citation: (data.sources || []).filter(x => x && x.url).map(x => ({ '@type': 'CreativeWork', name: x.name, url: x.url })),
  };
  const faqLd = faq.length ? {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  } : null;
  const related = magazineRelated(data);
  const stays = (data.stays || []).map(s => ({ ...s, url: s.url || agoda.citySearchById(s.cityId) }));
  const sources = (data.sources || []).filter(x => x && x.url);
  return {
    site: SITE, adsense: SITE.adsense, canonical, ...K,
    jsonld: JSON.stringify(faqLd ? [artLd, faqLd] : artLd).replace(/</g, '\\u003c'),
    title: data.title, metaDescription: data.metaDescription, keywordsCsv: (data.keywords || []).join(', '),
    region: data.region || '', eyebrow: data.eyebrow || K.catLabel, sub: data.sub || '',
    isNews: kind === 'news', newsDateLabel: koDate(data.newsDate),
    updatedLabel: koDate(data.updated),
    readMin: Math.max(2, Math.round(chars / 500)),
    intro: data.intro || '',
    keyPoints: data.keyPoints || [], hasKeyPoints: !!(data.keyPoints || []).length,
    sections, showToc: sections.length >= 3,
    stays, hasStays: stays.length > 0, staysHeading: data.staysHeading || `${data.region} 최고급 숙소 비교`,
    related, hasRelated: related.length > 0,
    faq, hasFaq: faq.length > 0,
    sources, hasSources: sources.length > 0,
    disc: data.disc || (kind === 'news'
      ? '공개된 보도자료와 언론 보도를 바탕으로 정리한 기사입니다. 개관일·요금·운영 조건은 변경될 수 있으니 예약 전 호텔 공식 채널에서 최신 정보를 확인하세요. 일부 링크는 제휴 링크로, 예약 시 추가 비용 없이 소정의 수수료를 받을 수 있습니다.'
      : '일부 링크는 제휴 링크로, 예약 시 추가 비용 없이 소정의 수수료를 받을 수 있습니다. 시즌·요금·입국 규정은 바뀔 수 있으니 출발 전 호텔과 항공사, 외교부 해외안전여행 등 공식 채널에서 최신 정보를 확인하세요.'),
  };
}
function buildMagazine(fileSlug) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/magazine', fileSlug + '.json'), 'utf8'));
  const html = render(MAG_TPL, [buildMagazineContext(data)]);
  fs.mkdirSync(path.join(ROOT, 'articles'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'articles', data.slug + '.html'), html);
  console.log('✓ articles/' + data.slug + '.html (매거진: ' + (data.kind || 'guide') + ')');
  return data;
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg) buildOne(arg);
  else {
    const dir = path.join(ROOT, 'data/articles');
    if (fs.existsSync(dir)) fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => buildOne(f.replace(/\.json$/, '')));
  }
}
module.exports = { buildOne, buildSpecial, buildMagazine, MAG_KINDS, buildContext, render, aggregateChart, typeBars, editorialTitle, editorialDescription, isCurrentOrFuture };
