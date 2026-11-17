// ============================================================
// RMA Blaster: Change log helpers
//
// The server records who changed which field (see worker/index.mjs).
// This file only turns those rows into something readable. Pure
// functions: no DOM, no database, so the tests can run them directly.
//
// A history row looks like:
//   { id, changed_at, user_email, action, field, old_value, new_value }
//   action: 'created' | 'imported' | 'edited'
//   field:  the database column name (snake_case)
// ============================================================

const Changelog = (() => {
  const LABELS = {
    status: 'Status',                 rma_number: 'RMA #',
    date: 'Date Received',            dealer: 'Dealer',
    make: 'Make / Brand',             model: 'Model',
    serial_number: 'Serial #',        issue_description: 'Description of Issue',
    issue_confirmed: 'Issue Confirmed?', warranty_status: 'Warranty',
    course_of_action: 'Course of Action', date_of_resolution: 'Date of Resolution',
    how_resolved: 'How Resolved',     notes: 'Notes',
    replaced_from: 'Replaced From',   deleted: 'Archived',
    flags: 'Flags'
  };

  // The free-text fields: the ones people write comments in.
  const TEXT_FIELDS = ['issue_description', 'course_of_action', 'how_resolved', 'notes'];

  const label = field => LABELS[field] || field;

  // What one row amounts to, in a shape the UI can print.
  //   kind: 'archived' | 'reinstated' | 'flags' | 'cleared' | 'set' | 'added' | 'changed'
  //   text:     what the field says now (or just the new part, for 'added')
  //   previous: what it said before, when that is worth showing
  function describe(row) {
    const oldV = row.old_value || '';
    const newV = row.new_value || '';
    const out  = { label: label(row.field), kind: 'changed', text: newV, previous: oldV };

    if (row.field === 'deleted') {
      out.kind = newV === 'true' ? 'archived' : 'reinstated';
      out.text = ''; out.previous = '';
    } else if (row.field === 'flags') {
      // Stored as keys; say which flags went on and which came off.
      const was = Flags.parse(oldV), now = Flags.parse(newV);
      const on  = now.filter(k => !was.includes(k)).map(Flags.label);
      const off = was.filter(k => !now.includes(k)).map(Flags.label);
      out.kind = 'flags';
      out.text = [on.length ? 'ticked ' + on.join(', ') : '',
                  off.length ? 'unticked ' + off.join(', ') : ''].filter(Boolean).join('; ');
      out.previous = '';
    } else if (!newV) {
      out.kind = 'cleared';
    } else if (!oldV) {
      out.kind = 'set';
    } else if (TEXT_FIELDS.includes(row.field) && newV.startsWith(oldV)) {
      // Someone typed more underneath what was there. Show only their part,
      // which is the thing you actually want attributed to them.
      out.kind = 'added';
      out.text = newV.slice(oldV.length).trim();
      out.previous = '';
    }
    return out;
  }

  // One save writes several rows with the same timestamp and login.
  // Fold them back into one block per save. Input order is kept.
  function groupBySave(rows) {
    const groups = [];
    for (const r of rows || []) {
      const last = groups[groups.length - 1];
      if (last && last.at === r.changed_at && last.who === r.user_email && last.action === r.action) {
        last.changes.push(r);
      } else {
        groups.push({ at: r.changed_at, who: r.user_email, action: r.action, changes: [r] });
      }
    }
    return groups;
  }

  // Most recent change per field. Expects rows newest first, which is how
  // Storage.getEntryHistory returns them.
  function lastEditors(rows) {
    const out = {};
    for (const r of rows || []) {
      if (!out[r.field]) out[r.field] = { who: r.user_email, at: r.changed_at, action: r.action };
    }
    return out;
  }

  return { label, describe, groupBySave, lastEditors, TEXT_FIELDS };
})();
