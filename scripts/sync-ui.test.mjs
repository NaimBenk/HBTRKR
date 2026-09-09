import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const extract = name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0];

test('an initial access failure shows a visible explanation and prevents empty imports/exports',()=>{
    const context={initialSynced:false,localPreviewMode:false,
        syncStatus:{dataset:{},setAttribute(){}},syncStatusLabel:{},
        syncNotice:{hidden:true},syncNoticeMessage:{},addHabitBtn:{},menuImport:{},menuExport:{},
        updateUndoButton(){},showInitialSyncState(){}};
    runInNewContext(`${extract('setSyncStatus')}\nsetSyncStatus('error','Accès Firebase refusé');`,context);
    assert.equal(context.syncNotice.hidden,false);assert.equal(context.syncNoticeMessage.textContent,'Accès Firebase refusé');
    assert.equal(context.addHabitBtn.disabled,true);assert.equal(context.menuImport.disabled,true);assert.equal(context.menuExport.disabled,true);
    context.initialSynced=true;
    runInNewContext("setSyncStatus('saved');",context);
    assert.equal(context.syncNotice.hidden,true);assert.equal(context.addHabitBtn.disabled,false);assert.equal(context.menuExport.disabled,false);
});

test('a cached calendar remains usable and exportable during an access error',()=>{
    const context={initialSynced:true,localPreviewMode:false,
        syncStatus:{dataset:{},setAttribute(){}},syncStatusLabel:{},
        syncNotice:{hidden:true},syncNoticeMessage:{},addHabitBtn:{},menuImport:{},menuExport:{},
        updateUndoButton(){},showInitialSyncState(){throw Error('must not replace cached calendar');}};
    runInNewContext(`${extract('setSyncStatus')}\nsetSyncStatus('error','Accès Firebase refusé');`,context);
    assert.equal(context.syncNotice.hidden,false);assert.equal(context.menuExport.disabled,false);
});

test('Home and Day navigation cannot render a fake empty calendar before the first load',()=>{
    let placeholders=0;
    const context={initialSynced:false,localPreviewMode:false,showInitialSyncState(){placeholders++;}};
    runInNewContext(`${extract('router')}\n${extract('showDayPage')}\n${extract('goHome')}\nrouter();showDayPage('2026-09-09');goHome();`,context);
    assert.equal(placeholders,3);
});
