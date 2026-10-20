/** Round-robin across users (oldest due post first within each), so one user cannot starve the others. */
export function pickFair<T extends { user_id: string }>(candidates: T[], limit: number): T[] {
  const byUser = new Map<string, T[]>();
  for (const c of candidates) byUser.set(c.user_id, [...(byUser.get(c.user_id) ?? []), c]);
  const queues = [...byUser.values()];
  const picked: T[] = [];
  for (let round = 0; picked.length < limit; round++) {
    let added = false;
    for (const q of queues) {
      if (q[round] && picked.length < limit) { picked.push(q[round]); added = true; }
    }
    if (!added) break;
  }
  return picked;
}
