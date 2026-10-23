import { z } from "zod";
import { isSupportedLanguage } from "./languages";

const languageCode = z.string().refine(isSupportedLanguage, "未対応の言語です");
export const learnerLevelSchema = z.enum(["junior", "high", "600", "800", "900"]).optional().default("800");

export const loginSchema = z.object({
  password: z.string().min(1).max(200),
});

export const setupSchema = z.object({
  password: z.string().min(8, "パスワードは8文字以上にしてください").max(200),
});

export const recoverySchema = z.object({
  token: z.string().min(32).max(200),
  newPassword: z.string().min(8).max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8, "パスワードは8文字以上にしてください").max(200),
});

export const settingsPatchSchema = z
  .object({
    sourceLang: languageCode.optional(),
    targetLang: languageCode.optional(),
    saveImages: z.boolean().optional(),
    reviewIntervalDays: z.number().int().min(1).max(365).optional(),
    reviewTargetCount: z.number().int().min(1).max(10).optional(),
    reviewBatchSize: z.number().int().min(1).max(100).optional(),
    reviewShowImage: z.boolean().optional(),
    reviewOrder: z.enum(["due", "created", "random"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "変更内容がありません");

export const translateSchema = z.object({
  text: z.string().trim().min(1, "翻訳する文章がありません").max(6000),
  sourceLang: languageCode,
  targetLang: languageCode,
  saveHistory: z.boolean().optional().default(true),
});

export const segmentSchema = z.object({
  source: z.string().max(6000),
  translation: z.string().max(2000),
});

export const grammarNoteSchema = z.object({
  title: z.string().max(120),
  explanation: z.string().max(600),
  example: z.string().max(400).optional(),
});

export const keyPhraseSchema = z.object({
  term: z.string().max(120),
  meaning: z.string().max(300),
  note: z.string().max(300).optional(),
});

export const translationResultSchema = z.object({
  sourceText: z.string().max(6000).optional().default(""),
  translatedText: z.string().max(6000),
  segments: z.array(segmentSchema).max(30).default([]),
  grammarNotes: z.array(grammarNoteSchema).max(8).default([]),
  keyPhrases: z.array(keyPhraseSchema).max(12).default([]),
});

export const wordDetailSchema = z.object({
  term: z.string().max(200).default(""),
  baseForm: z.string().max(200).default(""),
  partOfSpeech: z.string().max(80).default(""),
  meaning: z.string().max(500).default(""),
  contextMeaning: z.string().max(500).default(""),
  note: z.string().max(500).optional().default(""),
  sourceEquivalent: z.string().max(200).optional().default(""),
});

export const similarExpressionSchema = z.object({
  term: z.string().max(120),
  meaning: z.string().max(300),
  difference: z.string().max(300),
});

export const similarExpressionsSchema = z.object({
  expressions: z.array(similarExpressionSchema).max(8).default([]),
});

export const wordLookupSchema = z.object({
  term: z.string().trim().min(1).max(200),
  sentence: z.string().trim().min(1).max(6000),
  translation: z.string().trim().max(6000).optional().default(""),
  sourceLang: languageCode,
  targetLang: languageCode,
  side: z.enum(["source", "translation"]).optional().default("source"),
});

export const similarRequestSchema = z.object({
  term: z.string().trim().min(1).max(200),
  sentence: z.string().trim().max(6000).optional().default(""),
  sourceLang: languageCode,
  targetLang: languageCode,
  learnerLevel: learnerLevelSchema,
});

export const wordCreateSchema = z.object({
  term: z.string().trim().min(1).max(200),
  baseForm: z.string().trim().max(200).optional().default(""),
  partOfSpeech: z.string().trim().max(80).optional().default(""),
  meaning: z.string().trim().min(1).max(1000),
  contextMeaning: z.string().trim().max(1000).optional().default(""),
  sourceText: z.string().trim().max(6000).optional().default(""),
  translatedText: z.string().trim().max(6000).optional().default(""),
  grammarNote: z.string().trim().max(2000).optional().default(""),
  sourceLang: languageCode,
  targetLang: languageCode,
  origin: z.enum(["translation", "manual", "ai"]).optional().default("translation"),
  translationId: z.string().max(80).optional().nullable(),
  existingImageKey: z.string().max(64).optional().nullable(),
  image: z
    .object({
      dataBase64: z.string().min(1).max(12_000_000),
      contentType: z.enum(["image/webp", "image/jpeg", "image/png"]),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      width: z.number().int().positive().max(10000).optional(),
      height: z.number().int().positive().max(10000).optional(),
    })
    .optional()
    .nullable(),
});

export const wordUpdateSchema = z
  .object({
    term: z.string().trim().min(1).max(200).optional(),
    baseForm: z.string().trim().max(200).optional(),
    partOfSpeech: z.string().trim().max(80).optional(),
    meaning: z.string().trim().min(1).max(1000).optional(),
    sourceText: z.string().trim().max(6000).optional(),
    translatedText: z.string().trim().max(6000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "変更内容がありません");

export const reviewRatingSchema = z.object({
  requestId: z.string().min(1).max(80).optional(),
  rating: z.enum(["known", "unknown"]),
  mode: z.enum(["card", "cloze", "recall"]).optional().default("card"),
  assisted: z.boolean().optional().default(false),
  retry: z.boolean().optional().default(false),
});

export const explainRequestSchema = z.object({
  sourceText: z.string().trim().min(1).max(6000),
  translatedText: z.string().trim().max(6000).optional().default(""),
  sourceLang: languageCode.optional().default("en"),
  targetLang: languageCode.optional().default("ja"),
  learnerLevel: learnerLevelSchema,
});

export const explainResultSchema = z.object({
  points: z.array(z.string().min(1).max(600)).min(1).max(6),
});

export const chatTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().trim().min(1).max(2000).optional(),
  content: z.string().trim().min(1).max(2000).optional(),
}).refine(v => Boolean(v.content || v.text), "会話内容がありません").transform(v => ({ role: v.role, content: v.content || v.text! }));

export const selectedTextRangeSchema = z.object({
  start: z.number().int().min(0).optional(),
  end: z.number().int().positive().optional(),
  side: z.enum(["source", "translation"]),
  text: z.string().trim().min(1).max(1000),
});

export const chatRequestSchema = z.object({
  sourceText: z.string().trim().min(1).max(6000),
  translatedText: z.string().trim().max(6000).optional().default(""),
  sourceLang: languageCode.optional().default("en"),
  targetLang: languageCode.optional().default("ja"),
  learnerLevel: learnerLevelSchema,
  question: z.string().trim().min(1, "質問を入力してください").max(1000),
  selectedRange: selectedTextRangeSchema.optional().nullable(),
  history: z.array(chatTurnSchema).max(6).optional().default([]),
});

export const chatResultSchema = z.object({
  answer: z.string().trim().min(1).max(2000),
});

export const ttsRequestSchema = z.object({
  text: z.string().trim().min(1, "読み上げる文章がありません").max(2500),
  lang: languageCode.optional().default("en"),
});

export const wordCompleteRequestSchema = z.object({
  term: z.string().trim().min(1, "英単語・熟語を入力してください").max(200),
  meaning: z.string().trim().max(1000).optional().default(""),
  sourceText: z.string().trim().max(6000).optional().default(""),
  translatedText: z.string().trim().max(6000).optional().default(""),
  sourceLang: languageCode.optional().default("en"),
  targetLang: languageCode.optional().default("ja"),
  learnerLevel: learnerLevelSchema,
});

export const wordCompleteResultSchema = z.object({
  baseForm: z.string().max(200).optional().default(""),
  partOfSpeech: z.string().max(80).optional().default(""),
  meaning: z.string().min(1).max(1000),
  sourceText: z.string().min(1).max(2000),
  translatedText: z.string().min(1).max(2000),
  grammarNote: z.string().max(1000).optional().default(""),
});

export const wordExamplesRequestSchema = z.object({
  learnerLevel: learnerLevelSchema,
});

export const wordExamplesResultSchema = z.object({
  examples: z
    .array(
      z.object({
        sourceText: z.string().min(1).max(1000),
        translatedText: z.string().min(1).max(1000),
        note: z.string().max(500).optional().default(""),
      }),
    )
    .min(1)
    .max(4),
});

export const clozeBatchRequestSchema = z.object({
  wordIds: z.array(z.string().min(1).max(80)).min(1).max(20),
  learnerLevel: learnerLevelSchema,
});

export const clozeBatchResultSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        choices: z.array(z.string().min(1).max(200)).min(4).max(4),
      }),
    )
    .default([]),
});

