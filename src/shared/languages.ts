export interface Language {
  code: string;
  label: string;
  native: string;
  tesseract: string;
  rtl?: boolean;
}

/**
 * Supported languages. Every entry has a Tesseract traineddata package so the
 * language selector can never offer a language that OCR cannot handle.
 */
export const LANGUAGES: Language[] = [
  { code: "en", label: "英語", native: "English", tesseract: "eng" },
  { code: "ja", label: "日本語", native: "日本語", tesseract: "jpn" },
  { code: "zh-Hans", label: "中国語（簡体字）", native: "简体中文", tesseract: "chi_sim" },
  { code: "zh-Hant", label: "中国語（繁体字）", native: "繁體中文", tesseract: "chi_tra" },
  { code: "ko", label: "韓国語", native: "한국어", tesseract: "kor" },
  { code: "es", label: "スペイン語", native: "Español", tesseract: "spa" },
  { code: "fr", label: "フランス語", native: "Français", tesseract: "fra" },
  { code: "de", label: "ドイツ語", native: "Deutsch", tesseract: "deu" },
  { code: "pt", label: "ポルトガル語", native: "Português", tesseract: "por" },
  { code: "it", label: "イタリア語", native: "Italiano", tesseract: "ita" },
  { code: "ru", label: "ロシア語", native: "Русский", tesseract: "rus" },
  { code: "ar", label: "アラビア語", native: "العربية", tesseract: "ara", rtl: true },
];

export const LANGUAGE_MAP = Object.fromEntries(LANGUAGES.map((l) => [l.code, l])) as Record<
  string,
  Language
>;

export function languageLabel(code: string): string {
  return LANGUAGE_MAP[code]?.label ?? code;
}

export function languageNative(code: string): string {
  return LANGUAGE_MAP[code]?.native ?? code;
}

export function tesseractLang(code: string): string {
  return LANGUAGE_MAP[code]?.tesseract ?? "eng";
}

export function isSupportedLanguage(code: string): boolean {
  return Boolean(LANGUAGE_MAP[code]);
}
