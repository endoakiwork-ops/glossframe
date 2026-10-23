import { groupOcrLines, type OcrTextLine } from './ocr-layout';
type Box = OcrTextLine['bbox'];
const height=(b:Box)=>Math.max(1,b.y1-b.y0);
const cx=(b:Box)=>(b.x0+b.x1)/2;
const cy=(b:Box)=>(b.y0+b.y1)/2;
const union=(a:Box,b:Box):Box=>({x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1)});
const sameRow=(a:Box,b:Box)=>Math.abs(cy(a)-cy(b))<=Math.min(height(a),height(b))*.3;

/** Rebuild lines before paragraphs. Paddle word boxes include overlapping padding. */
function joinRows(lines:OcrTextLine[]):OcrTextLine[]{
 const rows:OcrTextLine[]=[];
 for(const line of [...lines].sort((a,b)=>a.bbox.x0-b.bbox.x0)){
  const b=line.bbox;
  const row=rows.find(r=>{
   const a=r.bbox,h=Math.min(height(a),height(b));
   if(!sameRow(a,b)||b.x0<a.x0||b.x0-a.x1>h*.3)return false;
   const seam=(a.x1+b.x0)/2;
   // A wide gap on neighbouring baselines marks two speech columns even if
   // their padded top lines touch. Never merge across that column gutter.
   return !lines.some(left=>lines.some(right=>{
    if(left===right||!sameRow(left.bbox,right.bbox))return false;
    const l=left.bbox,r=right.bbox;
    return l.x1<=seam+h*.2 && r.x0>=seam-h*.2 && r.x0-l.x1>h*.3 && r.x0-l.x1<h*4
      && Math.abs(cy(l)-cy(a))<h*3 && Math.abs(cy(l)-cy(a))>h*.45
      && cx(l)>=a.x0-h && cx(r)<=b.x1+h
      && !lines.some(middle=>middle!==left&&middle!==right&&sameRow(middle.bbox,l)
        && middle.bbox.x0<r.x0 && middle.bbox.x1>l.x1);
   }));
  });
  if(row){row.text+=' '+line.text.trim();row.bbox=union(row.bbox,b);row.confidence=Math.min(row.confidence,line.confidence);}
  else rows.push({...line,text:line.text.trim(),bbox:{...b}});
 }
 // A preceding full-width line can establish that separated fragments below
 // belong to one caption (e.g. a highlighted word not detected in between).
 for(const a of rows){
  for(const b of rows){
   if(a===b||!a.text||!b.text||!sameRow(a.bbox,b.bbox)||b.bbox.x0<a.bbox.x1)continue;
   const h=Math.min(height(a.bbox),height(b.bbox));
   if(b.bbox.x0-a.bbox.x1>h*8)continue;
   const bridge=rows.find(top=>top!==a&&top!==b&&top.text && top.bbox.y1<=Math.min(a.bbox.y0,b.bbox.y0)+h*.2
    && Math.min(a.bbox.y0,b.bbox.y0)-top.bbox.y1<h*.75
    && top.bbox.x0<=a.bbox.x0+h*.5 && top.bbox.x1>b.bbox.x0+h*.5);
   if(bridge){a.text+=' '+b.text;a.bbox=union(a.bbox,b.bbox);a.confidence=Math.min(a.confidence,b.confidence);b.text='';}
  }
 }
 return rows.filter(r=>r.text);
}

/** Keep panels separate, restore reading order, and retain one region per text block. */
export function groupPaddleLines(lines: OcrTextLine[], panels: Box[]): OcrTextLine[] {
 const buckets=new Map<number,OcrTextLine[]>();
 for(const line of lines){
  if(!line.text.trim()||line.confidence<50)continue;
  const b=line.bbox;
  const containing=panels.map((p,index)=>({p,index})).filter(({p})=>cx(b)>=p.x0&&cx(b)<=p.x1&&cy(b)>=p.y0&&cy(b)<=p.y1)
   .sort((a,b)=>(a.p.x1-a.p.x0)*(a.p.y1-a.p.y0)-(b.p.x1-b.p.x0)*(b.p.y1-b.p.y0));
  const key=containing[0]?.index??-1;
  buckets.set(key,[...(buckets.get(key)??[]),line]);
 }
 const regions = [...buckets.values()].flatMap(bucket=>groupOcrLines(joinRows(bucket),()=>true,false,.45))
  // Very short isolated fragments are mostly icons / non-English strokes. Do
  // this only after grouping so IF / IT / TO inside a sentence are preserved.
  .filter(r=>(r.text.match(/[A-Za-z]/g)?.length??0)>=4)
  .sort((a,b)=>a.bbox.y0-b.bbox.y0||a.bbox.x0-b.bbox.x0);
 // Detection padding can overlap at the boundary between otherwise separate
 // bubbles. Divide only that narrow padding band, never the recognized text.
 for(let i=0;i<regions.length;i++) for(let j=i+1;j<regions.length;j++){
  const a=regions[i].bbox,b=regions[j].bbox;
  const ox=Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0),oy=Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0);
  if(ox<=0||oy<=0)continue;
  if(ox<Math.min(a.x1-a.x0,b.x1-b.x0)*.25){
   const [left,right]=cx(a)<cx(b)?[a,b]:[b,a];const seam=(left.x1+right.x0)/2;left.x1=seam;right.x0=seam;
  }else if(oy<Math.min(height(a),height(b))*.25){
   const [top,bottom]=cy(a)<cy(b)?[a,b]:[b,a];const seam=(top.y1+bottom.y0)/2;top.y1=seam;bottom.y0=seam;
  }
 }
 return regions;
}
