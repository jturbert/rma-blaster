-- ============================================================
-- RMA Blaster on D1: purchase date.
-- The date on the invoice, as YYYY-MM-DD. It decides warranty
-- (in or out of the two-year window) and goes on the
-- manufacturer sheet. Read from an attached invoice PDF when
-- possible; typed in by hand otherwise.
-- ============================================================

ALTER TABLE entries ADD COLUMN purchase_date TEXT DEFAULT '';
