import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Exercise the production rendering/date functions with a controlled clock
// and small DOM doubles. No waiting for midnight or touching Firebase data.
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const extract = name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0];
const constants = source.split('\n').filter(line => /^const (formatDateKey|parseDateKey|calendarDayNumber|clearAllCaches|clearHabitCaches) =/.test(line)).join('\n');
const active = source.slice(source.indexOf('const isHabitActiveOn ='),source.indexOf('const getCompletionRate ='));
const code = names => names.map(extract).join('\n');
const format = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
function node(classes = [], dataset = {}){
    const list = new Set(classes), attributes = {};
    return {dataset,style:{},attributes,children:[],
        classList:{contains:key=>list.has(key),add:(...keys)=>keys.forEach(key=>list.add(key)),
            remove:(...keys)=>keys.forEach(key=>list.delete(key)),
            toggle:(key,on)=>{on ??= !list.has(key);on ? list.add(key) : list.delete(key);return on;}},
        setAttribute:(key,value)=>{attributes[key]=value;},removeAttribute:key=>{delete attributes[key];},
        appendChild(child){this.children.push(child);},
        querySelector(){return null;},closest(){return null;}};
}
function fixture(names = [], extra = {}){
    let time = new Date('2026-09-12T23:59:59.975').getTime();
    const frames = [], timers = [];
    class Clock extends Date {
        constructor(...args){super(...(args.length ? args : [time]));}
        static now(){return time;}
    }
    const context = createContext({Date:Clock,Math,Set,Map,performance:{now:()=>0},
        caches:{streaks:new Map(),bestStreak:new Map(),monthRate:new Map(),monthlyMax:new Map()},
        data:{habits:[],completions:{}},
        isHabitDone:(key,name)=>context.data.completions[key]?.[name] === 'done',
        requestAnimationFrame:callback=>{frames.push(callback);return frames.length;},
        clearTimeout(){},window:{setTimeout:(callback,delay)=>{timers.push({callback,delay});return timers.length;}},
        ...extra});
    runInContext(`${constants}\n${active}\n${code(names)}`,context);
    Object.assign(context,runInContext('({isHabitActiveOn,clearAllCaches,clearHabitCaches})',context));
    return {context,frames,timers,advance:date=>{time=new Date(date).getTime();},
        flushFrames(){while(frames.length) frames.shift()();}};
}
const streakFunctions = ['habitStreakHistory','computeStreakForHabit','computeBestStreakCached'];
const daily = {id:'read',name:'Lecture',startDate:'2026-09-01',mode:'weekly',daysOfWeek:[0,1,2,3,4,5,6]};

test('streak cache preserves weekly/interval/monthly/rest/archive semantics and arbitrary date order',()=>{
    const {context:c} = fixture(streakFunctions);
    for(const habit of [daily,{...daily,daysOfWeek:[1,3,5]},
        {...daily,mode:'interval',everyXDays:3},{...daily,mode:'monthly',dayOfMonth:12},
        {...daily,deletedAt:'2026-10-05'}]){
        c.data.habits=[habit];c.data.completions={};
        for(let date=new Date('2026-09-01T00:00:00');date<=new Date('2026-11-01T00:00:00');date.setDate(date.getDate()+1)){
            if(date.getDate()%9 !== 0) c.data.completions[format(date)]={Lecture:'done'};
        }
        c.clearAllCaches();
        const expected = key => {
            let result=0;
            for(let date=new Date(key+'T00:00:00');format(date)>=habit.startDate;date.setDate(date.getDate()-1)){
                if(!c.isHabitActiveOn(habit,format(date))) continue;
                if(!c.isHabitDone(format(date),habit.name)) break;
                result++;
            }
            return result;
        };
        for(const date of ['2026-11-01','2026-09-02','2026-10-08','2026-09-12','2026-08-31']){
            assert.equal(c.computeStreakForHabit(habit.name,date),expected(date),`${habit.mode} ${date}`);
        }
        const referenceBest = Math.max(...Object.keys(c.data.completions).map(expected));
        assert.equal(c.computeBestStreakCached(habit.name),referenceBest);
    }
});

test('filling/unchecking a historical gap updates later streaks and earlier personal-best highlights',()=>{
    const {context:c} = fixture(streakFunctions);
    c.data.habits=[daily];
    for(const day of [1,2,4,5]) c.data.completions[`2026-09-0${day}`]={Lecture:'done'};
    assert.equal(c.computeStreakForHabit('Lecture','2026-09-05'),2);
    assert.equal(c.computeBestStreakCached('Lecture'),2);
    c.data.completions['2026-09-03']={Lecture:'done'};
    c.clearHabitCaches('Lecture');
    assert.equal(c.computeStreakForHabit('Lecture','2026-09-05'),5);
    assert.equal(c.computeStreakForHabit('Lecture','2026-09-02'),2);
    assert.equal(c.computeBestStreakCached('Lecture'),5);
    delete c.data.completions['2026-09-03'];c.clearHabitCaches('Lecture');
    assert.equal(c.computeBestStreakCached('Lecture'),2);
    assert.equal(c.computeStreakForHabit('Lecture','2026-09-05'),2);
});

