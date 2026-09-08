// Pure, replayable changes. A missing item in a stale device is never a deletion.
export const SYNC_DOCUMENT = 'fourpill-v3';
export const SYNC_VERSION = 3;
export const clone = value => JSON.parse(JSON.stringify(value));
export function equal(a, b){
    if((a ?? null) === (b ?? null)) return true;
    if(!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable:true, writable:true, configurable:true });
const records = entries => Object.assign(Object.create(null), Object.fromEntries(entries));
export const habitId = habit => typeof habit.id === 'string' && habit.id ? habit.id : `legacy:${encodeURIComponent(String(habit.name).trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr-FR'))}`;

function model(data){
    const habits = records((data.habits || []).map(h => [habitId(h), { ...h, id:habitId(h) }]));
    const names = new Map(Object.values(habits).map(h => [h.name, h.id]));
    const completions = {};
    for(const [date, values] of Object.entries(data.completions || {})){
        for(const [name, status] of Object.entries(values)){
            if(names.has(name)) put(completions, JSON.stringify([date, names.get(name)]), status);
        }
    }
    const skips = {};
    for(const [date, ids] of Object.entries(data.taskRolloverSkips || {})){
        for(const id of ids) put(skips, JSON.stringify([date, id]), true);
    }
    const taskOrder = {};
    for(const task of data.tasks || []){
        taskOrder[task.date] ||= [];
        taskOrder[task.date].push(task.id);
    }
    return { habits, tasks:records((data.tasks || []).map(t => [t.id, t])),
        completions, skips, dayColors:data.dayColors || {},
        habitOrder:Object.keys(habits), taskOrder };
}

export function changesBetween(beforeData, afterData){
    const before = model(beforeData), after = model(afterData), changes = [];
    for(const table of ['habits', 'tasks']){
        for(const id of new Set([...Object.keys(before[table]), ...Object.keys(after[table])])){
            const old = before[table][id], next = after[table][id];
            if(!old || !next){
                const previous = (state, value) => {
                    if(!value) return null;
                    const list = table === 'habits' ? state.habitOrder : state.taskOrder[value.date] || [];
                    return list[list.indexOf(id)-1] || null;
                };
                changes.push({ kind:next ? 'add' : 'remove', table, id, before:old || null, after:next || null,
                    beforePrevious:previous(before, old), afterPrevious:previous(after, next) });
                continue;
            }
            for(const field of new Set([...Object.keys(old), ...Object.keys(next)])){
                if(!equal(old[field], next[field])) changes.push({ kind:'field', table, id, field, before:old[field] ?? null, after:next[field] ?? null });
            }
        }
    }
    for(const table of ['completions', 'skips', 'dayColors']){
        for(const id of new Set([...Object.keys(before[table]), ...Object.keys(after[table])])){
            if(!equal(before[table][id], after[table][id])) changes.push({ kind:'value', table, id, before:before[table][id] ?? null, after:after[table][id] ?? null });
        }
    }
    // Only emit an order change if existing items actually moved, not on add/delete.
    const order = (table, id, old, next) => {
        const shared = new Set(old.filter(key => next.includes(key)));
        if(!equal(old.filter(key => shared.has(key)), next.filter(key => shared.has(key)))){
            changes.push({ kind:'order', table, id, before:old, after:next });
        }
    };
    order('habits', '', before.habitOrder, after.habitOrder);
    for(const date of new Set([...Object.keys(before.taskOrder), ...Object.keys(after.taskOrder)])){
        order('tasks', date, before.taskOrder[date] || [], after.taskOrder[date] || []);
    }
    return changes;
}