export const aiQuizBatchRequestSchema = z.object({
  count: z.union([z.literal(5), z.literal(10)]).optional().default(5),
  mode: z.enum(["card", "cloze", "recall"]).optional().default("card"),
  learnerLevel: learnerLevelSchema,
  excludeTerms: z.array(z.string().max(200)).max(200).optional().default([]),
});

export const aiQuizPlanResultSchema = z.object({
  items: z
    .array(
      z.object({
        term: z.string().max(200).default(""),
        cefr: z.string().max(10).optional().default(""),
        meaning: z.string().max(300).default(""),
        pos: z.string().max(80).optional().default(""),
        distractors: z
          .array(z.object({ term: z.string().max(200).default(""), meaning: z.string().max(300).default("") }))
          .max(6)
          .default([]),
      }),
    )
    .min(1)
    .max(20),
});

export const aiQuizExamplesRequestSchema = z.object({
  mode: z.enum(["card", "cloze", "recall"]).optional().default("card"),
  learnerLevel: learnerLevelSchema,
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        term: z.string().min(1).max(200),
        meaning: z.string().max(300).optional().default(""),
        distractors: z.array(z.string().min(1).max(200)).max(3).default([]),
      }),
    )
    .min(1)
    .max(4),
});

export const aiQuizExamplesResultSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().max(80).default(""),
        surface: z.string().max(200).default(""),
        source: z.string().max(1000).default(""),
        translation: z.string().max(1000).default(""),
        choices: z.array(z.string().max(300)).max(6).optional().default([]),
      }),
    )
    .max(8)
    .default([]),
});

