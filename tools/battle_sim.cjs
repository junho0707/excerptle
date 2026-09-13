/* Battle-mode connection simulator.
 *
 *   node tools/battle_sim.cjs
 *
 * Slices the battle block out of js/app.js and runs it against a fake PeerJS
 * whose signalling server behaves like the real one: an id lives only as long
 * as its socket. Covers the failure that shipped — a host whose tab froze
 * while they pasted the invite link, leaving the guest with
 * "could not connect to peer bk-xxxxxx".
 */
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','js','app.js'),'utf8');
// Three real slices, no re-implementation: the settle helpers, recordFinish
// itself, and the battle block. recordFinish's solo half is unreachable here
// because state.mode is always 'battle'.
const cut=(from,to)=>{const i=src.indexOf(from),j=src.indexOf(to);
  if(i<0||j<0||j<i) throw new Error('slice failed: '+from);return src.slice(i,j)};
const region=cut('  /* Who named the book first','  function recordFinish() {')
  +cut('  function recordFinish() {','  function onHint() {')
  +cut('  const BATTLE_TRIES','  function route() {')
  +'\nglobalThis.SETTLE = BATTLE_SETTLE_MS;';

// --- stubs ---
const state={battle:null,battlePending:null,status:'idle',mode:'battle',hints:0,guesses:[],winAt:null,roundStart:Date.now()};
const stats={battle:{played:0,wins:0,losses:0,streak:0,maxStreak:0,hints:0,guesses:0,lastAt:null}};
const log=[];
const repaintLobby=()=>log.push('status: '+state.battle?.status+(state.battle?.failed?' [FAILED]':''));
const renderBattleLobby=(c,st)=>log.push('render: '+st);
const displayName=()=>'Tester';
const setMsg=t=>log.push('msg: '+t);
const origin=()=>'https://excerptle.io/';
const presetCount=()=>500;
const randomPresetIndex=()=>7;
const battleCode=()=>'zxdvhh';
const loadIndex=async()=>{};
const loadPeer=async()=>Peer;
const battleSend=()=>{};
const startPlay=async o=>log.push('startPlay '+JSON.stringify(o));
const renderExcerpt=()=>{},renderGuesses=()=>{},renderResult=()=>{},bump=()=>{};
const stopRoundTimers=()=>{};
const saveProgress=()=>{};
const loadStats=()=>stats;
const savePlayJSON=()=>{};
const K={stats:'s'};
const MAX_HINTS=5;
const $=()=>null;

