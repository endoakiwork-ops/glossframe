export interface Token {
  text: string;
  isWord: boolean;
  start: number;
  end: number;
}

const wordChars = /[\p{L}\p{N}\p{M}'’\-]/u;

export function tokenize(text: string, lang: string): Token[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    try {
      const segmenter = new Intl.Segmenter(lang, { granularity: "word" });
      const tokens: Token[] = [];
      for (const part of segmenter.segment(text)) {
        const isWord =
          "isWordLike" in part && typeof part.isWordLike === "boolean"
            ? part.isWordLike
            : wordChars.test(part.segment);
        tokens.push({
          text: part.segment,
          isWord,
          start: part.index,
          end: part.index + part.segment.length,
        });
      }
      return tokens;
    } catch {
      // Fall through to a simple whitespace tokenizer.
    }
  }

  const tokens: Token[] = [];
  const regex = /([\p{L}\p{N}\p{M}'’\-]+|\s+|[^\s\p{L}\p{N}\p{M}]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const value = match[0];
    tokens.push({
      text: value,
      isWord: wordChars.test(value),
      start: match.index,
      end: match.index + value.length,
    });
  }
  return tokens;
}

export function phraseForSelection(tokens: Token[], selected: Set<number>): string {
  const picked = [...selected].sort((a, b) => a - b);
  if (!picked.length) return "";
  const first = tokens[picked[0]];
  const last = tokens[picked[picked.length - 1]];
  if (!first || !last) return "";
  const source = tokens.map((t) => t.text).join("");
  return source.slice(first.start, last.end).trim();
}
