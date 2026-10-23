import {it,expect} from 'vitest';
import {splitPositionedSentences} from '../src/shared/ocr-sentences';
it('splits adjacent sentences using their recognized word geometry',()=>{
 const words=['Please','wait.','Come','back','tomorrow.'].map((text,i)=>({text,bbox:{x0:i*20,y0:10,x1:i*20+18,y1:30}}));
 expect(splitPositionedSentences(words)).toEqual([{text:'Please wait.',bbox:{x0:0,y0:10,x1:38,y1:30}},{text:'Come back tomorrow.',bbox:{x0:40,y0:10,x1:98,y1:30}}]);
});
it('does not invent boxes for missing OCR words',()=>expect(splitPositionedSentences([])).toEqual([]));
