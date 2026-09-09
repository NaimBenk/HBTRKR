// Real Firestore rule/transaction tests, with synthetic data on localhost ONLY.
// No dependency on Firebase credentials or permission to the production project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { initializeDocument, commitBatch, changesBetween, clone, habitId, SYNC_DOCUMENT } from '../src/sync-model.mjs';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if(!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)){
    throw new Error('Run npm run test:rules with the local Firestore emulator. Production is never a test target.');
}
const project = 'demo-hbtrk';
const origin = `http://${host}`;
const documents = `projects/${project}/databases/(default)/documents`;
const rules = readFileSync(new URL('../docs/firestore-hbtrk.rules', import.meta.url), 'utf8');
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const pureApp = source.slice(source.indexOf('const HABIT_STATUS'), source.indexOf('function showToast'));
const functions = ['normalizeHabitName','nextDateKey'].map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n');
const dates = source.split('\n').filter(line => /^const (formatDateKey|parseDateKey) =/.test(line)).join('\n');
const normalizeData = runInNewContext(`${pureApp}\n${dates}\n${functions}\nnormalizeData`, { habitId });
const normalize = data => clone(normalizeData(data));

// Unsigned Firebase test tokens are accepted only by the emulator.
function token(uid){
    if(uid === null) return null;
    if(uid === 'owner') return 'owner'; // Emulator-only fixture seeding, bypass rules.
    const now = Math.floor(Date.now()/1000);
    const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({alg:'none',type:'JWT'})}.${part({sub:uid,user_id:uid,iat:now,exp:now+3600,
        auth_time:now,iss:`https://securetoken.google.com/${project}`,aud:project,
        firebase:{sign_in_provider:'custom',identities:{}}})}.`;
}
async function request(path, { uid = null, method = 'GET', body } = {}){
    const auth = token(uid);
    const response = await fetch(origin + path, { method, redirect:'error',
        headers:{'Content-Type':'application/json', ...(auth ? {Authorization:`Bearer ${auth}`} : {})},
        body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(15000) });
    const result = await response.json();
    if(!response.ok) throw Object.assign(new Error(result.error?.message || JSON.stringify(result)),
        { status:response.status, code:result.error?.status });
    return result;
}
function encode(value){
    if(value === null) return {nullValue:null};
    if(Array.isArray(value)) return {arrayValue:{values:value.map(encode)}};
    if(typeof value === 'object') return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([k,v]) => [k,encode(v)]))}};
    if(typeof value === 'string') return {stringValue:value};
    if(typeof value === 'boolean') return {booleanValue:value};
    return Number.isInteger(value) ? {integerValue:String(value)} : {doubleValue:value};
}
function decode(value){
    if('nullValue' in value) return null;
    if(value.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k,v]) => [k,decode(v)]));
    if(value.arrayValue) return (value.arrayValue.values || []).map(decode);
    if('integerValue' in value) return Number(value.integerValue);
    return value.stringValue ?? value.booleanValue ?? value.doubleValue;
}
const path = (uid, id) => `users/${uid}/data/${id}`;
const write = (uid, key, value) => request(`/v1/${documents}/${key}`, {uid,method:'PATCH',body:{fields:encode(value).mapValue.fields}});
async function read(uid, key, transaction){
    try {
        // batchGet is also used by the Web SDK. The emulator's GET adapter
        // cannot decode a bytes-valued transaction from query parameters.
        const result = transaction
            ? (await request(`/v1/${documents}:batchGet`, {uid,method:'POST',body:{documents:[`${documents}/${key}`],transaction}}))[0].found
            : await request(`/v1/${documents}/${key}`, {uid});
        if(!result) return {exists:() => false, data:() => undefined};
        return {exists:() => true, data:() => decode({mapValue:{fields:result.fields}})};
    } catch(error){
        if(error.status === 404) return {exists:() => false, data:() => undefined};
        throw error;
    }
}
function run(uid){
    return async callback => {
        for(let attempt=0;attempt<5;attempt++){
            const {transaction} = await request(`/v1/${documents}:beginTransaction`, {uid,method:'POST',body:{options:{readWrite:{}}}});
            const writes = [];
            try {
                const result = await callback({get:key => read(uid,key,transaction),
                    set:(key,value) => writes.push({update:{name:`${documents}/${key}`,fields:encode(value).mapValue.fields}})});
                await request(`/v1/${documents}:commit`, {uid,method:'POST',body:{transaction,writes}});
                return result;
            } catch(error){
                await request(`/v1/${documents}:rollback`, {uid,method:'POST',body:{transaction}}).catch(()=>{});
                if(error.code !== 'ABORTED' || attempt === 4) throw error;
            }
        }
    };
}
async function loadRules(content){
    const result = await request(`/emulator/v1/projects/${project}:securityRules`, {method:'PUT',body:{rules:{files:[{content}]}}});
    assert.ok(!(result.issues || []).some(issue => issue.severity === 'ERROR'), JSON.stringify(result));
}
const denied = operation => assert.rejects(operation, error => error.code === 'PERMISSION_DENIED');
const uid = 'rules-' + randomUUID();
const legacy = path(uid,'fourpill'), target = path(uid,SYNC_DOCUMENT), marker = path(uid,'sync-v3-migration');
const migrate = (user = uid) => initializeDocument({run:run(user),target:path(user,SYNC_DOCUMENT),
    legacy:path(user,'fourpill'),marker:path(user,'sync-v3-migration'),normalize});
const legacyData = {habits:[{name:'Lecture',startDate:'2026-09-01',mode:'weekly',daysOfWeek:[0,1,2,3,4,5,6]}],
    tasks:[{id:'original',name:'Tâche conservée',date:'2026-09-09',kind:'task',status:'pending'}],
    completions:{'2026-09-09':{Lecture:'done'}},dayColors:{},taskRolloverSkips:{}};

test('deployed rule contract and production sync functions against Firestore emulator', async t => {
    await t.test('reproduces the exact legacy rules blocking v3 at login', async()=>{
        await loadRules(`rules_version = '2'; service cloud.firestore { match /databases/{database}/documents {
            match /users/{userId}/data/{docId} { allow read, write: if request.auth != null
                && request.auth.uid == userId && docId == "fourpill"; } } }`);
        await write('owner',legacy,legacyData);
        assert.deepEqual((await read(uid,legacy)).data(),legacyData);
        await denied(migrate());
        assert.equal((await read('owner',target)).exists(),false);
        assert.deepEqual((await read('owner',legacy)).data(),legacyData);
    });

    // Restore the complete current rules before every subsequent check.
    await loadRules(rules);
    let migrated;
    await t.test('corrected rules let the same login migrate all data atomically', async()=>{
        migrated = await migrate();
        assert.deepEqual(normalize(migrated),{...normalize(legacyData),_rev:1});
        assert.equal(migrated._syncVersion,3);
        assert.deepEqual((await read(uid,marker)).data(),{version:3});
        assert.deepEqual((await read(uid,legacy)).data(),legacyData);
        assert.equal((await read(uid,path(uid,'sync-v3-'+randomUUID()))).exists(),false);
    });

    await t.test('PC changes survive a stale phone write and a lost acknowledgement retry', async()=>{
        const pc = clone(migrated), phone = clone(migrated);
        pc.tasks.push({...pc.tasks[0],id:'pc-addition',name:'Ajout PC'});
        phone.tasks[0].status = 'done';
        phone.completions['2026-09-10'] = {Lecture:'done'};
        const send = async (before,after,stream=randomUUID()) => {
            const receipt = path(uid,'sync-v3-'+stream);
            const batch = {stream,sequence:1,changes:changesBetween(before,after)};
            return {result:await commitBatch({run:run(uid),target,receipt,batch,normalize}),receipt,batch};
        };
        await send(migrated,pc);
        const {result,receipt,batch} = await send(migrated,phone);
        assert.equal(result.conflicts.length,0);
        assert.ok(result.data.tasks.some(task=>task.id === 'pc-addition'));
        assert.equal(result.data.tasks.find(task=>task.id === 'original').status,'done');
        assert.equal(result.data.completions['2026-09-10'].Lecture,'done');
        const replay = await commitBatch({run:run(uid),target,receipt,batch,normalize});
        assert.deepEqual(replay,result);
        assert.deepEqual((await migrate()),result.data); // Reconnection must not reimport fourpill.
    });

    await t.test('another user and an anonymous visitor cannot read or overwrite private documents', async()=>{
        const ids = [target,legacy,marker,path(uid,'sync-v3-'+randomUUID())];
        for(const visitor of [null,'different-user']){
            for(const key of ids){
                await denied(read(visitor,key));
                await denied(write(visitor,key,migrated));
            }
        }
    });

    await t.test('old full-document writes are denied even to the owner; history is unchanged', async()=>{
        await denied(write(uid,legacy,{...legacyData,tasks:[]}));
        assert.deepEqual((await read(uid,legacy)).data(),legacyData);
    });

    await t.test('unrelated paths, listings, and document deletions stay forbidden', async()=>{
        for(const id of ['unexpected','sync-v3-anything','fourpill-v4']){
            await denied(read(uid,path(uid,id)));
            await denied(write(uid,path(uid,id),migrated));
        }
        await denied(request(`/v1/${documents}/users/${uid}/data`,{uid}));
        for(const key of [target,legacy,marker]){
            await denied(request(`/v1/${documents}/${key}`,{uid,method:'DELETE'}));
        }
    });

    await t.test('invalid calendars/receipts and marker changes cannot be saved', async()=>{
        for(const invalid of [{...migrated,_syncVersion:2},{...migrated,_rev:0},{...migrated,tasks:{}},{...migrated,completions:[]}]){
            await denied(write(uid,target,invalid));
        }
        const receipt = path(uid,'sync-v3-'+randomUUID());
        for(const invalid of [{sequence:0,conflicts:[]},{sequence:1,conflicts:'bad'},{sequence:1,conflicts:[],extra:true}]){
            await denied(write(uid,receipt,invalid));
        }
        await denied(write(uid,marker,{version:2}));
        await denied(write(uid,marker,{version:3}));
    });

    await t.test('a genuinely new user can create a private calendar without any legacy document', async()=>{
        const user = 'new-'+randomUUID();
        const created = await migrate(user);
        assert.deepEqual(created.habits,[]);
        assert.deepEqual(created.tasks,[]);
        assert.equal(created._syncVersion,3);
        assert.equal((await read(user,path(user,'fourpill'))).exists(),false);
    });

    await t.test('a missing migrated calendar cannot be silently replaced from an old copy', async()=>{
        await request(`/v1/${documents}/${target}`,{uid:'owner',method:'DELETE'});
        await assert.rejects(migrate(),/sync-document-missing/);
        assert.equal((await read('owner',target)).exists(),false);
    });
});
