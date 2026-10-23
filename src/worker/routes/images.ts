import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getImage, storeImage } from "../images";
import { parseBody } from "../validate";
import { imageUploadSchema } from "../../shared/schemas";
import { ApiError } from "../errors";

export const imageRoutes = new Hono<AppEnv>();

imageRoutes.post("/images", async (c) => {
  const body = await parseBody(c, imageUploadSchema, 14_000_000);
  const result = await storeImage(c.env, body);
  return c.json(result);
});

imageRoutes.get("/images/:key", async (c) => {
  const key = c.req.param("key");
  if (!/^[0-9a-f-]{20,64}$/i.test(key)) {
    throw new ApiError(404, "NOT_FOUND", "画像が見つかりません。");
  }
  const image = await getImage(c.env, key);
  if (!image) throw new ApiError(404, "NOT_FOUND", "画像が見つかりません。");
  return new Response(image.bytes, {
    headers: {
      "content-type": image.contentType,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
});