export const imageUploadSchema = z.object({
  dataBase64: z.string().min(1).max(12_000_000),
  contentType: z.enum(["image/webp", "image/jpeg", "image/png"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const backupSchema = z.object({
  format: z.literal("glossframe-backup"),
  version: z.literal(1),
  exportedAt: z.number(),
  settings: z.object({
    sourceLang: z.string(),
    targetLang: z.string(),
    saveImages: z.boolean(),
    reviewIntervalDays: z.number().int(),
    reviewTargetCount: z.number().int(),
    reviewBatchSize: z.number().int(),
    reviewShowImage: z.boolean(),
    reviewOrder: z.enum(["due", "created", "random"]),
    createdAt: z.number(),
    updatedAt: z.number(),
  }),
  translations: z.array(z.record(z.string(), z.unknown())).max(20000),
  words: z.array(z.record(z.string(), z.unknown())).max(20000),
  examples: z.array(z.record(z.string(), z.unknown())).max(50000),
  reviewEvents: z.array(z.record(z.string(), z.unknown())).max(100000),
  images: z
    .array(
      z.object({
        key: z.string(),
        contentType: z.string(),
        dataBase64: z.string(),
      }),
    )
    .max(5000),
});

export type TranslateInput = z.infer<typeof translateSchema>;
export type WordCreateInput = z.infer<typeof wordCreateSchema>;
export type WordLookupInput = z.infer<typeof wordLookupSchema>;
