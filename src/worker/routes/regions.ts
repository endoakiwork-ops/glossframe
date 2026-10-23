import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError } from '../errors';
import { parseBody } from '../validate';
import { imageUploadSchema } from '../../shared/schemas';
import { storeImage, releaseImageIfUnused } from '../images';

const regionSchema = z.object({
  id: z.string().min(1).max(100),
  originalSource: z.string().min(1).max(6000).optional(),
  needsReview: z.boolean().optional(),
  source: z.string().min(1).max(6000),
  translation: z.string().min(1).max(6000),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
}).refine(r => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001, '画像の範囲外です');
export const translationRegionsSchema = z.object({ regions: z.array(regionSchema).max(100) });
export const regionRoutes = new Hono<AppEnv>();

regionRoutes.get('/translations/:id/regions', async c => {
  const row = await c.env.DB.prepare('SELECT regions_json FROM translation_regions WHERE translation_id = ?')
    .bind(c.req.param('id')).first<{regions_json: string}>();
  if (!row) return c.json({ regions: [] });
  try { return c.json(translationRegionsSchema.parse({ regions: JSON.parse(row.regions_json) })); }
  catch { return c.json({ regions: [] }); }
});
regionRoutes.put('/translations/:id/regions', async c => {
  const body = await parseBody(c, translationRegionsSchema, 1_000_000);
  const id = c.req.param('id');
  const translation = await c.env.DB.prepare('SELECT source_text FROM translations WHERE id = ?')
    .bind(id).first<{source_text: string}>();
  if (!translation) throw new ApiError(404, 'NOT_FOUND', '翻訳履歴が見つかりません。');
  if (new Set(body.regions.map(r => r.id)).size !== body.regions.length || body.regions.some(r => !translation.source_text.includes(r.source))) {
    throw new ApiError(400, 'INVALID_REGIONS', '画像の範囲と原文が一致しません。');
  }
  await c.env.DB.prepare(`INSERT INTO translation_regions (translation_id, regions_json) VALUES (?, ?)
    ON CONFLICT(translation_id) DO UPDATE SET regions_json=excluded.regions_json`)
    .bind(id, JSON.stringify(body.regions)).run();
  return c.json(body);
});

regionRoutes.put('/translations/:id/image', async c => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT image_key FROM translations WHERE id = ?').bind(id).first<{image_key: string|null}>();
  if (!row) throw new ApiError(404, 'NOT_FOUND', '翻訳履歴が見つかりません。');
  const body = await parseBody(c, imageUploadSchema, 14_000_000);
  const image = await storeImage(c.env, body);
  try {
    await c.env.DB.prepare('UPDATE translations SET image_key = ? WHERE id = ?').bind(image.key, id).run();
  } catch (error) {
    await releaseImageIfUnused(c.env, image.key);
    throw error;
  }
  if (row.image_key && row.image_key !== image.key) await releaseImageIfUnused(c.env, row.image_key);
  return c.json({ imageKey: image.key });
});
