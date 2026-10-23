import type { PositionedWord } from './ocr-sentences';

type Box = PositionedWord['bbox'];
export interface OcrTextLine { text: string; bbox: Box; confidence: number }
const height = (box: Box) => Math.max(1, box.y1 - box.y0);
const center = (box: Box) => (box.x0 + box.x1) / 2;
const union = (a: Box, b: Box): Box => ({x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1)});

/** Split a sparse OCR line at column gaps before joining vertically adjacent lines. */
export function splitOcrLine(words: (PositionedWord & {confidence?: number})[], confidence: number): OcrTextLine[] {
  const groups: typeof words[] = [];
  for (const word of words) {
    if (!word.text.trim() || !word.bbox) continue;
    const group = groups.at(-1);
    const last = group?.at(-1);
    if (!last || word.bbox.x0 - Math.max(last.bbox.x1, last.bbox.x0 + last.text.length * height(last.bbox) * 0.5) > Math.min(height(last.bbox),height(word.bbox)) * 0.8) groups.push([word]);
    else group!.push(word);
  }
  return groups.map(group => ({
    text: group.map(w=>w.text.trim()).join(' '),
    bbox: group.map(w=>w.bbox).reduce(union),
    confidence: group.reduce((sum,w)=>sum+(w.confidence ?? confidence),0)/group.length,
  }));
}

export function groupOcrLines(lines: OcrTextLine[], accept = (line: OcrTextLine) => line.confidence >= 60, mergeRows = true, maxVerticalGap = 1.2): OcrTextLine[] {
  // Sparse OCR can split a single subtitle row into several blocks. Reconnect
  // close pieces sharing a baseline before making vertical paragraph groups.
  const rows: OcrTextLine[] = [];
  for (const line of [...lines].sort((a,b)=>a.bbox.x0-b.bbox.x0)) {
    if (!accept(line) || !/\p{L}/u.test(line.text)) continue;
    const row = mergeRows ? rows.find(r => {
      const h = Math.min(height(r.bbox),height(line.bbox));
      const gap = line.bbox.x0-r.bbox.x1;
      return gap >= 0 && gap <= h*0.8 && Math.abs(r.bbox.y1-line.bbox.y1) <= h*0.25
        && (Math.max(height(r.bbox),height(line.bbox))/h > 1.5 || Math.abs(r.bbox.y0-line.bbox.y0) <= h*0.2);
    }) : undefined;
    if (row) {
      row.text += ' '+line.text;
      row.bbox=union(row.bbox,line.bbox);
      row.confidence=Math.min(row.confidence,line.confidence);
    } else rows.push({...line,bbox:{...line.bbox}});
  }
  lines=rows;
  const groups: {lines: OcrTextLine[]; bbox: Box}[] = [];
  for (const line of [...lines].sort((a,b)=>a.bbox.y0-b.bbox.y0 || a.bbox.x0-b.bbox.x0)) {
    if (!accept(line) || !/\p{L}/u.test(line.text)) continue;
    let best: (typeof groups)[number] | undefined;
    let distance = Infinity;
    for (const group of groups) {
      const last = group.lines.at(-1)!;
      const h = Math.max(height(last.bbox),height(line.bbox));
      const gap = line.bbox.y0-last.bbox.y1;
      const overlap = Math.min(last.bbox.x1,line.bbox.x1)-Math.max(last.bbox.x0,line.bbox.x0);
      const aligned = Math.abs(center(last.bbox)-center(line.bbox)) <= h * 1.2 || Math.abs(last.bbox.x0-line.bbox.x0) <= h * 0.5;
      if (gap < -h*0.4 || gap > h*maxVerticalGap || overlap <= 0 || !aligned || Math.max(height(last.bbox),height(line.bbox))/Math.min(height(last.bbox),height(line.bbox)) > 2.5) continue;
      const score = Math.max(0,gap) + Math.abs(center(last.bbox)-center(line.bbox));
      if (score < distance) { best=group; distance=score; }
    }
    if (best) { best.lines.push(line); best.bbox=union(best.bbox,line.bbox); }
    else groups.push({lines:[line],bbox:line.bbox});
  }
  return groups.map(group=>({text:group.lines.map(l=>l.text).join(' '),bbox:group.bbox,confidence:group.lines.reduce((sum,l)=>sum+l.confidence,0)/group.lines.length}));
}

interface OcrPage {
  blocks?: Array<{paragraphs?: Array<{
    text?: string; confidence?: number; bbox?: Box;
    lines?: Array<{text?: string; confidence?: number; bbox?: Box; words?: (PositionedWord & {confidence?: number})[]}>;
  }>}> | null
}

