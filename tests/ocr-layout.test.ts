import {describe,it,expect} from 'vitest';
import {groupOcrLines,splitOcrLine,regionsFromOcrPage,mergeOcrPasses} from '../src/shared/ocr-layout';

// Entirely authored test text and geometry; no screenshots or extracted publications.
const line=(text:string,x0:number,y0:number,x1:number,y1:number,confidence=95)=>({text,bbox:{x0,y0,x1,y1},confidence});
describe('synthetic OCR layout',()=>{
 it('splits a wide gutter between adjacent word groups',()=>{
  const result=splitOcrLine([line('Blue',10,10,40,30),line('kite',45,10,75,30),line('Green',180,10,230,30)],95);
  expect(result.map(r=>r.text)).toEqual(['Blue kite','Green']);
 });
 it('keeps columns and excludes uncertain symbols',()=>{
  const result=groupOcrLines([line('Read',10,10,60,30),line('Other',100,10,160,30),line('this.',12,35,58,55),line('/ \\',0,80,200,190),line('garbled',0,100,200,200,20)]);
  expect(result.map(r=>r.text)).toEqual(['Read this.','Other']);
 });
 it('handles empty OCR pages and empty recognition passes',()=>{
  expect(regionsFromOcrPage({blocks:[]},'en')).toEqual([]);
  expect(mergeOcrPasses([],[])).toEqual([]);
 });
});
