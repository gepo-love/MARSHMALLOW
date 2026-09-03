function clean(value = '', max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function anchorFromResidence(residence = {}, life = {}) {
  const city = clean(residence.realCityMap || residence.city || '', 40);
  const area = clean(residence.area || '', 80);
  const label = clean(residence.label || life.homeDetails || '住处', 80);
  const query = clean(residence.mapQuery || residence.label || residence.area || '', 120);
  if (!city && !area && !label && !query) return null;
  return {
    id: 'home',
    kind: 'home',
    label,
    resolveMode: query ? 'area_only' : 'ai_virtual',
    area,
    query,
    location: null,
    address: null,
    base: true,
    locked: false,
    confidence: query ? 0.55 : 0.25,
    source: 'residenceAnchor',
  };
}

export function normalizeLocationProfile(character = {}) {
  const raw = character.locationProfile && typeof character.locationProfile === 'object'
    ? character.locationProfile
    : {};
  const residence = character.residenceAnchor && typeof character.residenceAnchor === 'object'
    ? character.residenceAnchor
    : {};
  const life = character.lifeProfile && typeof character.lifeProfile === 'object'
    ? character.lifeProfile
    : {};
  const cityName = clean(raw.city?.name || residence.realCityMap || residence.city || '', 40);
  const anchors = asArray(raw.anchors).filter(Boolean);
  const home = anchorFromResidence(residence, life);
  const hasHome = anchors.some((a) => a?.kind === 'home' || a?.id === 'home');
  return {
    mode: ['real', 'semi', 'virtual'].includes(raw.mode) ? raw.mode : 'semi',
    mapEnabled: raw.mapEnabled !== false,
    city: raw.city && typeof raw.city === 'object'
      ? { ...raw.city, name: clean(raw.city.name || cityName, 40) }
      : { name: cityName, adcode: '', center: null },
    region: clean(raw.region || residence.area || '', 80),
    anchors: [
      ...anchors,
      ...(home && !hasHome ? [home] : []),
    ].map((item, index) => ({
      id: clean(item.id || `anchor_${index + 1}`, 40),
      kind: clean(item.kind || 'hangout', 24),
      label: clean(item.label || item.name || '', 80),
      resolveMode: clean(item.resolveMode || 'area_only', 32),
      area: clean(item.area || '', 80),
      query: clean(item.query || item.mapQuery || '', 120),
      location: item.location || null,
      address: item.address || null,
      base: item.base === true,
      locked: item.locked === true,
      confidence: Number(item.confidence || 0) || 0,
      source: clean(item.source || '', 40),
    })),
    lifestyle: {
      identity: clean(raw.lifestyle?.identity || character.currentRole || '', 80),
      incomeTier: clean(raw.lifestyle?.incomeTier || '', 40),
      commute: clean(raw.lifestyle?.commute || '', 80),
      hobbies: asArray(raw.lifestyle?.hobbies).map((x) => clean(x, 40)).filter(Boolean).slice(0, 12),
      radiusKm: Number(raw.lifestyle?.radiusKm || 0) || 0,
    },
  };
}

export function getBaseLocationAnchor(profile = {}) {
  return asArray(profile.anchors).find((a) => a?.base)
    || asArray(profile.anchors).find((a) => a?.kind === 'home')
    || asArray(profile.anchors)[0]
    || null;
}

export function describeLocationAnchor(anchor = {}) {
  return [anchor.label, anchor.area, anchor.query].map((x) => clean(x, 80)).filter(Boolean).join(' · ');
}