export function regionsFromOcrPage(page: OcrPage, lang: string, lexicon?: Set<string>): OcrTextLine[] {
  const lines: OcrTextLine[] = [];
  for (const block of page.blocks ?? []) for (const paragraph of block.paragraphs ?? []) {
    for (const line of paragraph.lines?.length ? paragraph.lines : [paragraph]) {
      // A mixed-language label must not leave isolated Latin fragments behind.
      if (lang === 'en' && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(line.text ?? '')) continue;
      const confidence = Number(line.confidence ?? paragraph.confidence ?? 0);
      const words = 'words' in line ? line.words : undefined;
      if (words?.length) lines.push(...splitOcrLine(words,confidence));
      else if (line.text && line.bbox) lines.push({text:line.text.trim(),bbox:line.bbox,confidence});
    }
  }
  const knownRatio = (text: string) => {
    const words=text.toLowerCase().match(/[a-z]+(?:['’][a-z]+)*/g) ?? [];
    const known=(word:string) => lexicon?.has(word) || lexicon?.has(word.replace(/(?:'s|s|ed|ing|er|est)$/,'')) || lexicon?.has(word.replace(/(?:ing|ed|er|est)$/,'e')) || lexicon?.has(word.replace(/ies$/,'y'));
    return words.length ? words.filter(known).length/words.length : 0;
  };
  return groupOcrLines(lines, line => line.confidence >= 60 || lang === 'en' && knownRatio(line.text) === 1 && (line.text.match(/[a-z]/gi)?.length ?? 0) >= 3).filter(region => {
    if (lang !== 'en') return true;
    region.text=region.text.replace(/([A-Za-z]+)-\s+([A-Za-z]+)/g,(match,a:string,b:string)=>lexicon?.has((a+b).toLowerCase())?a+b:match);
    const words = region.text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) ?? [];
    const letters = words.join('').length;
    const other = region.text.replace(/[A-Za-z\s\d.,!?;:'’“”"()\-]/g,'').length;
    if (other > letters * 0.15) return false;
    const lexical = knownRatio(region.text) >= 0.8;
    if (region.confidence < 80 && !(lexical && (words.length >= 3 || words.length === 1 && letters >= 5 && region.confidence >= 25))) return false;
    // Short isolated strokes (I, N, WN...) are not reliable text regions.
    return words.length >= 2 && letters >= 5 || words.length === 1 && (letters >= 4 && region.confidence >= 80 || letters >= 5 && lexical && region.confidence >= 25 || letters >= 3 && lexical && region.confidence >= 90);
  });
}

export function mergeOcrPasses(...passes: OcrTextLine[][]): OcrTextLine[] {
  const candidates = passes.flat().filter(candidate => !passes.some(pass => {
    const covered=pass.filter(r=>r!==candidate && r.confidence>=80 && overlapFraction(r.bbox,candidate.bbox)>0.8);
    return covered.some((a,i)=>covered.slice(i+1).some(b=>{
      const vertical=Math.min(a.bbox.y1,b.bbox.y1)-Math.max(a.bbox.y0,b.bbox.y0);
      const gap=Math.max(a.bbox.x0,b.bbox.x0)-Math.min(a.bbox.x1,b.bbox.x1);
      return vertical>Math.min(height(a.bbox),height(b.bbox))*0.5 && gap>Math.min(a.bbox.x1-a.bbox.x0,b.bbox.x1-b.bbox.x0)*0.08;
    }));
  })).sort((a,b) => score(b)-score(a));
  const selected: OcrTextLine[] = [];
  for (const candidate of candidates) {
    const existing = selected.find(existing => overlapFraction(existing.bbox,candidate.bbox) > 0.35);
    if (!existing) selected.push({...candidate,bbox:{...candidate.bbox}});
    else {
      const before = candidate.bbox.y0 < existing.bbox.y0 ? candidate : existing;
      const after = before === candidate ? existing : candidate;
      const a=before.text.split(/\s+/), b=after.text.split(/\s+/);
      // Recover a clipped leading/trailing line only where both OCR passes
      // agree on an overlapping sequence of words at the same location.
      for(let n=Math.min(a.length,b.length);n>0;n--) {
        if(a.slice(-n).join(' ').toLowerCase() !== b.slice(0,n).join(' ').toLowerCase()) continue;
        if(n<a.length && n<b.length && Math.abs(center(before.bbox)-center(after.bbox)) < Math.min(before.bbox.x1-before.bbox.x0,after.bbox.x1-after.bbox.x0)*0.5) {
          existing.text=[...a,...b.slice(n)].join(' ');
          existing.bbox=union(before.bbox,after.bbox);
        }
        break;
      }
    }
  }
  return selected.sort((a,b)=>a.bbox.y0-b.bbox.y0 || a.bbox.x0-b.bbox.x0);
}
function score(region: OcrTextLine) { return region.confidence * 0.25 + Math.min(50,region.text.split(/\s+/).length*3); }
function overlapFraction(a: Box,b: Box) {
  const intersection=Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
  return intersection/Math.max(1,Math.min((a.x1-a.x0)*(a.y1-a.y0),(b.x1-b.x0)*(b.y1-b.y0)));
}

/** Same preprocessing in the browser and the real-image regression runner. */
export function thresholdOcrPixels(pixels: Uint8ClampedArray | Uint8Array): void {
  for (let i=0;i<pixels.length;i+=4) {
    const luminance=0.2126*pixels[i]+0.7152*pixels[i+1]+0.0722*pixels[i+2];
    const value=luminance > 190 ? 255 : 0;
    pixels[i]=pixels[i+1]=pixels[i+2]=value;
    pixels[i+3]=255;
  }
}

export function panelNeedsRecognition(page: OcrPage, box: Box, lexicon: Set<string>): boolean {
  return (page.blocks ?? []).some(block => (block.paragraphs ?? []).some(paragraph => (paragraph.lines ?? []).some(line => {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(line.text ?? '')) return false;
    return (line.words ?? []).some(word => {
      const text=word.text.toLowerCase().replace(/[^a-z]/g,'');
      return (word.confidence ?? 100)<60 && text.length>=3 && lexicon.has(text) && word.bbox.x0>=box.x0 && word.bbox.y0>=box.y0 && word.bbox.x1<=box.x1 && word.bbox.y1<=box.y1;
    });
  })));
}

export function foreignTextBoxes(page: OcrPage): Box[] {
  return (page.blocks ?? []).flatMap(b=>(b.paragraphs ?? []).flatMap(p=>(p.lines ?? []).flatMap(l=>l.bbox && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(l.text ?? '') ? [l.bbox] : [])));
}