test('repeated streak/badge queries reuse one linear history calculation',()=>{
    const {context:c} = fixture(streakFunctions);
    c.data.habits=[daily];let evaluated=0;
    const original=c.isHabitDone;c.isHabitDone=(...args)=>{evaluated++;return original(...args);};
    for(let pass=0;pass<20;pass++){
        for(let day=1;day<=30;day++) c.computeStreakForHabit('Lecture',`2026-09-${String(day).padStart(2,'0')}`);
    }
    assert.equal(evaluated,30); // Not 600 backwards scans.
});

test('streak history crosses local daylight-saving and leap-day boundaries',()=>{
    const {context:c}=fixture(streakFunctions);
    for(const [start,end] of [['2026-03-27','2026-03-31'],['2026-10-23','2026-10-28'],['2028-02-27','2028-03-02']]){
        c.data.habits=[{...daily,startDate:start}];c.data.completions={};c.clearAllCaches();
        let count=0;
        for(let date=new Date(start+'T00:00:00');format(date)<=end;date.setDate(date.getDate()+1)){
            c.data.completions[format(date)]={Lecture:'done'};count++;
        }
        assert.equal(c.computeStreakForHabit('Lecture',end),count);
        assert.equal(c.computeBestStreakCached('Lecture'),count);
    }
});

function calendarFixture(){
    const old=node(['compact-day','is-today'],{dateKey:'2026-09-12'});
    const current=node(['compact-day'],{dateKey:'2026-09-13'});
    const habit=node(['compact-day'],{dateKey:'2026-09-12'});
    const small=node(['day-cell','is-today'],{dateKey:'2026-09-12'});
    for(const day of [old,current]) day.closest=()=>({dataset:{monthMode:'tasks'}});
    habit.closest=()=>({dataset:{monthMode:'habits'}});
    for(const day of [old,small]) day.setAttribute('aria-current','date');
    const cards=[node(['is-current-month'],{year:'2026',month:'8'}),node([],{year:'2027',month:'0'})];
    const today=node(['is-selected-day']);today.setAttribute('aria-current','date');
    let rollovers=0, navigated=null;
    const f=fixture(['syncCurrentDayMarker','syncDayNavigationState','refreshCalendarDate','scheduleTaskRollover',
        'isPastDateKey','applyExpandedDayAppearance','applyMobileDayAppearance'],{
        renderedTodayKey:'2026-09-12',currentYear:2026,currentMonth:8,maxYear:2031,
        initialSynced:true,localPreviewMode:false,focusedDateKey:'2026-09-12',taskRolloverTimer:null,
        dayPage:node(['is-current-day']),mobileDayColor:node(),yearsContainer:node(),
        dayColorFor:()=> 'default',processTaskRollovers:()=>{rollovers++;},
        showDayPage:date=>{navigated=date;},ensureYearRendered:(year,parent)=>parent.appendChild(year),
        document:{getElementById:()=>today,createDocumentFragment:()=>node(),
            querySelectorAll:selector=>selector === '.month-task-card' ? cards : [old,current,habit,small]}
    });
    return {...f,old,current,habit,small,cards,today,get rollovers(){return rollovers;},get navigated(){return navigated;}};
}

test('midnight removes yesterday labels even with no tasks to carry, without replacing days or selection',()=>{
    const f=calendarFixture();f.advance('2026-09-13T00:00:00.050');
    assert.equal(f.context.refreshCalendarDate(),true);
    for(const old of [f.old,f.small,f.habit]){
        assert.equal(old.classList.contains('is-today'),false);assert.equal(old.attributes['aria-current'],undefined);
    }
    assert.equal(f.current.classList.contains('is-today'),true);
    assert.equal(f.old.classList.contains('is-past'),true);
    assert.equal(f.habit.classList.contains('is-past'),false);
    assert.equal(f.today.classList.contains('is-selected-day'),false);
    assert.equal(f.context.focusedDateKey,'2026-09-12');
    assert.equal(f.context.refreshCalendarDate(),false);assert.equal(f.rollovers,1);
    f.advance('2026-09-14T12:00:00');f.today.onclick();
    assert.equal(f.navigated,'2026-09-14'); // No date captured on the 12th.
});

test('the clock catches midnight, a suspended tab, and year changes without full-page rendering',()=>{
    const f=calendarFixture();
    f.context.scheduleTaskRollover();assert.equal(f.timers[0].delay,75);
    f.advance('2026-09-13T00:00:00.050');f.timers[0].callback();
    assert.equal(f.context.renderedTodayKey,'2026-09-13');assert.equal(f.timers[1].delay,60000);
    f.advance('2027-01-01T10:00:00');f.timers[1].callback();
    assert.equal(f.context.currentYear,2027);assert.equal(f.context.currentMonth,0);assert.equal(f.context.maxYear,2032);
    assert.equal(f.cards[0].classList.contains('is-current-month'),false);
    assert.equal(f.cards[1].classList.contains('is-current-month'),true);
    assert.deepEqual(f.context.yearsContainer.children[0].children,[2032]);
});

