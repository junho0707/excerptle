/* Dev-API switch test.
 *
 *   node tools/dev_api_switch_test.cjs
 *
 * js/app.js rewrites the URL to drop the query string on some routes, so the
 * ?api=local / ?demo=1 choice cannot live in the address bar: the next reload
 * would quietly return to the deployed API and the page would start
 * contradicting the Worker under test. Checks that it sticks to the tab, that
 * ?api=off leaves, and that production ignores all of it.
 */
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','js','config.js'),'utf8');
function run(href, store, hostname){
  const url=new URL(href);
  const sessionStorage={_d:store,getItem(k){return k in this._d?this._d[k]:null},setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]}};
  const location={hostname:hostname??url.hostname,search:url.search,origin:url.origin,pathname:url.pathname};
  const window={}; const console={info(){}}; const listeners=[];
  const addEventListener=(t,f)=>listeners.push(t);
  eval(src);
  return {api:window.EXCERPTLE_API, badge:listeners.length>0, store};
}
const t=[];
const ok=(c,m)=>{t.push(c);console.log(c?'  ok':'  FAIL',m)};

let store={};
let r=run('http://localhost:8765/?api=local',store);
ok(r.api==='http://127.0.0.1:8787','?api=local points at the local Worker');
ok(store['excerptle.devapi']==='local','remembered for the tab');

// the app strips the query string, then something reloads
r=run('http://localhost:8765/#/',store);
ok(r.api==='http://127.0.0.1:8787','survives the URL losing ?api=local');
ok(r.badge,'badge still shown');

r=run('http://localhost:8765/?api=off',store);
ok(r.api!=='http://127.0.0.1:8787','?api=off leaves dev mode');
ok(!store['excerptle.devapi'],'and is forgotten');

store={};
r=run('http://localhost:8765/?demo=1',store);
ok(r.api==='','?demo=1 drops the backend');
r=run('http://localhost:8765/#/',store);
ok(r.api==='','and that sticks too');

// production must be untouchable
store={'excerptle.devapi':'local'};
r=run('https://excerptle.io/?api=local&demo=1',store,'excerptle.io');
ok(r.api==='https://excerptle-api.winter-glade-cbab.workers.dev','production ignores both flags and any stored value');
ok(!r.badge,'no dev badge in production');

console.log(t.every(Boolean)?'\nall sticky-mode checks passed':'\nFAILURES');
process.exit(t.every(Boolean)?0:1);
