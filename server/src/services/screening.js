// Team screening logic: combining each reviewer's decisions into a final status,
// finding conflicts, and measuring agreement with Cohen's kappa.

/**
 * decisions: [{ record_key, user_id, status, reason }]
 * resolutions: [{ record_key, status, reason }]
 * Returns Map(record_key -> { status, reason, state }) where state is
 * "resolved" | "agreed" | "single" | "conflict".
 */
export function finalStatuses(decisions, resolutions) {
  const byKey = new Map();
  for (const d of decisions) {
    if (!byKey.has(d.record_key)) byKey.set(d.record_key, []);
    byKey.get(d.record_key).push(d);
  }
  const out = new Map();
  for (const [key, ds] of byKey) {
    const statuses = new Set(ds.map(d => d.status));
    if (statuses.size > 1) out.set(key, { status: "included", reason: null, state: "conflict" });
    else out.set(key, { status: ds[0].status, reason: ds.find(d => d.reason)?.reason || null, state: ds.length > 1 ? "agreed" : "single" });
  }
  for (const r of resolutions) out.set(r.record_key, { status: r.status, reason: r.reason, state: "resolved" });
  return out;
}

/** Cohen's kappa for two reviewers over the records both of them decided. */
export function cohensKappa(a, b) {
  const keys = [...a.keys()].filter(k => b.has(k));
  const n = keys.length;
  if (!n) return { n: 0, agreement: null, kappa: null };
  let agree = 0, aInc = 0, bInc = 0;
  for (const k of keys) {
    const x = a.get(k), y = b.get(k);
    if (x === y) agree++;
    if (x === "included") aInc++;
    if (y === "included") bInc++;
  }
  const po = agree / n;
  const pe = (aInc / n) * (bInc / n) + (1 - aInc / n) * (1 - bInc / n);
  const kappa = pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
  return { n, agreement: round(po), kappa: round(kappa) };
}
const round = x => Math.round(x * 1000) / 1000;

/** Landis & Koch (1977) labels for kappa values. */
export function kappaLabel(k) {
  if (k == null) return null;
  if (k < 0) return "poor";
  if (k <= 0.2) return "slight";
  if (k <= 0.4) return "fair";
  if (k <= 0.6) return "moderate";
  if (k <= 0.8) return "substantial";
  return "almost perfect";
}

/** Agreement for every pair of reviewers who have made decisions. */
export function agreement(decisions, members) {
  const per = new Map(members.map(m => [m.user_id, new Map()]));
  for (const d of decisions) per.get(d.user_id)?.set(d.record_key, d.status);
  const pairs = [];
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
    const r = cohensKappa(per.get(members[i].user_id), per.get(members[j].user_id));
    if (r.n) pairs.push({ a: members[i].user_id, b: members[j].user_id, ...r, label: kappaLabel(r.kappa) });
  }
  return pairs;
}
