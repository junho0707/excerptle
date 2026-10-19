/* Client sign-in flow test.
 *
 *   node tools/auth_flow_test.ts
 *
 * Runs src/auth.ts (types stripped) against a stand-in API that behaves like
 * backend/src/worker.ts, covering the three doors an email can go through (new
 * account, returning with a password, returning without) and the
 * set/change/remove path.
 */
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';

interface FakeUser { email: string; name: string; provider: string; pw?: string; salt?: string; iterations?: number }
interface ReqBody { email?: string; code?: string; key?: unknown; password?: string; currentKey?: unknown; remove?: boolean; salt?: unknown; iterations?: unknown }
interface FakeRequest { method?: string; headers?: Record<string, string>; body?: string }
interface FakeResponse { ok: boolean; status: number; json: () => Promise<unknown> }

// Everything below that auth.ts reads as a global is a local here; the direct
// eval further down resolves those names in this module's scope.
const store=(m=new Map<string, string>())=>({getItem:(k: string)=>m.has(k)?m.get(k)!:null,setItem:(k: string,v: unknown)=>m.set(k,String(v)),removeItem:(k: string)=>m.delete(k),clear:()=>m.clear()});
const localStorage=store(),sessionStorage=store();
const events: string[]=[];
const document={dispatchEvent:(e: {type: string})=>events.push(e.type)};
class CustomEvent{type: string;detail: unknown;constructor(t: string,o?: {detail?: unknown}){this.type=t;this.detail=o?.detail}}
const crypto=webcrypto;
// fake API
const db={users:new Map<string, FakeUser>(),sessions:new Map<string, string>()};
const sha=async(s: string)=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const ITER=600000, isHex=(v: unknown,n: number): v is string=>typeof v==='string'&&v.length===n&&/^[0-9a-f]+$/.test(v);
const verifier=(key: string,salt: string)=>sha(`excerptle-pwd-v2:${salt}:${key}`);
const kdfOf=(u: FakeUser|undefined)=>u?.pw?{salt:u.salt!,iterations:u.iterations!}:null;
let sent=0, sawPassword=0;
const fetch=async(url: string,opt: FakeRequest={}): Promise<FakeResponse>=>{
  const path=url.replace('https://api.test','').split('?')[0];
  if(path==='/auth/kdf')return{ok:true,status:200,json:async()=>({iterations:ITER,saltBytes:16})};
  const d: ReqBody=JSON.parse(opt.body||'{}');
  const J=(o: object,st=200)=>({ok:st<400,status:st,json:async()=>o});
  const email=(d.email||'').toLowerCase();
  const tok=(opt.headers?.Authorization||'').slice(7);
  const me=()=>db.users.get(db.sessions.get(tok)!);
  const mkSession=(u: FakeUser)=>{const t='t'+Math.random().toString(16).slice(2);db.sessions.set(t,u.email);
    return J({uid:u.email,email:u.email,name:u.name,provider:u.provider,token:t,expiresAt:Math.floor(Date.now()/1000)+3600,hasPassword:!!u.pw})};
  if(path==='/auth/check'){const u=db.users.get(email);const k=kdfOf(u);
    return J({account:!!u,hasPassword:!!k,google:false,...(k?{kdf:k}:{})})}
  if(path==='/auth/email'){sent++;const u=db.users.get(email);return J({hasPassword:!!u?.pw})}
  if(path==='/auth/verify'){if(d.code!=='123456')return J({error:'Code expired or incorrect.'},401);
    if(!db.users.get(email))db.users.set(email,{email,name:email.split('@')[0],provider:'email'});
    return mkSession(db.users.get(email)!)}
  if(path==='/auth/login'){const u=db.users.get(email);const k=kdfOf(u);
    if(d.password!==undefined)sawPassword++;   // a raw password must never arrive
    if(!k||u!.pw!==await verifier(isHex(d.key,64)?d.key:'x',k.salt))return J({error:'Wrong email or password.'},401);
    return mkSession({...u!,provider:'password'})}
  if(path==='/me/password'){const u=me();if(!u)return J({error:'Please sign in again.'},401);
    if(d.password!==undefined)sawPassword++;
    const k=kdfOf(u);
    if(k&&u.pw!==await verifier(isHex(d.currentKey,64)?d.currentKey:'x',k.salt))return J({error:'Current password is wrong.'},401);
    if(d.remove){delete u.pw;delete u.salt;return J({ok:true})}
    if(!isHex(d.key,64)||!isHex(d.salt,32))return J({error:'Could not read that password.'},400);
    if(typeof d.iterations!=='number'||!Number.isInteger(d.iterations)||d.iterations<ITER)return J({error:'Unsupported password settings.'},400);
    u.pw=await verifier(d.key,d.salt);u.salt=d.salt;u.iterations=d.iterations;return J({ok:true})}
  return J({error:'Not found.'},404);
};
const window: {EXCERPTLE_API: string; BOOKLE_API: string; BookleAuth?: BookleAuthApi}={EXCERPTLE_API:'https://api.test',BOOKLE_API:'https://api.test'};
eval(stripTypeScriptTypes(readFileSync(new URL('../src/auth.ts', import.meta.url),'utf8')));
const A=window.BookleAuth!;
const eq=(a: unknown,b: unknown,m: string)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);console.log('  ok',m)};
const throws=async(f: () => Promise<unknown>,m: string)=>{try{await f();throw new Error('no throw: '+m)}catch(e){if((e as Error).message.startsWith('no throw'))throw e;console.log('  ok',m,'->',(e as Error).message)}};
(async()=>{
  console.log('new address');
  eq(await A.checkEmail('a@b.com'),{account:false,hasPassword:false,kdf:null},'unknown email needs a code');
  eq(sent,0,'nothing emailed by the check itself');
  await A.sendCode('a@b.com'); eq(sent,1,'code sent');
  await A.verifyCode('a@b.com','123456');
  eq(A.session()!.email,'a@b.com','signed in');
  eq(A.hasPassword(),false,'no password yet -> modal should offer one');

  console.log('setting one');
  await throws(()=>A.setPassword('short'),'rejects a short password');
  await A.setPassword('a good long password');
  eq(A.hasPassword(),true,'session now knows');

  console.log('returning');
  A.signOut();
  const who=await A.checkEmail('a@b.com');
  eq({account:who.account,hasPassword:who.hasPassword},{account:true,hasPassword:true},'goes to the password door');
  eq(who.kdf!.iterations,ITER,'server names the iteration count');
  eq(who.kdf!.salt.length,32,'and a per-account salt');
  const before=sent;
  await throws(()=>A.signInWithPassword('a@b.com','wrong password'),'wrong password refused');
  await A.signInWithPassword('a@b.com','a good long password');
  eq(A.session()!.provider,'password','signed in by password');
  eq(sent,before,'no email sent on the password path');
  eq(A.hasPassword(),true,'still flagged');

  console.log('changing + removing');
  await throws(()=>A.setPassword('another long password'),'change needs the current one');
  await A.setPassword('another long password','a good long password');
  A.signOut();
  await A.signInWithPassword('a@b.com','another long password');
  await throws(()=>A.removePassword('nope'),'remove needs the current one');
  await A.removePassword('another long password');
  eq(A.hasPassword(),false,'back to codes');
  eq(await A.checkEmail('a@b.com'),{account:true,hasPassword:false,kdf:null},'existing account, code door');
  await throws(()=>A.signInWithPassword('a@b.com','another long password'),'old password no longer works');

  console.log('the password itself never leaves the browser');
  eq(sawPassword,0,'no endpoint ever received a raw password field');
  const stored=db.users.get('a@b.com')!;
  eq(!!stored.salt,false,'salt cleared with the password');

  console.log('\nall client auth checks passed');
})().catch(e=>{console.error('FAIL',e.message);process.exit(1)});
