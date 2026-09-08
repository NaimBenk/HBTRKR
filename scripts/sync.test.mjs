import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient } from '../src/sync-client.mjs';
import { applyChanges, changesBetween, inverseChanges, commitBatch, initializeDocument, habitId, clone, SYNC_DOCUMENT, SYNC_VERSION } from '../src/sync-model.mjs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the actual app's normalization/backup code, not a copy of its schema.
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const pureApp = appSource.slice(appSource.indexOf('const HABIT_STATUS'), appSource.indexOf('function showToast'));
const functions = ['normalizeHabitName','nextDateKey'].map(name => appSource.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n');
const dates = appSource.split('\n').filter(line => /^const (formatDateKey|parseDateKey) =/.test(line)).join('\n');
const appModel = runInNewContext(`${pureApp}\n${dates}\n${functions}\n({normalizeData,exportableData,validateBackupData})`, { habitId });
const normalize = raw => clone(appModel.normalizeData(raw));

const task = (id, extra={}) => ({ id, name:id, date:'2026-09-07', kind:'task', status:'pending', important:false, rolloverFromId:null, rolloverRootId:null, ...extra });
const habit = { id:'h1', name:'Lecture', startDate:'2026-09-01', mode:'weekly', daysOfWeek:[0,1,2,3,4,5,6] };
const base = () => ({ habits:[clone(habit)], tasks:[task('one'),task('two')], completions:{}, dayColors:{}, taskRolloverSkips:{}, _rev:1, _syncVersion:SYNC_VERSION });
const edit = (state, action) => { const result=clone(state); action(result); return result; };
const merge = (remote, before, after) => applyChanges(remote, changesBetween(before,after));
class Storage {
    values=new Map(); fail=false;
    get length(){return this.values.size;}
    key(index){return [...this.values.keys()][index];}
    getItem(key){return this.values.get(key) ?? null;}
    setItem(key,value){if(this.fail) throw new Error('quota'); this.values.set(key,value);}
    removeItem(key){this.values.delete(key);}
}

// Optimistic transaction harness: a conflicting commit retries against fresh
// server state, just as Firestore does. No account or production writes involved.
class Server {
    docs=new Map([[SYNC_DOCUMENT,base()]]); versions=new Map(); retries=0;
    snapshot(key){const value=this.docs.get(key); return { exists:()=>value!==undefined, data:()=>value===undefined ? undefined : clone(value) };}
    run=async callback => {
        for(let attempt=0;attempt<30;attempt++){
            const reads=new Map(), writes=new Map();
            const result=await callback({
                get:async key=>{reads.set(key,this.versions.get(key)||0); await Promise.resolve(); return this.snapshot(key);},
                set:(key,value)=>writes.set(key,clone(value))
            });
            if([...reads].some(([key,version])=>(this.versions.get(key)||0)!==version)){this.retries++;continue;}
            for(const [key,value] of writes){this.docs.set(key,value);this.versions.set(key,(this.versions.get(key)||0)+1);}
            return result;
        }
        throw new Error('contention');
    };
    send=batch=>commitBatch({run:this.run,target:SYNC_DOCUMENT,receipt:'receipt:'+batch.stream,batch,normalize:clone});
    get value(){return this.docs.get(SYNC_DOCUMENT);}
}
function client(server, {storage=new Storage(),uid='alice',online=()=>true,send=server.send}={}){
    const states=[], conflicts=[], views=[];
    const result=new SyncClient({uid,storage,send,normalize:clone,online,
        onStatus:state=>states.push(state),onConflict:value=>conflicts.push(value),onView:view=>views.push(view)});
    result.receive(server.value,true);
    return Object.assign(result,{states,conflicts,views});
}

test('reproduces old full-document loss; targeted transaction preserves PC + stale phone changes',async()=>{
    const server=new Server(), pc=client(server), phone=client(server);
    pc.record(edit(pc.view,d=>{d.tasks.push(task('PC-new'));d.tasks[0].status='done';d.dayColors['2026-09-07']='purple';}));
    await pc.flush();
    phone.record(edit(phone.view,d=>d.tasks[1].important=true));
    await phone.flush();
    assert.equal(server.value.tasks.find(t=>t.id==='one').status,'done');
    assert.ok(server.value.tasks.some(t=>t.id==='PC-new'));
    assert.equal(server.value.tasks.find(t=>t.id==='two').important,true);
    assert.equal(server.value.dayColors['2026-09-07'],'purple');
    pc.stop();phone.stop();
});
test('simultaneous transactions retry and preserve edits to different fields of the same task',async()=>{
    const server=new Server(), a=client(server), b=client(server);
    a.record(edit(a.view,d=>d.tasks[0].status='done'));
    b.record(edit(b.view,d=>d.tasks[0].name='renamed'));
    await Promise.all([a.flush(),b.flush()]);
    assert.ok(server.retries>0);
    assert.equal(server.value.tasks[0].status,'done');assert.equal(server.value.tasks[0].name,'renamed');
    a.stop();b.stop();
});
test('offline queue survives browser shutdown and merges into the latest server',async()=>{
    const server=new Server(), storage=new Storage(), phone=client(server,{storage,online:()=>false}), pc=client(server);
    phone.record(edit(phone.view,d=>d.tasks[1].status='later'));
    await phone.flush();assert.equal(phone.states.at(-1),'offline');phone.stop();
    pc.record(edit(pc.view,d=>d.tasks.push(task('PC-offline-new'))));await pc.flush();
    const reopened=client(server,{storage});await reopened.flush();
    assert.ok(server.value.tasks.some(t=>t.id==='PC-offline-new'));
    assert.equal(server.value.tasks.find(t=>t.id==='two').status,'later');
    assert.equal(reopened.batches().length,0);pc.stop();reopened.stop();
});
test('remote snapshots during a local pending write are rebased, never ignored',async()=>{
    const server=new Server(), a=client(server), b=client(server);
    a.record(edit(a.view,d=>d.tasks[0].important=true));
    b.record(edit(b.view,d=>d.tasks.push(task('remote'))));await b.flush();
    a.receive(server.value,true);
    assert.ok(a.view.tasks.some(t=>t.id==='remote'));assert.equal(a.view.tasks[0].important,true);
    await a.flush();assert.ok(server.value.tasks.some(t=>t.id==='remote'));a.stop();b.stop();
});
test('lost acknowledgement retries once logically, including after a later delete',async()=>{
    const server=new Server(), storage=new Storage();let drop=true;
    const a=client(server,{storage,send:async batch=>{const result=await server.send(batch);if(drop){drop=false;throw new Error('lost ack');}return result;}});
    a.record(edit(a.view,d=>d.tasks.push(task('new'))));await a.flush();a.stop();
    const b=client(server);b.record(edit(b.view,d=>d.tasks=d.tasks.filter(t=>t.id!=='new')));await b.flush();
    const replay=client(server,{storage});await replay.flush();
    assert.ok(!server.value.tasks.some(t=>t.id==='new'));assert.equal(replay.batches().length,0);b.stop();replay.stop();
});
test('a stale edit never resurrects a deleted task; conflict remains locally recoverable',async()=>{
    const server=new Server(), a=client(server), b=client(server);
    a.record(edit(a.view,d=>d.tasks=d.tasks.filter(t=>t.id!=='one')));await a.flush();
    b.record(edit(b.view,d=>d.tasks[0].status='done'));await b.flush();
    assert.ok(!server.value.tasks.some(t=>t.id==='one'));assert.equal(b.states.at(-1),'conflict');
    assert.equal(b.read('conflicts')[0].conflicts[0].after,'done');a.stop();b.stop();
});
test('same-field conflict preserves server progress and retains the other edit',async()=>{
    const server=new Server(), a=client(server), b=client(server);
    a.record(edit(a.view,d=>d.tasks[0].status='done'));await a.flush();
    b.record(edit(b.view,d=>d.tasks[0].status='skipped'));await b.flush();
    assert.equal(server.value.tasks[0].status,'done');assert.equal(b.read('conflicts')[0].conflicts[0].after,'skipped');
    a.stop();b.stop();
});
test('new actions while a transaction is in flight are drained and acknowledged',async()=>{
    const server=new Server();let release;
    const gate=new Promise(r=>release=r);let first=true;
    const a=client(server,{send:async batch=>{if(first){first=false;await gate;}return server.send(batch);}});
    a.record(edit(a.view,d=>d.tasks[0].status='done'));const saving=a.flush();
    a.record(edit(a.view,d=>d.tasks[1].status='done'));release();await saving;
    assert.equal(a.batches().length,0);assert.ok(server.value.tasks.every(t=>t.status==='done'));a.stop();
});
test('two tabs share durable immutable batches without overwriting each other',async()=>{
    const server=new Server(),storage=new Storage(),a=client(server,{storage}),b=client(server,{storage});
    a.record(edit(a.view,d=>d.tasks[0].status='done'));b.record(edit(b.view,d=>d.tasks[1].important=true));
    await Promise.all([a.flush(),b.flush()]);
    assert.equal(server.value.tasks[0].status,'done');assert.equal(server.value.tasks[1].important,true);
    assert.equal(a.batches().length,0);a.stop();b.stop();
});
test('habit rename on phone retains concurrent PC completions under the new name',async()=>{
    const server=new Server(),a=client(server),b=client(server);
    a.record(edit(a.view,d=>d.completions['2026-09-07']={Lecture:'done'}));await a.flush();
    b.record(edit(b.view,d=>d.habits[0].name='Lire'));await b.flush();
    assert.deepEqual(server.value.completions,{'2026-09-07':{Lire:'done'}});a.stop();b.stop();
});
test('completion from an old habit name is applied to the renamed stable habit id',()=>{
    const initial=base(),remote=edit(initial,d=>d.habits[0].name='Lire');
    const local=edit(initial,d=>d.completions['2026-09-07']={Lecture:'done'});
    assert.deepEqual(merge(remote,initial,local).data.completions,{'2026-09-07':{Lire:'done'}});
});
test('independent completion dates, colors and skip markers merge without replacing maps',()=>{
    const initial=base();
    const pc=edit(initial,d=>{d.completions['2026-09-06']={Lecture:'done'};d.dayColors['2026-09-06']='green';d.taskRolloverSkips['2026-09-07']=['a'];});
    const phone=edit(initial,d=>{d.completions['2026-09-07']={Lecture:'done'};d.dayColors['2026-09-07']='red';d.taskRolloverSkips['2026-09-07']=['b'];});
    const result=merge(pc,initial,phone).data;
    assert.equal(Object.keys(result.completions).length,2);assert.equal(Object.keys(result.dayColors).length,2);
    assert.deepEqual(new Set(result.taskRolloverSkips['2026-09-07']),new Set(['a','b']));
});
test('concurrent rollover generation is idempotent and cannot resurrect a skipped copy',()=>{
    const initial=base();initial.tasks=[task('root',{date:'2026-09-06',status:'later'})];
    const rolled=edit(initial,d=>d.tasks.push(task('rollover:root:2026-09-07',{status:'later',rolloverRootId:'root',rolloverFromId:'root'})));
    assert.equal(merge(rolled,initial,rolled).data.tasks.length,2);
    const deleted=edit(initial,d=>d.taskRolloverSkips['2026-09-07']=['root']);
    assert.equal(merge(deleted,initial,rolled).data.tasks.length,1);
    const completed=edit(initial,d=>d.tasks[0].status='done');
    assert.equal(merge(completed,initial,rolled).data.tasks.length,1);
});
test('undo restores a deleted task without removing a newer remote task',async()=>{
    const server=new Server(),a=client(server),b=client(server);
    a.record(edit(a.view,d=>d.tasks=d.tasks.filter(t=>t.id!=='one')));await a.flush();
    b.receive(server.value,true);b.record(edit(b.view,d=>d.tasks.push(task('remote-new'))));await b.flush();
    a.receive(server.value,true);a.undo();await a.flush();
    assert.deepEqual(server.value.tasks.map(t=>t.id),['one','two','remote-new']);a.stop();b.stop();
});
test('undo cannot erase a concurrent edit to an item created locally',async()=>{
    const server=new Server(),a=client(server),b=client(server);
    a.record(edit(a.view,d=>d.tasks.push(task('new'))));await a.flush();
    b.receive(server.value,true);b.record(edit(b.view,d=>d.tasks.find(t=>t.id==='new').status='done'));await b.flush();
    a.receive(server.value,true);a.undo();await a.flush();
    assert.equal(server.value.tasks.find(t=>t.id==='new').status,'done');assert.ok(a.conflicts.length);a.stop();b.stop();
});
test('order edits keep concurrent additions, deletions and intrinsic habit order',()=>{
    const initial=base(),reordered=edit(initial,d=>d.tasks.reverse());
    const remote=edit(initial,d=>d.tasks.push(task('new')));
    assert.deepEqual(merge(remote,initial,reordered).data.tasks.map(t=>t.id),['two','one','new']);
});
test('quota failure does not advance local baseline or pretend an edit was queued',()=>{
    const server=new Server(),storage=new Storage(),a=client(server,{storage});storage.fail=true;
    assert.throws(()=>a.record(edit(a.view,d=>d.tasks[0].status='done')),/quota/);
    assert.equal(a.view.tasks[0].status,'pending');assert.equal(a.batches().length,0);a.stop();
});
test('history is bounded to 20 changes; metadata-only ack does not rerender UI',async()=>{
    const server=new Server(),a=client(server);const views=a.views.length;
    for(let i=0;i<25;i++) a.record(edit(a.view,d=>d.tasks[0].name='name-'+i));
    await a.flush();assert.equal(a.history().length,20);assert.equal(a.views.length,views);a.stop();
});
test('an older transaction response cannot roll the visible state backwards',()=>{
    const server=new Server(),a=client(server),newer=edit(server.value,d=>{d._rev=20;d.tasks.push(task('new'));});
    a.receive(newer,true);a.receive(server.value,true);assert.ok(a.view.tasks.some(t=>t.id==='new'));a.stop();
});
test('account switch cannot replay one user queue for another user',async()=>{
    const storage=new Storage(),server=new Server(),a=client(server,{storage,uid:'alice'});
    a.record(edit(a.view,d=>d.tasks.push(task('alice-secret'))));a.stop();
    const b=client(server,{storage,uid:'bob'});assert.equal(b.batches().length,0);await b.flush();
    assert.ok(!server.value.tasks.some(t=>t.id==='alice-secret'));b.stop();
});
test('an old app full overwrite is isolated from canonical v3 progress',async()=>{
    const server=new Server(),a=client(server);a.record(edit(a.view,d=>d.tasks.push(task('protected'))));await a.flush();
    server.docs.set('fourpill',base());assert.ok(server.value.tasks.some(t=>t.id==='protected'));a.stop();
});
test('a missing server document is never re-created from a stale client snapshot',async()=>{
    const server=new Server(),a=client(server);a.record(edit(a.view,d=>d.tasks[0].status='done'));
    server.docs.delete(SYNC_DOCUMENT);await a.flush();
    assert.ok(!server.docs.has(SYNC_DOCUMENT));assert.equal(a.batches().length,1);assert.equal(a.states.at(-1),'error');a.stop();
});

test('bulk delete undo restores task order and separators exactly',()=>{
    const initial=base();initial.tasks=[task('a'),task('space',{kind:'separator',name:''}),task('b'),task('c')];
    const deleted=edit(initial,d=>d.tasks=[]);
    assert.deepEqual(applyChanges(deleted,inverseChanges(changesBetween(initial,deleted))).data.tasks,initial.tasks);
});

test('undo archival restores both the habit and its checked days',()=>{
    const initial=base();initial.completions={'2026-09-07':{Lecture:'done'}};
    const archived=edit(initial,d=>{d.habits[0].deletedAt='2026-09-07';d.completions={};});
    const restored=applyChanges(archived,inverseChanges(changesBetween(initial,archived)));
    assert.equal(restored.conflicts.length,0);assert.deepEqual(restored.data,initial);
});

test('stale archival or import removal cannot silently discard newly checked habits',()=>{
    const initial=base(),remote=edit(initial,d=>d.completions['2026-09-07']={Lecture:'done'});
    for(const local of [edit(initial,d=>d.habits[0].deletedAt='2026-09-07'),edit(initial,d=>d.habits=[])]){
        const result=merge(remote,initial,local);
        assert.equal(result.conflicts.length,1);assert.equal(result.data.completions['2026-09-07'].Lecture,'done');
        assert.equal(result.data.habits[0].deletedAt,undefined);
    }
});

test('late rejected acknowledgement removes the optimistic overlay after a newer snapshot',async()=>{
    const server=new Server();let a;
    a=client(server,{send:async batch=>{
        server.docs.set(SYNC_DOCUMENT,edit(server.value,d=>{d.tasks[0].status='done';d._rev++;}));
        const result=await server.send(batch);
        server.docs.set(SYNC_DOCUMENT,edit(server.value,d=>{d.tasks.push(task('newer'));d._rev++;}));
        a.receive(server.value,true);
        return result;
    }});
    a.record(edit(a.view,d=>d.tasks[0].status='skipped'));await a.flush();
    assert.equal(a.view.tasks[0].status,'done');assert.ok(a.view.tasks.some(t=>t.id==='newer'));a.stop();
});

test('migration is transactional, preserves legacy, and is performed only once',async()=>{
    const server=new Server();server.docs.delete(SYNC_DOCUMENT);server.docs.set('fourpill',base());
    const migrate=()=>initializeDocument({run:server.run,target:SYNC_DOCUMENT,legacy:'fourpill',marker:'migration',normalize});
    await Promise.all([migrate(),migrate()]);
    assert.deepEqual(server.docs.get('fourpill'),base());assert.equal(server.value._syncVersion,SYNC_VERSION);
    const a=client(server);a.record(edit(a.view,d=>d.tasks.push(task('protected'))));await a.flush();
    server.docs.set('fourpill',base());await migrate();assert.ok(server.value.tasks.some(t=>t.id==='protected'));
    server.docs.delete(SYNC_DOCUMENT);await assert.rejects(migrate(),/sync-document-missing/);a.stop();
});

test('real normalizer/export retain stable ids, same-name independent tasks, colors, flags and history',()=>{
    const raw=base();raw.habits[0].bestStreak=11;raw.habits[0].deletedAt='2026-09-09';
    raw.tasks=[task('a',{name:'Same',important:true,status:'done'}),task('b',{name:'Same',status:'later'}),task('s',{kind:'separator',name:''})];
    raw.dayColors={'2026-09-07':'orange'};raw.completions={'2026-09-07':{Lecture:'done'}};raw.taskRolloverSkips={'2026-09-07':['root']};
    const canonical=normalize(raw),backup=clone(appModel.exportableData(canonical));
    assert.ok(appModel.validateBackupData(backup));assert.deepEqual(clone(appModel.exportableData(normalize(backup))),backup);
    assert.equal(backup.tasks.length,3);assert.equal(backup.habits[0].id,'h1');assert.equal(backup.habits[0].bestStreak,11);
    assert.equal(backup.tasks[0].important,true);assert.equal(backup.tasks[1].status,'later');assert.equal(backup.dayColors['2026-09-07'],'orange');
});

test('real app normalizer and transaction preserve PC edits when offline phone renames',async()=>{
    const server=new Server();server.docs.set(SYNC_DOCUMENT,{...normalize(base()),_syncVersion:SYNC_VERSION});
    const send=batch=>commitBatch({run:server.run,target:SYNC_DOCUMENT,receipt:'receipt:'+batch.stream,batch,normalize});
    const a=client(server,{send}),b=client(server,{send});
    a.record(edit(a.view,d=>{d.tasks[0].status='done';d.completions['2026-09-07']={Lecture:'done'};}));await a.flush();
    b.record(edit(b.view,d=>{d.habits[0].name='Lire';d.tasks[1].name='New';}));await b.flush();
    assert.equal(server.value.tasks[0].status,'done');assert.equal(server.value.completions['2026-09-07'].Lire,'done');a.stop();b.stop();
});

test('Undo of deleted rollover remains an explicit restoration even if origin was completed elsewhere',async()=>{
    const server=new Server();server.docs.set(SYNC_DOCUMENT,edit(base(),d=>d.tasks=[task('root',{date:'2026-09-06',status:'later'}),
        task('copy',{status:'later',rolloverRootId:'root',rolloverFromId:'root'})]));
    const a=client(server),b=client(server);
    a.record(edit(a.view,d=>{d.tasks=d.tasks.filter(t=>t.id!=='copy');d.taskRolloverSkips['2026-09-07']=['root'];}));await a.flush();
    b.receive(server.value,true);b.record(edit(b.view,d=>d.tasks[0].status='done'));await b.flush();
    a.receive(server.value,true);a.undo();await a.flush();
    assert.equal(server.value.tasks.find(t=>t.id==='root').status,'done');assert.ok(server.value.tasks.some(t=>t.id==='copy'));
    a.stop();b.stop();
});

test('unusual imported ids do not collide with object prototype properties',()=>{
    const initial=base(),local=edit(initial,d=>d.tasks.push(task('toString'),task('__proto__')));
    assert.equal(merge(initial,initial,local).data.tasks.length,4);
});
