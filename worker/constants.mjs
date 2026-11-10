// A claim on a queue row that is older than this was abandoned (closed tab,
// sleeping laptop) and may be taken by someone else. storage.js keeps the
// same number under the same name for the "Stuck" badge. Keep them equal.
//
// In its own file because a Worker's main file may only export its handlers.
export const STALE_CLAIM_MINUTES = 10;
