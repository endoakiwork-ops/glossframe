import type {PositionedWord} from './ocr-sentences';
type Box=PositionedWord['bbox'];
/** Find enclosed pale text panels; illustration/background components are excluded by fill and size. */
export function findOcrPanels(data:Uint8ClampedArray|Uint8Array,width:number,height:number):Box[] {
 const size=width*height,seen=new Uint8Array(size),queue=new Int32Array(size),boxes:Box[]=[];
 const white=(p:number)=>data[p*4]>=230&&data[p*4+1]>=230&&data[p*4+2]>=230;
 for(let i=0;i<size;i++) {
  if(seen[i]||!white(i))continue;
  let head=0,tail=1,x0=width,y0=height,x1=0,y1=0;queue[0]=i;seen[i]=1;
  while(head<tail){
   const p=queue[head++],x=p%width,y=Math.floor(p/width);
   x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
   const visit=(n:number)=>{if(!seen[n]&&white(n)){seen[n]=1;queue[tail++]=n;}};
   if(x>0)visit(p-1);if(x<width-1)visit(p+1);if(y>0)visit(p-width);if(y<height-1)visit(p+width);
  }
  const area=(x1-x0+1)*(y1-y0+1);
  if(tail>size*0.0008&&tail/area>0.6&&area<size*0.3&&x1-x0>width*0.04&&y1-y0>height*0.012)boxes.push({x0,y0,x1:x1+1,y1:y1+1});
 }
 return boxes.sort((a,b)=>a.y0-b.y0||a.x0-b.x0).slice(0,30);
}

export function ocrImageScale(width:number,height:number):number {
 const edge=Math.max(width,height);
 return Math.min(3200/edge,Math.max(1,Math.ceil(1600/edge)));
}

/** Use nearby empty panel space for short labels, without growing into another text region. */
export function expandSingleLineRegions<T extends {bbox:Box}>(regions:T[],panels:Box[],forbidden:Box[]=[]):T[] {
 return regions.map(region=>{
  const b=region.bbox,w=b.x1-b.x0,h=b.y1-b.y0;
  if(w/h<2)return region;
  const panel=panels.find(p=>b.x0>=p.x0&&b.y0>=p.y0&&b.x1<=p.x1&&b.y1<=p.y1&&regions.filter(r=>r.bbox.x0>=p.x0&&r.bbox.y0>=p.y0&&r.bbox.x1<=p.x1&&r.bbox.y1<=p.y1).length===1);
  if(!panel)return region;
  const padding=Math.max(2,(panel.y1-panel.y0)*0.08);
  const expanded={...b,y0:Math.max(panel.y0+padding,b.y0-h),y1:Math.min(panel.y1-padding,b.y1+h)};
  if(expanded.y0>b.y0||expanded.y1<b.y1)return region;
  if(forbidden.some(r=>Math.min(r.x1,expanded.x1)>Math.max(r.x0,expanded.x0)&&Math.min(r.y1,expanded.y1)>Math.max(r.y0,expanded.y0)))return region;
  if(regions.some(r=>r!==region&&Math.min(r.bbox.x1,expanded.x1)>Math.max(r.bbox.x0,expanded.x0)&&Math.min(r.bbox.y1,expanded.y1)>Math.max(r.bbox.y0,expanded.y0)))return region;
  return {...region,bbox:expanded};
 });
}
