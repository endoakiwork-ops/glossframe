import { beforeEach,describe,it,expect,vi } from 'vitest';
import { imageTranslationRoutes,imageTranslationSchema } from '../src/worker/routes/translate-regions';
const { run }=vi.hoisted(()=>({run:vi.fn()}));
vi.mock('../src/worker/ai',()=>({runJsonModel:run}));
const body={width:100,height:200,sourceLang:'en',targetLang:'ja',regions:[{id:'a',text:'Hello.',bbox:{x0:10,y0:10,x1:90,y1:30}},{id:'b',text:'Goodbye.',bbox:{x0:10,y0:80,x1:90,y1:110}}]};
function environment(){const writes:unknown[][]=[];const batch=vi.fn(async()=>[]);return {batch,writes,env:{DB:{prepare:()=>({bind:(...args:unknown[])=>{writes.push(args);return {};}}),batch}}};}
describe('automatic image translation',()=>{
 beforeEach(()=>run.mockReset());
 it('keeps geometry and source order even when AI changes response order',async()=>{
  run.mockResolvedValue({cached:false,value:{regions:[{id:'b',translation:'さようなら。',keyPhrases:[]},{id:'a',translation:'こんにちは。',keyPhrases:[]}]}});
  const {env,batch}=environment();
  const response=await imageTranslationRoutes.request('/translate/regions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},env);
  expect(response.status).toBe(200);const result=await response.json() as any;
  expect(result.regions.map((r:any)=>r.id)).toEqual(['a','b']);
  expect(result.regions[1]).toMatchObject({source:'Goodbye.',translation:'さようなら。',x:0.1,y:0.4,width:0.8,height:0.15});
  expect(result.segments.map((s:any)=>s.source).join('')).toBe(result.sourceText);
  expect(batch).toHaveBeenCalledTimes(1);expect(run).toHaveBeenCalledTimes(1);
 });
 it('never saves mismatched or duplicate AI region IDs',async()=>{
  run.mockResolvedValue({value:{regions:[{id:'a',translation:'一',keyPhrases:[]},{id:'a',translation:'二',keyPhrases:[]}]}});
  const {env,batch}=environment();
  const response=await imageTranslationRoutes.request('/translate/regions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},env);
  expect(response.status).toBe(500);expect(batch).not.toHaveBeenCalled();
 });
 it('rejects duplicate input IDs and out-of-image boxes',()=>{
  expect(imageTranslationSchema.safeParse({...body,regions:[body.regions[0],body.regions[0]]}).success).toBe(false);
  expect(imageTranslationSchema.safeParse({...body,width:50}).success).toBe(false);
 });
});

it('streams completed regions before later batches finish and saves one history record', async () => {
 run.mockReset();
 const expanded = {...body, regions:[...body.regions,{...body.regions[0],id:'c'},{...body.regions[1],id:'d'}]};
 let finish!: (value: unknown) => void;
 run.mockResolvedValueOnce({cached:false,value:{regions:['a','b','c'].map(id=>({id,translation:`訳${id}`,keyPhrases:[]}))}})
   .mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const {env,batch}=environment();
 const response=await imageTranslationRoutes.request('/translate/regions',{method:'POST',headers:{'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify(expanded)},env);
 const reader=response.body!.getReader();
 const first=JSON.parse(new TextDecoder().decode((await reader.read()).value));
 expect(first.type).toBe('regions');
 expect(first.regions.map((r:any)=>r.id)).toEqual(['a','b','c']);
 expect(batch).not.toHaveBeenCalled();
 await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 finish({cached:false,value:{regions:[{id:'d',translation:'訳d',keyPhrases:[]}]}});
 let rest='';
 while(true){const chunk=await reader.read();if(chunk.done)break;rest+=new TextDecoder().decode(chunk.value);}
 const events=rest.trim().split('\n').map(line=>JSON.parse(line));
 expect(events[0].regions[0].id).toBe('d');
 expect(events[1].type).toBe('complete');
 expect(events[1].result.regions).toHaveLength(4);
 expect(batch).toHaveBeenCalledTimes(1);
});

it('reports a stream failure without saving partial history', async () => {
 run.mockReset();run.mockRejectedValue(new Error('upstream failed'));
 const {env,batch}=environment();
 const response=await imageTranslationRoutes.request('/translate/regions',{method:'POST',headers:{'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify(body)},env);
 expect(JSON.parse(await response.text()).type).toBe('error');
 expect(batch).not.toHaveBeenCalled();
});

it('uses corrected source for clauses, vocabulary and persistence while retaining raw OCR in stream and history', async () => {
 run.mockReset();
 const original='IFT DRINKS CLEAN WATER GETS TALLERP';
 const corrected='IF IT DRINKS CLEAN WATER IT GETS TALLER?';
 run.mockResolvedValue({cached:false,value:{regions:[{id:'a',correctedSource:corrected,needsReview:false,translation:'きれいな水を飲むと背が高くなる？',segments:[{source:'IF IT DRINKS CLEAN WATER',translation:'きれいな水を飲むと'},{source:'IT GETS TALLER?',translation:'背が高くなる？'}],grammarNotes:[{title:'条件節',explanation:'IF は条件を表します。'}],keyPhrases:[{term:'GETS TALLER',meaning:'背が高くなる'},{term:'invented',meaning:'discard'}]}]}});
 const {env,writes}=environment();
 const response=await imageTranslationRoutes.request('/translate/regions',{method:'POST',headers:{'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({...body,regions:[{...body.regions[0],text:original}]})},env);
 const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
 expect(events[0].regions[0]).toMatchObject({originalSource:original,source:corrected,needsReview:false});
 const result=events[1].result;
 expect(result.sourceText).toBe(corrected);
 expect(result.segments.map((s:any)=>s.source).join('')).toBe(corrected);
 expect(result.keyPhrases.map((p:any)=>p.term)).toEqual(['GETS TALLER']);
 expect(result.grammarNotes).toHaveLength(1);
 expect(JSON.parse(writes[1][1] as string)[0]).toMatchObject({originalSource:original,source:corrected});
 expect(run).toHaveBeenCalledTimes(1);
});

it('preserves uncertainty and correction metadata when loading saved regions', async () => {
 const {translationRegionsSchema}=await import('../src/worker/routes/regions');
 const region={id:'a',source:'YOULL BE',originalSource:'YOULL BE',needsReview:true,translation:'あなたは',x:0,y:0,width:1,height:1};
 expect(translationRegionsSchema.parse({regions:[region]}).regions[0]).toEqual(region);
});

it('shows a draft while refinement is pending and saves only refinement', async () => {
 run.mockReset();
 let finish!: (value: unknown) => void;
 run.mockImplementation((_env, opts) => opts.kind.includes('draft')
   ? Promise.resolve({value:{regions:body.regions.map(r=>({id:r.id,translation:'速報'}))}})
   : new Promise(resolve=>{finish=resolve;}));
 const {env,writes,batch}=environment();
 const response=await imageTranslationRoutes.request('/translate/regions',{method:'POST',headers:{'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({...body,progressive:true})},env);
 const reader=response.body!.getReader();
 const first=JSON.parse(new TextDecoder().decode((await reader.read()).value));
 expect(first.type).toBe('draft');expect(batch).not.toHaveBeenCalled();
 finish({value:{regions:body.regions.map(r=>({id:r.id,translation:'確定',keyPhrases:[]}))}});
 let rest='';while(true){const chunk=await reader.read();if(chunk.done)break;rest+=new TextDecoder().decode(chunk.value);}
 expect(rest).toContain('"type":"complete"');
 expect(writes[0][2]).toBe('確定\n\n確定');
 expect(batch).toHaveBeenCalledTimes(1);
});

it.each(['slow','failed'])('does not wait for a %s draft to complete the final translation', async mode => {
 run.mockReset();
 run.mockImplementation((_env, opts) => opts.kind.includes('draft')
   ? mode === 'slow' ? new Promise(()=>{}) : Promise.reject(new Error('draft failed'))
   : Promise.resolve({value:{regions:body.regions.map(r=>({id:r.id,translation:'確定',keyPhrases:[]}))}}));
 const {env,batch}=environment();
 const response=await imageTranslationRoutes.request('/translate/regions',{method:'POST',headers:{'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({...body,progressive:true})},env);
 expect(await response.text()).toContain('"type":"complete"');
 expect(batch).toHaveBeenCalledTimes(1);
});

it('replaces the same boxes and ignores a late draft after refinement', async () => {
 const {mergeTranslationRegions}=await import('../src/shared/translation-regions');
 const initial=body.regions.map(r=>({id:r.id,source:r.text,translation:'',phase:'ocr' as const,x:0,y:0,width:1,height:1}));
 const draft={...initial[0],translation:'速報',phase:'draft' as const};
 const final={...initial[0],translation:'確定',phase:'final' as const};
 const updated=mergeTranslationRegions(mergeTranslationRegions(initial,[draft]),[final]);
 expect(mergeTranslationRegions(updated,[draft])).toEqual([final,initial[1]]);
 expect(mergeTranslationRegions(mergeTranslationRegions(initial,[final]),[draft])).toEqual([final,initial[1]]);
});