test('visibility, focus, and back-forward restoration all recheck the calendar clock',()=>{
    const listeners=new Map();let refreshes=0;
    const {context:c}=fixture([],{
        refreshCalendarDate:()=>{refreshes++;return true;},scheduleTaskRollover(){},ensureRealtimeSubscription(){},flushPersistence(){},
        processTaskRollovers(){throw Error('date refresh already handled rollovers');},
        document:{visibilityState:'visible',addEventListener:(type,cb)=>listeners.set(type,cb)},
        window:{addEventListener:(type,cb)=>listeners.set(type,cb)}});
    runInContext(source.slice(source.indexOf("document.addEventListener('visibilitychange'"),source.indexOf("window.addEventListener('online'")),c);
    for(const type of ['visibilitychange','focus','pageshow']) listeners.get(type)();
    assert.equal(refreshes,3);
    c.document.visibilityState='hidden';listeners.get('visibilitychange')();assert.equal(refreshes,3);
});

test('a habit invalidation updates every rendered date, not just the pressed button',()=>{
    const buttons=[node([],{habitName:'Lecture',dateKey:'2026-09-02'}),node([],{habitName:'Lecture',dateKey:'2026-09-05'}),
        node([],{habitName:'Sport',dateKey:'2026-09-05'})];
    const calls=[];
    const {context:c}=fixture(['syncRenderedHabitState'],{document:{querySelectorAll:()=>buttons},
        syncHabitToggleButtonState:(button,h,date)=>calls.push(date)});
    c.syncRenderedHabitState(daily,'2026-09-03');
    assert.deepEqual(calls,['2026-09-02','2026-09-05']);
});

test('inline streak labels and separate badges both change without replacing their DOM nodes',()=>{
    const badge=node(['streak-badge','streak-badge--best']);
    const row=node();row.querySelector=()=>badge;
    const button=node(['habit-is-done']);button.closest=()=>row;
    const label=node();const compact=node(['compact-habit']);compact.querySelector=()=>label;
    const {context:c}=fixture(['syncHabitToggleButtonState'],{computeStreakForHabit:()=>2,computeBestStreakCached:()=>5,
        clamp3:value=>value,HABIT_STATUS:{DONE:'done',PENDING:'pending'}});
    c.data.completions['2026-09-02']={Lecture:'done'};
    c.syncHabitToggleButtonState(button,daily,'2026-09-02');
    c.syncHabitToggleButtonState(compact,daily,'2026-09-02',{isCompactMonth:true});
    assert.equal(badge.textContent,'2/5');assert.equal(badge.classList.contains('streak-badge--best'),false);
    assert.equal(label.textContent,'2/5');assert.equal(compact.dataset.bestStreak,'false');
    assert.equal(button.attributes['aria-pressed'],'true');
});

test('rapid checkboxes coalesce into one frame and invalidate all historic gold cells',()=>{
    const changed=[],dates=[];let cellRefreshes=0,summaries=0;
    const f=fixture(['scheduleHabitRefresh'],{pendingHabitRefreshes:new Set(),pendingHabitMetricDates:new Set(),habitRefreshFrame:null,
        homePage:node(),syncRenderedHabitState:habit=>changed.push(habit.name),refreshExpandedHabitMetrics:date=>dates.push(date),
        refreshRenderedDayCells:(from,options)=>{assert.equal(from,null);assert.equal(options.completedOnly,true);cellRefreshes++;},
        refreshOpenSummaries:()=>{summaries++;}});
    f.context.data.habits=[daily,{...daily,id:'sport',name:'Sport'}];
    f.context.scheduleHabitRefresh(daily,'2026-09-02');f.context.scheduleHabitRefresh(daily,'2026-09-03');
    f.context.scheduleHabitRefresh(f.context.data.habits[1],'2026-09-03');
    assert.equal(f.frames.length,1);f.flushFrames();
    assert.deepEqual(changed,['Lecture','Sport']);assert.deepEqual(dates,['2026-09-02','2026-09-03']);
    assert.equal(cellRefreshes,1);assert.equal(summaries,1);
});

test('rollover updates only dates that receive copies and persists once',async()=>{
    const changed=[];let writes=0;
    const {context:c}=fixture(['processTaskRollovers'],{syncClient:{view:{}},
        rollForwardLaterTasks:dates=>{dates.add('2026-09-13');dates.add('2026-09-14');return 4;},
        rerenderTaskViews:date=>changed.push(date),persistDebounced:()=>{writes++;}});
    assert.equal(await c.processTaskRollovers(),4);
    assert.deepEqual(changed,['2026-09-13','2026-09-14']);assert.equal(writes,1);
});
