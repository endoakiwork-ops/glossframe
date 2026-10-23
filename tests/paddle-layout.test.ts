import {describe,it,expect} from 'vitest';
import {groupPaddleLines} from '../src/shared/paddle-layout';
import {ocrCorrectionNeedsReview} from '../src/shared/ocr-correction';

const line=(text:string,x:number,y:number,w=60)=>({text,bbox:{x0:x,y0:y,x1:x+w,y1:y+12},confidence:95});
describe('synthetic Paddle OCR layout',()=>{
 it('joins words and rows but keeps a speaker label separate',()=>{
  const result=groupPaddleLines([
   line('Robin',20,10),
   line('Our',10,50,32),line('garden',44,50,62),line('is',108,50,18),line('quiet.',128,50,58),
   line('Please',10,65,54),line('visit',66,65,44),line('tomorrow.',112,65,85),
  ],[]);
  expect(result.map(r=>r.text)).toEqual(['Robin','Our garden is quiet. Please visit tomorrow.']);
  expect(result[0].bbox.y1).toBeLessThan(result[1].bbox.y0);
 });
 it('keeps staggered neighbouring columns separate',()=>{
  const result=groupPaddleLines([line('THE BLUE',180,10),line('A SMALL',20,15),line('KITE FLIES',180,25),line('BOAT SAILS',20,30)],[]);
  expect(result.map(r=>r.text)).toEqual(['THE BLUE KITE FLIES','A SMALL BOAT SAILS']);
 });
 it('respects separate panels despite narrow gutters',()=>{
  const result=groupPaddleLines([line('GARDEN',0,0,50),line('ROUTE',55,0,50)], [{x0:0,y0:0,x1:51,y1:25},{x0:54,y0:0,x1:110,y1:25}]);
  expect(result.map(r=>r.text)).toEqual(['GARDEN','ROUTE']);
 });
 it('preserves uncertain OCR for the correction stage',()=>{
  expect(groupPaddleLines([line('PLANTT',0,0),line('GROWSP',0,15)],[])[0].text).toBe('PLANTT GROWSP');
 });
 it('does not produce overlapping speaker and paragraph boxes',()=>{
  const result=groupPaddleLines([line('Morgan',10,10),line('We plant herbs.',10,50,180),line('They grow here.',10,65,180)],[]);
  expect(result).toHaveLength(2);
  expect(result[0].bbox.y1).toBeLessThanOrEqual(result[1].bbox.y0);
 });
});
it('flags a missing subject and preserves explicit uncertainty',()=>{
 expect(ocrCorrectionNeedsReview('IF IT DRINKS WATER GETS BIGGER?', [{source:'IF IT DRINKS WATER ',translation:'水を飲むと'},{source:'GETS BIGGER?',translation:'大きくなる？'}])).toBe(true);
 expect(ocrCorrectionNeedsReview('IF IT DRINKS WATER IT GETS BIGGER?', [{source:'IF IT DRINKS WATER ',translation:'水を飲むと'},{source:'IT GETS BIGGER?',translation:'大きくなる？'}])).toBe(false);
 expect(ocrCorrectionNeedsReview('Unclear',[],true)).toBe(true);
});
