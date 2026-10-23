import {it,expect} from 'vitest';
import {expandSingleLineRegions,ocrImageScale} from '../src/shared/ocr-panels';
it('enlarges a short label only inside its own empty panel',()=>{
 const region={bbox:{x0:30,y0:45,x1:70,y1:55}};
 const panel={x0:20,y0:10,x1:80,y1:90};
 const [expanded]=expandSingleLineRegions([region],[panel]);
 expect(expanded.bbox).toEqual({x0:30,y0:35,x1:70,y1:65});
 const japanese={x0:30,y0:58,x1:70,y1:68};
 expect(expandSingleLineRegions([region],[panel],[japanese])[0]).toEqual(region);
 expect(expandSingleLineRegions([region,{bbox:japanese}],[panel])[0]).toEqual(region);
});
it('preserves the supplied large screenshot and enlarges small images within the memory limit',()=>{
 expect(ocrImageScale(1080,2424)).toBe(1);
 expect(ocrImageScale(400,683)).toBe(3);
 expect(ocrImageScale(4000,6000)*6000).toBe(3200);
});