export function inverseChanges(changes){
    const inverses = [...changes].reverse().map(change => ({ ...change,
        kind:change.kind === 'add' ? 'remove' : change.kind === 'remove' ? 'add' : change.kind,
        restore:change.kind === 'remove', beforePrevious:change.afterPrevious ?? null, afterPrevious:change.beforePrevious ?? null,
        before:change.after, after:change.before }));
    // Restore neighbours in their original order, so every insertion anchor
    // exists when undoing a bulk deletion/import (including separators).
    const restored = inverses.filter(change => change.kind === 'add');
    const ordered = [], remaining = [...restored];
    while(remaining.length){
        let index = remaining.findIndex(change => !remaining.some(other => other.table === change.table && other.id === change.afterPrevious));
        if(index < 0) index = 0;
        ordered.push(...remaining.splice(index, 1));
    }
    let index = 0;
    return inverses.map(change => change.kind === 'add' ? ordered[index++] : change);
}

export function applyChanges(source, changes, { optimistic = false } = {}){
    const next = model(clone(source)), conflicts = [];
    const accept = (current, change) => optimistic || equal(current, change.before) || equal(current, change.after);
    const conflict = change => conflicts.push(change);
    const hasUnseenCompletions = (hid, cutoff = '') => Object.entries(next.completions).some(([key, status]) => {
        const [date, habit] = JSON.parse(key);
        return habit === hid && date >= cutoff && !changes.some(change => change.table === 'completions'
            && change.id === key && change.after === null && equal(change.before, status));
    });
    // Restore entities/definitions before their completions; apply skips before
    // rollover additions and order only after membership is settled.
    const priority = change => change.table === 'skips' ? 0 : ({ remove:1, add:2, field:3, value:4, order:5 })[change.kind];
    const ordered = [...changes].sort((a, b) => priority(a) - priority(b));
    for(const change of ordered){
        const { kind, table, id } = change;
        if(kind === 'order'){
            const current = table === 'habits' ? next.habitOrder : next.taskOrder[id] || [];
            const shared = new Set(change.before.filter(key => current.includes(key)));
            const currentShared = current.filter(key => shared.has(key));
            if(!optimistic && !equal(currentShared, change.before.filter(key => shared.has(key)))
                && !equal(currentShared, change.after.filter(key => shared.has(key)))){
                conflict(change); continue;
            }
            const desired = change.after.filter(key => current.includes(key));
            const movable = new Set(desired);
            let index = 0;
            const result = current.map(key => movable.has(key) ? desired[index++] : key);
            if(table === 'habits') next.habitOrder = result;
            else next.taskOrder[id] = result;
            continue;
        }
        const current = next[table][id];
        if(kind === 'add'){
            if(current){ if(!equal(current, change.after)) conflict(change); continue; }
            if(table === 'tasks' && change.after.rolloverFromId && !change.restore){
                const root = change.after.rolloverRootId || change.after.rolloverFromId;
                if(next.skips[JSON.stringify([change.after.date, root])]) continue;
                if(Object.values(next.tasks).some(t => t.date === change.after.date && (t.rolloverRootId || t.id) === root)) continue;
                const origin = next.tasks[change.after.rolloverFromId];
                if(!origin || origin.status !== 'later') continue;
            }
            if(table === 'habits' && Object.values(next.habits).some(h => h.name.toLocaleLowerCase('fr-FR') === change.after.name.toLocaleLowerCase('fr-FR'))){
                conflict(change); continue;
            }
            put(next[table], id, clone(change.after));
            const list = table === 'habits' ? next.habitOrder : (next.taskOrder[change.after.date] ||= []);
            const position = change.afterPrevious ? list.indexOf(change.afterPrevious) + 1 : 0;
            list.splice(position, 0, id);
        } else if(kind === 'remove'){
            if(!current) continue;
            if(!accept(current, change)){ conflict(change); continue; }
            if(!optimistic && table === 'habits' && hasUnseenCompletions(id)){ conflict(change); continue; }
            delete next[table][id];
        } else if(kind === 'field'){
            if(!current){ conflict(change); continue; } // Never resurrect a deleted item.
            if(!accept(current[change.field], change)){ conflict(change); continue; }
            if(!optimistic && table === 'habits' && change.field === 'deletedAt' && change.after
                && hasUnseenCompletions(id, change.after)){ conflict(change); continue; }
            if(table === 'habits' && change.field === 'name'
                && Object.values(next.habits).some(h => h.id !== id && h.name.toLocaleLowerCase('fr-FR') === change.after.toLocaleLowerCase('fr-FR'))){
                conflict(change); continue;
            }
            if(change.after === null) delete current[change.field];
            else put(current, change.field, clone(change.after));
        } else if(kind === 'value'){
            if(!accept(current, change)){ conflict(change); continue; }
            if(table === 'completions' && change.after !== null){
                const [date, hid] = JSON.parse(id), habit = next.habits[hid];
                if(!habit || (habit.deletedAt && date >= habit.deletedAt)){ conflict(change); continue; }
            }
            if(change.after === null) delete next[table][id];
            else put(next[table], id, clone(change.after));
        }
    }
    const habits = next.habitOrder.map(id => next.habits[id]).filter(Boolean);
    const tasks = [], used = new Set();
    for(const ids of Object.values(next.taskOrder)){
        for(const id of ids){ if(next.tasks[id] && !used.has(id)){ tasks.push(next.tasks[id]); used.add(id); } }
    }
    for(const task of Object.values(next.tasks)){ if(!used.has(task.id)) tasks.push(task); }
    const completions = {}, taskRolloverSkips = {};
    for(const [key, value] of Object.entries(next.completions)){
        const [date, id] = JSON.parse(key), habit = next.habits[id];
        if(!habit) continue;
        completions[date] ||= {};
        put(completions[date], habit.name, value);
    }
    for(const key of Object.keys(next.skips)){
        const [date, root] = JSON.parse(key);
        taskRolloverSkips[date] ||= [];
        taskRolloverSkips[date].push(root);
    }
    return { data:{ ...source, habits, tasks, completions, taskRolloverSkips, dayColors:next.dayColors }, conflicts };
}

