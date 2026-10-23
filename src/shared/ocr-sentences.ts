export interface PositionedWord {text:string;bbox:{x0:number;y0:number;x1:number;y1:number}}
/** Sentence boundaries come from recognized words, geometry only from real OCR boxes. */
export function splitPositionedSentences(words:PositionedWord[]) {
  if(!words.length) return [];
  const normalized=words.map(w=>({...w,text:w.text.trim()})).filter(w=>w.text);
  const text=normalized.map(w=>w.text).join(' ');
  let offset=0;
  const spans=normalized.map(w=>{const start=offset;offset+=w.text.length+1;return {...w,start,end:offset-1};});
  const sentences = [...new Intl.Segmenter(undefined,{granularity:'sentence'}).segment(text)].flatMap(sentence=>{
    const selected=spans.filter(w=>w.start>=sentence.index&&w.end<=sentence.index+sentence.segment.length);
    if(!selected.length) return [];
    return [{text:sentence.segment.trim(),bbox:{x0:Math.min(...selected.map(w=>w.bbox.x0)),y0:Math.min(...selected.map(w=>w.bbox.y0)),x1:Math.max(...selected.map(w=>w.bbox.x1)),y1:Math.max(...selected.map(w=>w.bbox.y1))}}];
  });
  return sentences.map(s=>s.text).join(" ") === text ? sentences : [];
}