class Emitter{
  constructor(){this.h={}}
  on(k,f){(this.h[k]=this.h[k]||[]).push(f);return this}
  emit(k,...a){ const own=this.owner||this.peer?.owner; if(own)state.battle=own; (this.h[k]||[]).forEach(f=>f(...a)) }
}
let hosts=new Map();   // registered ids -> peer
class Conn extends Emitter{
  constructor(peer,dst,passive){super();this.peer=peer;this.dst=dst;this.open=false;
    if(passive)return;
    _sT(()=>{
      const h=hosts.get(dst);
      if(!h){ peer.emit('error',{type:'peer-unavailable',message:'Could not connect to peer '+dst}); return; }
      this.open=true; this.emit('open');
      const inbound=new Conn(h,peer.id,true); inbound.open=true; inbound.peerConn=this; this.peerConn=inbound;
      h.emit('connection',inbound); _sT(()=>inbound.emit('open'),1);
    },20);
  }
  send(m){ log.push('send('+this.peer.id+'): '+JSON.stringify(m)); _sT(()=>this.peerConn?.emit('data',m),1); }
  close(){ this.open=false; this.emit('close'); }
}
class Peer extends Emitter{
  constructor(id){super();this.id=id||'g'+Math.random().toString(36).slice(2,8);
    this.destroyed=false;this.disconnected=false;
    _sT(()=>{
      if(this.destroyed)return;
      if(id&&hosts.has(id)&&hosts.get(id)!==this){this.destroyed=true;this.emit('error',{type:'unavailable-id',message:'ID taken'});return;}
      if(id)hosts.set(id,this);
      this.emit('open',this.id);
    },10);
  }
  connect(dst){return new Conn(this,dst)}
  reconnect(){ if(this.destroyed||this.frozen)return; this.disconnected=false;
    _sT(()=>{ if(hosts.has(this.id)&&hosts.get(this.id)!==this){this.destroyed=true;this.emit('error',{type:'unavailable-id'});return;}
      if(this.id.startsWith('bk-'))hosts.set(this.id,this); this.emit('open',this.id);},10); }
  destroy(){this.destroyed=true;if(hosts.get(this.id)===this)hosts.delete(this.id);this.disconnected=true;}
  // simulate the OS suspending the tab: socket dies, id is dropped
  suspend(){if(hosts.get(this.id)===this)hosts.delete(this.id);this.disconnected=true;this.frozen=true;}
  resume(){this.frozen=false;}
}
const window={Peer};
// Each simulated browser has its own globals: a timer scheduled by one page
// must fire with that page's state.battle in scope.
const _sT=global.setTimeout, _sI=global.setInterval;
const scopedT=(f,ms,...a)=>{const own=state.battle;return _sT(()=>{state.battle=own;f(...a)},ms)};
const scopedI=(f,ms,...a)=>{const own=state.battle;return _sI(()=>{state.battle=own;f(...a)},ms)};
eval('const setTimeout=scopedT, setInterval=scopedI;\n'+region);
const wait=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  // T1: host asleep when the guest arrives, wakes up 6s later
  await battleHost();
  const hostBattle=state.battle;
  hostBattle.peer.owner=hostBattle;
  await wait(60);
  console.log('T1 host id registered:', [...hosts.keys()]);
  hostBattle.peer.suspend();                       // host phone freezes the tab: no timers, no events
  console.log('T1 after suspend, ids:', [...hosts.keys()]);
  const hostPeerObj=hostBattle.peer;
  state.battle=null;                                // pretend a second browser
  const guestLog=[];
  await battleJoin('zxdvhh','7','Tester');
  const guestBattle=state.battle;
  guestBattle.peer.owner=guestBattle;
  await wait(3000);
  console.log('T1 guest tries after 3s:', guestBattle.tries, '| settled:', guestBattle.settled, '|', guestBattle.status);
  // host tab comes back
  hostBattle.peer.resume();                        // host taps back into the browser
  const saved=state.battle; state.battle=hostBattle; wakeBattle(); state.battle=saved;
  await wait(2500);
  console.log('T1 guest settled after host returns:', guestBattle.settled, '|', guestBattle.status);
  await wait(300);
  console.log('T1 host sees peer:', hostBattle.peerName, '|', hostBattle.status);
  console.log('T1 guest sees peer:', guestBattle.peerName, '| playIndex:', guestBattle.playIndex);
  // host presses Start
  state.battle=hostBattle; hostBattle.conn.send({type:'start',playIndex:hostBattle.playIndex});
  await wait(200);
  console.log('T1 start relayed:', log.filter(l=>l.startsWith('startPlay')).join(' ; '));

  // T3: book #0 must survive the hello (it used to read as "no index")
  hosts.clear(); state.battle=null; log.length=0;
  await battleHost(0);
  const h3=state.battle; h3.peer.owner=h3; await wait(60);
  state.battle=null;
  await battleJoin('zxdvhh', undefined, undefined);
  const g3=state.battle; g3.peer.owner=g3; g3.playIndex=42; await wait(300);
  console.log('T3 guest playIndex after hello:', g3.playIndex, '(host had', h3.playIndex + ')');

  // T4: the server is still holding a stale socket on our code
  hosts.clear(); state.battle=null;
  const squatter=new Peer('bk-zxdvhh'); await wait(50);
  await battleHost(5);
  const h4=state.battle; h4.peer.owner=h4;
  await wait(60);
  console.log('T4 while the code is taken:', h4.status, '| failed:', !!h4.failed);
  squatter.destroy();
  await wait(4000);
  console.log('T4 after the squatter leaves:', h4.status, '| id back:', hosts.has('bk-zxdvhh'));

  // T2: room that never opens -> gives up with a retry offer
  hosts.clear(); state.battle=null;
  await battleJoin('nobody7','3');
  const g2=state.battle;
  const started=Date.now();
  while(!g2.failed && Date.now()-started<120000) await wait(500);
  console.log('T2 gave up after', ((Date.now()-started)/1000).toFixed(1)+'s, tries='+g2.tries, '|', g2.status, '| failed:', g2.failed);

  /* T5: both players name the book. Whoever got there first from their own
     starting gun keeps it, and a dead heat goes to the host — so the two
     browsers can never each pick themselves. */
  const browser = (role, winAt) => {
    state.battle = { role, conn: { open: true }, committed: false };
    state.mode = 'battle'; state.status = 'won'; state.winAt = winAt; state.beatenBy = null;
    state.guesses = ['x']; state.hints = 0;
    stats.battle = { played: 0, wins: 0, losses: 0, streak: 3, maxStreak: 3, hints: 0, guesses: 0, lastAt: null };
    recordFinish();                       // what onGuess does on a local win
    return () => state.status + '/' + (state.beatenBy || '-');
  };
  const race = async (hostMs, guestMs) => {
    const h = browser('host', hostMs);
    await onBattleData({ type: 'win', name: 'Guest', at: guestMs });
    const host = h();
    const g = browser('guest', guestMs);
    await onBattleData({ type: 'win', name: 'Host', at: hostMs });
    return `host ${host}  guest ${g()}`;
  };
  console.log('T5 host first  :', await race(10000, 10100));
  console.log('T5 guest first :', await race(10100, 10000));
  console.log('T5 dead heat   :', await race(10000, 10000));

  // T6: the loser's tally records one loss, never a win it briefly held.
  browser('guest', 10100);
  await onBattleData({ type: 'win', name: 'Host', at: 10000 });
  await wait(SETTLE + 200);     // the provisional win must not land
  console.log('T6 loser tally :', JSON.stringify({ played: stats.battle.played, wins: stats.battle.wins, losses: stats.battle.losses, streak: stats.battle.streak }));

  // T7: an uncontested win settles after the grace period, once.
  browser('host', 10000);
  await wait(SETTLE + 200);
  await onBattleData({ type: 'win', name: 'Guest', at: 10500 });   // late, and slower
  console.log('T7 winner tally:', JSON.stringify({ played: stats.battle.played, wins: stats.battle.wins, losses: stats.battle.losses, streak: stats.battle.streak }), '| status:', state.status);

  // T8: an opponent out of guesses is reported, and does not end our round.
  state.battle = { role: 'host', conn: { open: true }, committed: false };
  state.status = 'playing'; state.winAt = null; log.length = 0;
  await onBattleData({ type: 'lose', name: 'Guest' });
  console.log('T8 out of guesses:', state.status, '|', log.filter(l => l.startsWith('msg:')).join(''), '| peerOut:', state.battle.peerOut);

  // T9: a duplicate "start" cannot restart a guest mid-round.
  state.battle = { role: 'guest', playIndex: 7, started: true, conn: { open: true } };
  state.mode = 'battle'; state.puzzle = { id: 'g1' }; log.length = 0;
  await onBattleData({ type: 'start', playIndex: 7 });
  console.log('T9 duplicate start:', log.filter(l => l.startsWith('startPlay')).length === 0 ? 'ignored' : 'RESTARTED');

  // T10: the host's own Start is guarded by state, not by a disabled button —
  // a second tap must not restart the round it just began.
  state.battle = { role: 'host', playIndex: 7, conn: { open: true } };
  state.mode = 'battle'; state.puzzle = null; log.length = 0;
  const first = await startBattleAsHost();
  const second = await startBattleAsHost();
  console.log('T10 host start :', `first ${first}, second ${second}, startPlay x${log.filter(l => l.startsWith('startPlay')).length}`);
  // And no round begins at all before a guest is actually connected.
  state.battle = { role: 'host', playIndex: 7, conn: null }; log.length = 0;
  console.log('T10 no guest   :', await startBattleAsHost(), '| startPlay x' + log.filter(l => l.startsWith('startPlay')).length);
  process.exit(0);
})();
