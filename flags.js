// ============================================================
// RMA Blaster: Flags
//
// THE single place to add, rename or recolour a flag. The check
// boxes in the entry window, the dots on the dashboard, search and
// the history text all read from here.
//
// Each flag: { key, label, color }
//   key    what is stored in the database. NEVER change a key once
//          it is in use: entries carrying the old one would lose
//          the flag. Change the label instead.
//   label  what people see
//   color  the dot on the dashboard
//
// An entry stores its flags as one comma-separated string of keys,
// e.g. "in-store,needs-repair", in the entries.flags column
// (schema-phase4.sql).
// ============================================================

const Flags = (() => {
  const LIST = [
    { key: 'on-the-way',        label: 'On the way to the store', color: '#eab308' },
    { key: 'in-store',          label: 'In store',                color: '#2563eb' },
    { key: 'needs-repair',      label: 'Needs to be repaired',    color: '#dc2626' },
    { key: 'out-for-repair',    label: 'Out for repair',          color: '#9333ea' },
    { key: 'needs-replacement', label: 'Needs to be replaced',    color: '#ec4899' },
    { key: 'repaired',          label: 'Repaired',                color: '#16a34a' },
    { key: 'replaced',          label: 'Replaced',                color: '#0d9488' },
    { key: 'mystery',           label: 'Mystery',                 color: '#64748b' },
    { key: 'follow-up',         label: 'Follow up',               color: '#06b6d4' },
    // The manufacturer sheet (Settings → Manufacturer Sheet) lists the
    // entries carrying SEND_KEY, and can move them over to SENT_KEY.
    { key: 'send-to-maker',     label: 'Send to manufacturer',    color: '#ea580c' },
    { key: 'sent-to-maker',     label: 'Sent to manufacturer',    color: '#78350f' }
  ];
  const SEND_KEY = 'send-to-maker';
  const SENT_KEY = 'sent-to-maker';

  const BY_KEY = Object.fromEntries(LIST.map(f => [f.key, f]));

  // "a,b" -> ['a','b']. Tolerates blanks, spaces and repeats.
  function parse(str) {
    return [...new Set(String(str || '').split(',').map(s => s.trim()).filter(Boolean))];
  }

  // The flags on an entry that are still in LIST, in LIST order.
  function known(str) {
    const have = new Set(parse(str));
    return LIST.filter(f => have.has(f.key));
  }

  // Build the stored string from the ticked keys. Keys on the entry that
  // are no longer in LIST are carried through untouched, so retiring a flag
  // here does not quietly strip it from old entries on their next save.
  function serialize(checkedKeys, previous) {
    const checked = new Set(checkedKeys);
    const kept    = LIST.filter(f => checked.has(f.key)).map(f => f.key);
    const retired = parse(previous).filter(k => !BY_KEY[k]);
    return [...kept, ...retired].join(',');
  }

  const label  = key => (BY_KEY[key] ? BY_KEY[key].label : key);
  const labels = str => parse(str).map(label);

  const has = (str, key) => parse(str).includes(key);

  // Swap one flag for another on a stored string, keeping the rest.
  function swap(str, fromKey, toKey) {
    const keys = parse(str).filter(k => k !== fromKey && k !== toKey);
    return serialize([...keys, toKey], str);
  }

  return { LIST, parse, known, serialize, label, labels, has, swap, SEND_KEY, SENT_KEY };
})();
