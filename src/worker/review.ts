import { jstDayString, DAY_MS } from '../shared/srs';

/** Insert the attempt and apply it in a single D1 transaction. Replays never apply twice. */
export async function recordReview(db: D1Database, input: {
  wordId: string; requestId: string; mode: 'card'|'cloze'|'recall';
  rating: 'known'|'unknown'; assisted: boolean; retry: boolean;
  targetCount: number; intervalDays: number; now: number;
}): Promise<{ applied: boolean; gained: boolean }> {
  const recall = input.mode === 'recall';
  const count = recall ? 'recall_count' : 'known_count';
  const day = recall ? 'recall_reviewed_day' : 'known_reviewed_day';
  const today = jstDayString(input.now);
  const success = input.rating === 'known';
  const next = success ? input.now + input.intervalDays * DAY_MS : input.now;
  const gain = '(SELECT gained FROM review_events WHERE id = ?)';
  const result = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO review_events
      (id, word_id, rating, mode, assisted, gained, review_count_after, reviewed_at, next_review_at)
      SELECT ?, id, ?, ?, ?, gain,
        MAX(known_count + ${recall ? '0' : 'gain'}, recall_count + ${recall ? 'gain' : '0'}), ?, ?
      FROM (SELECT *, CASE WHEN ? = 1 AND ? = 0 AND COALESCE(${day}, '') <> ? AND ${count} < ?
        THEN 1 ELSE 0 END AS gain FROM words WHERE id = ?)`)
      .bind(input.requestId, input.rating, input.mode, input.assisted ? 1 : 0, input.now, next,
        success ? 1 : 0, input.retry ? 1 : 0, today, input.targetCount, input.wordId),
    db.prepare(`UPDATE words SET
      ${count} = ${count} + ${gain},
      ${day} = CASE WHEN ? = 1 AND ? = 0 THEN ? ELSE ${day} END,
      review_count = MAX(known_count + ${recall ? '0' : gain}, recall_count + ${recall ? gain : '0'}),
      mastered = MAX(mastered, CASE WHEN MAX(known_count + ${recall ? '0' : gain}, recall_count + ${recall ? gain : '0'}) >= ? THEN 1 ELSE 0 END),
      next_review_at = CASE WHEN ${input.retry ? 1 : 0} = 1 THEN next_review_at ELSE ? END, last_reviewed_at = ?, updated_at = ?
      WHERE id = ? AND changes() = 1`)
      .bind(input.requestId, success ? 1 : 0, input.retry ? 1 : 0, today,
        input.requestId, input.requestId, input.targetCount, next, input.now, input.now, input.wordId),
  ]);
  const event = await db.prepare('SELECT gained FROM review_events WHERE id = ? AND word_id = ?')
    .bind(input.requestId, input.wordId).first<{gained: number}>();
  const applied = Number(result[0].meta.changes) > 0;
  return { applied, gained: Boolean(event?.gained) };
}
