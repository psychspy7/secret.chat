import {preflight,body,identify,rpc,json,errorResponse} from '../_shared/mobile.ts';
import {dispatchRelease} from '../_shared/push.ts';
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };
Deno.serve(async(req:Request)=>{
  const response=preflight(req); if(response) return response;
  try {
    const {authorization}=await identify(req), input=await body(req);
    // The database checks the confirmed administrator account and its live session.
    const result=await rpc('mobile_admin_publish_release',input,authorization);
    EdgeRuntime.waitUntil(dispatchRelease().catch(()=>{console.warn('Release alert retry pending.');}));
    return json(req,result);
  } catch(error) {return errorResponse(req,error);}
});
