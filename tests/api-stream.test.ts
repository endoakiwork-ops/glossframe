import {afterEach,it,expect,vi} from 'vitest';
import {api} from '../src/client/lib/api';
afterEach(()=>vi.unstubAllGlobals());
it('delivers region events across arbitrary UTF-8 network chunks before completion',async()=>{
 const encoder=new TextEncoder();
 const bytes=encoder.encode(JSON.stringify({type:'regions',regions:[{translation:'こんにちは'}]})+'\n'+JSON.stringify({type:'complete',result:{id:'saved'}})+'\n');
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close();}}))));
 const onEvent=vi.fn();
 expect(await api('/translate',{onEvent})).toEqual({id:'saved'});
 expect(onEvent).toHaveBeenCalledWith({type:'regions',regions:[{translation:'こんにちは'}]});
});
it('rejects a disconnected stream rather than treating partial results as saved',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"type":"regions","regions":[]}\n')));
 await expect(api('/translate',{onEvent:vi.fn()})).rejects.toMatchObject({code:'INCOMPLETE'});
});
