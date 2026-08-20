// ============================================================
// RMA Blaster — Known Brands
//
// THE single place to add a brand. Both the PDF parser and the
// email subject parser read from here, so a brand added once is
// recognised everywhere.
//
// Format: [canonicalName, ...aliases]
//   canonicalName — exactly how it should appear in the Brand column
//   aliases       — other spellings that turn up in forms and subjects
// Matching is case-insensitive and longest-alias-first, so a brand
// whose name contains another brand's name still resolves correctly.
// ============================================================

const Brands = (() => {
  const LIST = [
    ['Dan Clark Audio', 'Dan Clark', 'DCA'],
    ['64 Audio',        '64audio'],
    ['Campfire Audio',  'Campfire'],
    ['HiFiMAN',         'Hifiman'],
    ['Meze',            'MEZE'],
    ['Noble Audio',     'Noble'],
    ['Feliks Audio',    'Feliks'],
    ['Questyle'],
    ['LAiV'],
    ['HEDD'],
    ['Shanling'],
    ['Violectric'],
    ['D&A'],
    ['Final'],
    ['Palma'],
    ['DDHifi'],
    ['Lotoo'],
    ['Repeat'],
    ['CANVAS HiFi'],
    ['FiR Audio'],
    ['Viva Audio'],
    ['Yohann'],
  ];

  // Every alias paired with its canonical name, longest alias first.
  // Built once — this used to be rebuilt on every single call.
  const CANDIDATES = LIST
    .flatMap(([canonical, ...aliases]) =>
      [canonical, ...aliases].map(alias => ({ canonical, alias: alias.toLowerCase() })))
    .sort((a, b) => b.alias.length - a.alias.length);

  // Find a known brand anywhere in the text. Returns the canonical
  // name, or '' if nothing matches.
  function detect(text) {
    if (!text) return '';
    const lower = String(text).toLowerCase();
    for (const { canonical, alias } of CANDIDATES) {
      if (lower.includes(alias)) return canonical;
    }
    return '';
  }

  // All spellings of one brand, longest first — used when splitting a
  // run-together "BrandModel" value into its two parts.
  function aliasesFor(canonical) {
    const entry = LIST.find(([name]) => name === canonical);
    const all = entry ? [entry[0], ...entry.slice(1)] : [canonical];
    return all.sort((a, b) => b.length - a.length);
  }

  return { LIST, detect, aliasesFor };
})();