export async function initializeDocument({ run, target, legacy, marker, normalize }){
    return run(async transaction => {
        const existing = await transaction.get(target);
        if(existing.exists()){
            if(existing.data()._syncVersion !== SYNC_VERSION) throw new Error('unsupported-sync-version');
            return existing.data();
        }
        const migratedBefore = await transaction.get(marker);
        if(migratedBefore.exists()) throw new Error('sync-document-missing');
        // Never migrate an offline cache. The original document is retained.
        const source = await transaction.get(legacy);
        const migrated = { ...normalize(source.exists() ? source.data() : {}), _syncVersion:SYNC_VERSION, _rev:1 };
        transaction.set(target, migrated);
        transaction.set(marker, { version:SYNC_VERSION });
        return migrated;
    });
}

// Both reads and both writes share ONE Firestore transaction. Receipt high-water
// marks make a retry after a lost acknowledgement harmless, even weeks later.
export async function commitBatch({ run, target, receipt, batch, normalize }){
    return run(async transaction => {
        const snapshot = await transaction.get(target);
        const acknowledgement = await transaction.get(receipt);
        if(!snapshot.exists()) throw new Error('sync-document-missing');
        const remote = snapshot.data();
        if(remote._syncVersion !== SYNC_VERSION) throw new Error('unsupported-sync-version');
        if((acknowledgement.data()?.sequence || 0) >= batch.sequence) return { data:remote,
            conflicts:acknowledgement.data()?.sequence === batch.sequence ? acknowledgement.data().conflicts || [] : [] };
        const result = applyChanges(normalize(remote), batch.changes);
        const data = { ...result.data, _syncVersion:SYNC_VERSION, _rev:(remote._rev || 0) + 1 };
        transaction.set(target, data);
        transaction.set(receipt, { sequence:batch.sequence, conflicts:result.conflicts });
        return { data, conflicts:result.conflicts };
    });
}
