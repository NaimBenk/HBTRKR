import { changesBetween, inverseChanges, applyChanges, clone } from './sync-model.mjs';

// Every unacknowledged batch has its own immutable localStorage key. Two tabs
// cannot overwrite one another's queue; only the server acknowledgement removes it.
export class SyncClient {
    constructor({ uid, storage, send, normalize, onView, onStatus, onConflict, online = () => true, id = () => crypto.randomUUID() }){
        Object.assign(this, { storage, send, normalize, onView, onStatus, onConflict, online, id });
        this.prefix = `hbtrk:sync:v3:${encodeURIComponent(uid)}:`;
        this.stream = id();
        this.sequence = 0;
        this.remote = null;
        this.view = null;
        this.serverConfirmed = false;
        this.stopped = false;
        this.retryAttempt = 0;
        this.readError = null;
        this.writeError = null;
        const cached = this.read('cache');
        if(cached) this.receive(cached, false);
    }
    read(suffix){
        const raw = this.storage.getItem(this.prefix + suffix);
        if(!raw) return null;
        // Never silently discard a corrupt pending batch or cache.
        return JSON.parse(raw);
    }
    write(suffix, value){ this.storage.setItem(this.prefix + suffix, JSON.stringify(value)); }
    batches(){
        const groups = new Map();
        for(let i = 0; i < this.storage.length; i++){
            const key = this.storage.key(i);
            if(!key?.startsWith(this.prefix + 'op:')) continue;
            const batch = JSON.parse(this.storage.getItem(key));
            if(!batch || !Array.isArray(batch.changes) || !batch.stream || !Number.isInteger(batch.sequence)) throw new Error('invalid-local-operation');
            if(!groups.has(batch.stream)) groups.set(batch.stream, []);
            groups.get(batch.stream).push(batch);
        }
        for(const group of groups.values()) group.sort((a,b) => a.sequence-b.sequence);
        const result = [];
        while(groups.size){
            const group = [...groups.values()].sort((a,b) => a[0].createdAt-b[0].createdAt || a[0].id.localeCompare(b[0].id))[0];
            const batch = group.shift();
            result.push(batch);
            if(!group.length) groups.delete(batch.stream);
        }
        return result;
    }
    history(){ return this.read('undo') || []; }
    storeHistory(history){
        history = history.slice(-20);
        while(history.length && JSON.stringify(history).length > 250000) history.shift();
        this.write('undo', history);
    }
    status(){
        if(this.stopped) return;
        if(!this.online()) this.onStatus('offline');
        else if(this.readError || this.writeError) this.onStatus('error', this.readError || this.writeError);
        else if(this.batches().length) this.onStatus('saving');
        else this.onStatus(this.read('conflicts')?.length ? 'conflict' : this.serverConfirmed ? 'saved' : 'loading');
    }
    failRead(error){
        if(this.stopped) return;
        this.readError = error;
        this.status();
    }
    receive(remote, confirmed = true){
        if(this.stopped) return;
        if(confirmed) this.readError = null;
        if(this.remote && (remote._rev || 0) < (this.remote._rev || 0)){
            // The acknowledgement can arrive after a newer live snapshot. The
            // queue may have shrunk meanwhile; remove its optimistic overlay.
            this.rebase();
            return;
        }
        this.remote = this.normalize(remote);
        this.serverConfirmed ||= confirmed;
        if(confirmed){
            // Cache is disposable; failure to cache must not lose a pending operation.
            try {
                if((this.read('cache')?._rev || 0) <= (this.remote._rev || 0)) this.write('cache', this.remote);
            } catch { this.onStatus('error', 'Le stockage local est plein. Exporte une sauvegarde.'); }
        }
        this.rebase();
    }
    rebase(){
        if(!this.remote || this.stopped) return;
        let view = clone(this.remote);
        for(const batch of this.batches()) view = applyChanges(view, batch.changes, { optimistic:true }).data;
        const changed = !this.view || changesBetween(this.view, view).length > 0;
        this.view = view;
        if(changed) this.onView(clone(view));
        this.status();
    }
    record(after, { undoable = true, restoring = false } = {}){
        if(!this.view || this.stopped) throw new Error('sync-not-ready');
        const normalized = this.normalize(after);
        const changes = changesBetween(this.view, normalized);
        if(!changes.length) return false;
        if(restoring) changes.forEach(change => { if(change.kind === 'add') change.restore = true; });
        const batch = { id:this.id(), stream:this.stream, sequence:++this.sequence, createdAt:Date.now(), changes };
        // Synchronous durability BEFORE advancing the baseline or starting network I/O.
        this.write('op:' + batch.id, batch);
        if(undoable){
            try { this.storeHistory([...this.history(), { id:batch.id, changes:inverseChanges(changes) }]); }
            catch { /* Undo storage is optional; the durable pending write is not. */ }
        }
        this.view = normalized;
        this.status();
        return true;
    }
    undo(){
        const history = this.history(), last = history.at(-1);
        if(!last || !this.view) return false;
        const result = applyChanges(this.view, last.changes);
        if(result.conflicts.length){
            this.write('conflicts', [...(this.read('conflicts') || []), { undo:last, conflicts:result.conflicts }].slice(-20));
        }
        if(this.record(result.data, { undoable:false, restoring:true })) this.onView(clone(this.view));
        this.storeHistory(history.slice(0,-1));
        if(result.conflicts.length) this.onConflict(result.conflicts);
        this.status();
        return true;
    }
    flush(){
        if(this.stopped) return Promise.resolve(false);
        if(this.inFlight) return this.inFlight;
        clearTimeout(this.retryTimer);
        if(!this.online()){ this.status(); return Promise.resolve(false); }
        this.inFlight = this.drain().finally(() => { this.inFlight = null; this.status(); });
        return this.inFlight;
    }
    async drain(){
        try {
            let batch;
            while(!this.stopped && (batch = this.batches()[0])){
                this.status();
                const watchdog = setTimeout(() => {
                    if(!this.stopped) this.onStatus(this.online() ? 'error' : 'offline', 'Le serveur tarde à répondre. Les changements restent enregistrés sur cet appareil.');
                }, 15000);
                let result;
                try { result = await this.send(batch); }
                finally { clearTimeout(watchdog); }
                if(this.stopped) return false;
                this.writeError = null;
                // Capture competing edits before rebasing the optimistic UI.
                if(result.conflicts.length){
                    this.write('conflicts', [...(this.read('conflicts') || []), { batch, conflicts:result.conflicts }].slice(-20));
                    this.onConflict(result.conflicts);
                }
                this.storage.removeItem(this.prefix + 'op:' + batch.id);
                this.receive(result.data, true);
            }
            this.retryAttempt = 0;
            this.status();
            return true;
        } catch(error){
            if(this.stopped) return false;
            this.writeError = error;
            this.status();
            this.retryTimer = setTimeout(() => this.flush(), Math.min(30000, 1000 * 2 ** Math.min(this.retryAttempt++,5)));
            return false;
        }
    }
    stop(){ this.stopped = true; clearTimeout(this.retryTimer); }
}
