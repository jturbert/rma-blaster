// ============================================================
// RMA Blaster: what Cloudflare runs (`main` in wrangler.toml).
//
// Two ways in:
//   default  the app and its /api, reached at rma.duneblue.com behind
//            Cloudflare Access (worker/index.mjs)
//   Intake   new RMAs from the Dune Blue site's Worker, reachable ONLY
//            through a service binding on that Worker. It has no address
//            on the internet. (worker/intake.mjs)
//
// Kept apart from index.mjs because 'cloudflare:workers' exists only
// inside Cloudflare, and the tests import index.mjs in plain Node.
// ============================================================

import { WorkerEntrypoint } from 'cloudflare:workers';
import app from './index.mjs';
import { storeSubmission } from './intake.mjs';

export class Intake extends WorkerEntrypoint {
  submit(mail) {
    return storeSubmission(this.env, mail);
  }
}

export default app;
