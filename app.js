import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js';

import {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    doc,
    onSnapshot,
    setDoc
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';

import {
    getAuth, onAuthStateChanged,
    setPersistence, browserLocalPersistence,
    signInWithEmailAndPassword, createUserWithEmailAndPassword,
    signOut, sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js';


const firebaseConfig = { apiKey: "AIzaSyBptpMFEMc7ikXM0PtDOeWUHnMegKQ6hcs", authDomain: "habit-8d57f.firebaseapp.com", projectId: "habit-8d57f", storageBucket: "habit-8d57f.appspot.com", messagingSenderId: "934416417831", appId: "1:934416417831:web:63f2f0554daa6d3ff23a02" };

let data = { habits: [], completions: {}, _rev: 0 };
let lastLocalRev = 0; let initialSynced = false;

const caches = { bestStreak:new Map(), monthRate:new Map(), monthlyMax:new Map() };
const clearAllCaches = ()=>{ caches.bestStreak.clear(); caches.monthRate.clear(); caches.monthlyMax.clear(); };
const clearHabitCaches = (habitName)=>{ caches.bestStreak.delete(habitName); caches.monthlyMax.delete(habitName); for(const k of caches.monthRate.keys()){ if(k.startsWith(habitName+'|')) caches.monthRate.delete(k); } };
const clearMonthCacheForHabit = (habitName, y, m)=>{ caches.monthRate.delete(`${habitName}|${y}-${m}`); caches.monthlyMax.delete(habitName); };

const homePage = document.getElementById('homePage');
const yearsContainer = homePage;
const dayPanel = document.getElementById('dayPanel');
const dayOverlay = document.getElementById('dayOverlay');
const panelDate = document.getElementById('panelDate');
const panelDateLong = document.getElementById('panelDateLong');
const habitsList = document.getElementById('habitsList');

const dayPage = document.getElementById('dayPage');
const dayTitle = document.getElementById('dayTitle');
const dayTitleSub = document.getElementById('dayTitleSub');
const dayHabitsList = document.getElementById('dayHabitsList');

const monthModal = document.getElementById('modalMonth');
const monthSummary = document.getElementById('monthSummary');
const monthModalTitle = document.getElementById('monthModalTitle');

const yearModal = document.getElementById('modalYear');
const yearSummary = document.getElementById('yearSummary');
const yearModalTitle = document.getElementById('yearModalTitle');

const burgerBtn   = document.getElementById('burgerBtn');
const burgerIcon  = document.getElementById('burgerIcon');
const closeIcon   = document.getElementById('closeIcon');
const navPanel    = document.getElementById('navPanel');
const navOverlay  = document.getElementById('navOverlay');
const menuImport  = document.getElementById('menuImport');
// Gestion de l'import JSON
const fileInput = document.getElementById('fileInput');

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
    // 1. Lire le contenu du fichier
    const text = await file.text();

    // 2. Parser le JSON
    const imported = JSON.parse(text);

    // 3. Valider structure minimale
    if (
        !imported ||
        !Array.isArray(imported.habits) ||
        typeof imported.completions !== 'object'
    ) {
        alert("Fichier invalide : il doit contenir 'habits' (array) et 'completions' (object).");
        fileInput.value = '';
        return;
    }

    // 4. Injecter dans l'app
    data = {
        habits: imported.habits || [],
        completions: imported.completions || {},
        _rev: (imported._rev || 0)
    };

    clearAllCaches();

    // 5. Forcer un rerender immédiat en local
    renderYears();

    // Si on a déjà une date affichée en vue day, on la rerend aussi
    if (focusedDateKey) {
        if (!isSmall()) {
        // panneau latéral (desktop)
        populateHabits(focusedDateKey, habitsList, false);
        updateDayCell(focusedDateKey);
        } else {
        // vue day (mobile)
        showDayPage(focusedDateKey);
        }
    }

    // 6. Essayer de pousser sur Firestore si on est connecté et qu'on a docRef
    try {
        if (docRef) {
        data._rev = (data._rev || 0) + 1;
        lastLocalRev = data._rev;
        await setDoc(docRef, data);
        }
    } catch (errFirestore) {
        console.warn("Import local OK mais sync Firestore impossible (probablement pas connecté) :", errFirestore);
    }

    alert("Importation réussie ✅");

    } catch (err) {
    console.error("Erreur d'import JSON :", err);
    alert("Impossible de lire ce fichier. Vérifie que c'est bien l'export HBTRK.");
    } finally {
    // 7. Reset de l'input pour pouvoir réimporter le même fichier sans recharger la page
    fileInput.value = '';
    }
});


const menuExport  = document.getElementById('menuExport');
const menuLogout  = document.getElementById('menuLogout');
const menuInstall = document.getElementById('menuInstall');

const modalInstall = document.getElementById('modalInstall');
const closeInstall = document.getElementById('closeInstall');

const appTitle = document.getElementById('appTitle');

let focusedDateKey = null;
const now = new Date(); const currentYear = now.getFullYear(); const currentMonth = now.getMonth();
let minYear = 2025; let maxYear = currentYear + 5; const isSmall = () => window.matchMedia('(max-width: 639px)').matches;

const formatDateKey = (d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseDateKey = (s)=> new Date(s+'T00:00:00');
const monthNameShort = (m)=> ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'][m];
const monthNameLong = (m)=> ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'][m];

const isHabitActiveOn = (h, dateKey) => {
    const d = parseDateKey(dateKey);
    const start = parseDateKey(h.startDate);
    if (d < start) return false;
    if (h.deletedAt && d >= parseDateKey(h.deletedAt)) return false;

    // weekly
    if (h.mode === "weekly") {
    if (!Array.isArray(h.daysOfWeek)) return false;
    const dow = d.getDay(); // 0=dimanche ... 6=samedi
    return h.daysOfWeek.includes(dow);
    }

    // interval
    if (h.mode === "interval") {
    if (typeof h.everyXDays !== "number" || h.everyXDays < 1) return false;
    const diffDays = Math.floor((d - start) / (1000 * 60 * 60 * 24));
    return diffDays >= 0 && diffDays % h.everyXDays === 0;
    }

    // monthly
    if (h.mode === "monthly") {
    if (typeof h.dayOfMonth !== "number") return false;
    const dayNum = d.getDate(); // 1..31
    return dayNum === h.dayOfMonth;
    }

    // fallback: si ancien format "frequency" existe encore dans des anciennes données
    if (h.frequency === 'daily') return true;
    if (h.frequency === 'weekly') {
    // compat très minimaliste : lundi uniquement
    const dow = d.getDay();
    return dow === 1;
    }
    if (h.frequency === 'monthly') {
    return d.getDate() === 1;
    }

    return false;
};


const getCompletionRate = (dateKey)=>{ const dayData = data.completions[dateKey] || {}; const activeHabits = data.habits.filter(h=>isHabitActiveOn(h,dateKey)); if(activeHabits.length===0) return 0; const completed = activeHabits.filter(h=>dayData[h.name]).length; return completed / activeHabits.length; };

const headerEl = document.querySelector('header');
const userBadge = document.getElementById('userBadge');
const userNamePart = document.getElementById('userNamePart');

function extractLocalPart(email){
    if(!email || typeof email !== 'string') return '';
    const at = email.indexOf('@');
    return at > 0 ? email.slice(0, at) : email;
}

const hideAppForAuth = (hide) => {
    const method = hide ? 'add' : 'remove';
    headerEl.classList[method]('hidden');
    homePage.classList[method]('hidden');
    dayPage.classList[method]('hidden');

    dayOverlay.classList.add('hidden');
    dayPanel.classList.add('hidden');
    dayPanel.style.transform = 'translateX(110%)';

    navOverlay.classList.add('hidden');
    navPanel.classList.add('hidden');
    navPanel.style.transform = 'translateX(calc(100% + 1rem))';
    navPanel.style.visibility = 'hidden';
    burgerIcon.classList.remove('hidden');
    closeIcon.classList.add('hidden');

    modalAddHabit.classList.add('hidden'); modalAddHabit.classList.remove('flex');
    monthModal.classList.add('hidden');    monthModal.classList.remove('flex');
    yearModal.classList.add('hidden');     yearModal.classList.remove('flex');
    modalInstall.classList.add('hidden');  modalInstall.classList.remove('flex');
};

const toDate = (s)=> new Date(s + 'T00:00:00');
const cmpDateStr = (a,b)=> (a<b? -1 : a>b? 1 : 0);

function periodEnd(h){ return h.deletedAt ? toDate(h.deletedAt) : null; }

function addHabitSmart(habitObj){
const { name, startDate } = habitObj;

// même logique "anti doublon / merge" que ta version actuelle
const same = data.habits
    .filter(h => h.name === name)
    .sort((a,b) => a.startDate.localeCompare(b.startDate));

for (const h of same){
    const A = h.startDate;
    const B = h.deletedAt || '9999-12-31';

    if (startDate >= A && startDate < B){
    if (startDate < A) h.startDate = startDate;
    delete h.deletedAt;

    // on écrase les infos de fréquence avec la nouvelle config
    h.mode = habitObj.mode;
    h.daysOfWeek = habitObj.daysOfWeek || null;
    h.everyXDays = habitObj.everyXDays ?? null;
    h.dayOfMonth = habitObj.dayOfMonth ?? null;
    return { action: 'merged', target: h };
    }

    if (startDate <= B){
    if (startDate < A) h.startDate = startDate;
    delete h.deletedAt;

    h.mode = habitObj.mode;
    h.daysOfWeek = habitObj.daysOfWeek || null;
    h.everyXDays = habitObj.everyXDays ?? null;
    h.dayOfMonth = habitObj.dayOfMonth ?? null;
    return { action: 'merged', target: h };
    }
}

if (same.length){
    const everyEndedBeforeStart = same.every(h => !!h.deletedAt && h.deletedAt <= startDate);
    if (!everyEndedBeforeStart){
    return { action: 'ignored' };
    }
}

// nouvelle création
const created = {
    name: habitObj.name,
    startDate: habitObj.startDate,
    mode: habitObj.mode,
    daysOfWeek: habitObj.daysOfWeek || null,
    everyXDays: habitObj.everyXDays ?? null,
    dayOfMonth: habitObj.dayOfMonth ?? null
};

data.habits.push(created);
return { action: 'added', target: created };
}

let navIsOpen = false;           // vrai si le menu est censé être ouvert
let navJustOpenedAt = 0;         // timestamp à l'ouverture, pour éviter les fermetures immédiates

function openNavPanel() {
    navIsOpen = true;
    navJustOpenedAt = Date.now();

    // afficher panneau + overlay tout de suite
    navPanel.classList.remove('hidden');
    navOverlay.classList.remove('hidden');

    // rendre le panneau visible et le slide-in
    navPanel.style.visibility = 'visible';
    requestAnimationFrame(() => {
    navPanel.style.transform = 'translateX(0)';
    });

    // swap icônes burger / close
    burgerIcon.classList.add('hidden');
    closeIcon.classList.remove('hidden');
}

function closeNavPanel() {
    navIsOpen = false;

    // slide-out
    navPanel.style.transform = 'translateX(calc(100% + 1rem))';
    navOverlay.classList.add('hidden');

    // on cache APRÈS l'anim de transition
    const onEnd = () => {
    navPanel.removeEventListener('transitionend', onEnd);
    // si jamais entre-temps l'utilisateur a réouvert -> ne pas tout recacher
    if (!navIsOpen) {
        navPanel.classList.add('hidden');
        navPanel.style.visibility = 'hidden';

        burgerIcon.classList.remove('hidden');
        closeIcon.classList.add('hidden');
    }
    };
    navPanel.addEventListener('transitionend', onEnd, { once: true });
}

if (burgerBtn) {
    burgerBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // IMPORTANT: on ne laisse pas remonter le clic

    if (navIsOpen) {
        closeNavPanel();
    } else {
        openNavPanel();
    }
    });
}


if (navOverlay) {
    navOverlay.addEventListener('click', (e) => {
    // On ne ferme QUE si le menu est actuellement ouvert
    // et que l'utilisateur clique (tap) sur l'overlay
    if (!navIsOpen) return;

    // petite sécurité anti-fermeture instantanée (tap fantôme du doigt)
    if (Date.now() - navJustOpenedAt < 200) return;

    if (e.target === navOverlay) {
        closeNavPanel();
    }
    });
}


document.addEventListener('keydown', (e)=>{
    if (e.key === 'Escape' && navPanel.style.visibility === 'visible') {
    closeNavPanel();
    }
});

menuImport.onclick = () => {
    document.getElementById('fileInput').click();
    closeNavPanel();
};

menuExport.onclick = () => {
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download='fourpill-data.json'; a.click();
    URL.revokeObjectURL(url);
    closeNavPanel();
};

menuLogout.onclick = async () => {
    try { await signOut(auth); } catch(e){ console.error(e); }
    closeNavPanel();
};

menuInstall.onclick = () => {
    modalInstall.classList.remove('hidden');
    modalInstall.classList.add('flex');
    closeNavPanel();
};

closeInstall.onclick = () => {
    modalInstall.classList.add('hidden');
    modalInstall.classList.remove('flex');
};

function computeStreakForHabit(habitName, asOfDateKey){
    let d = parseDateKey(asOfDateKey); let streak = 0; const habit = data.habits.find(h=>h.name===habitName); if(!habit) return 0;
    while(true){ const key = formatDateKey(d); if(!isHabitActiveOn(habit, key)) break; const done = data.completions[key] && data.completions[key][habitName]; if(done){ streak++; d.setDate(d.getDate()-1); } else break; }
    return streak;
}

function computeBestStreakCached(habitName){
    if(caches.bestStreak.has(habitName)) return caches.bestStreak.get(habitName);
    const habit = data.habits.find(h=>h.name===habitName); if(!habit) return 0;
    const start = parseDateKey(habit.startDate); const keys = Object.keys(data.completions).sort(); if(keys.length===0){ caches.bestStreak.set(habitName,0); return 0; }
    const firstKey = parseDateKey(keys[0]); const lastKey = parseDateKey(keys[keys.length-1]); const from = start < firstKey ? start : firstKey; const to = lastKey;
    let best = 0; let d = new Date(from);
    while(d <= to){ const key = formatDateKey(d); if(isHabitActiveOn(habit, key) && data.completions[key] && data.completions[key][habitName]){ let count = 0; let dd = new Date(d); while(true){ const kk = formatDateKey(dd); if(isHabitActiveOn(habit, kk) && data.completions[kk] && data.completions[kk][habitName]){ count++; dd.setDate(dd.getDate()+1); } else break; } if(count>best) best=count; d.setDate(d.getDate()+count); } else { d.setDate(d.getDate()+1); } }
    caches.bestStreak.set(habitName,best); return best;
}

function monthRateCached(h, year, month){ const key=`${h.name}|${year}-${month}`; if(caches.monthRate.has(key)) return caches.monthRate.get(key); const r = monthRate(h, year, month); caches.monthRate.set(key,r); return r; }
function monthRate(h, year, month){ const daysInMonth = new Date(year, month+1, 0).getDate(); let activeDays = 0, doneDays = 0; for(let d=1; d<=daysInMonth; d++){ const dk = formatDateKey(new Date(year, month, d)); if(isHabitActiveOn(h, dk)){ activeDays++; if(data.completions[dk] && data.completions[dk][h.name]) doneDays++; } } return activeDays===0 ? 0 : doneDays/activeDays; }
function habitAllTimeMonthlyMaxCached(h){ if(caches.monthlyMax.has(h.name)) return caches.monthlyMax.get(h.name); let max=0; for(let y=minYear;y<=maxYear;y++){ for(let m=0;m<12;m++){ const r=monthRateCached(h,y,m); if(r>max) max=r; } } caches.monthlyMax.set(h.name,max); return max; }

function ensureYearRendered(y){ 
    if(document.getElementById('year-'+y)) return; 
    const el = document.createElement('section'); 
    el.id='year-'+y; 
    el.className='year-block rounded-full p-4'; 
    const title=document.createElement('h2'); 
    title.className='text-3xl font-extrabold mb-3 hover:underline cursor-pointer'; 
    title.textContent=y; 
    title.dataset.year=y; 
    title.onclick=()=>openYearModal(y); 
    el.appendChild(title); 
    const grid=document.createElement('div'); 
    grid.className='grid month-grid gap-4'; 
    for(let m=0;m<12;m++){ 
    const month=document.createElement('div'); 
    month.className='p-3 rounded-lg bg-white/5'; 
    const mtitle=document.createElement('button'); 
    mtitle.type='button'; 
    mtitle.className='font-semibold mb-2 text-sm hover:underline cursor-pointer'; 
    mtitle.textContent=monthNameShort(m); 
    mtitle.dataset.year=y; 
    mtitle.dataset.month=m; 
    mtitle.onclick=()=>openMonthModal(y,m); 
    month.appendChild(mtitle); 
    const days=document.createElement('div'); 
    days.className='grid grid-cols-7 gap-1 text-xs text-white/80'; 
    const first=new Date(y,m,1); 
    const total=new Date(y,m+1,0).getDate(); 
    const offset=(first.getDay() + 6) % 7;
    for(let i=0;i<offset;i++){ 
        days.appendChild(Object.assign(document.createElement('div'),{className:'text-white/10',innerHTML:'\u00A0'})); 
    } 
    for(let d=1; d<=total; d++){ 
        const date=new Date(y,m,d); 
        const dk=formatDateKey(date); 
        const btn=document.createElement('button'); 
        btn.className='day-cell text-[11px]'; 
        btn.textContent=d; 
        btn.dataset.dateKey=dk; 
        applyDayCellStyle(btn, dk); 
        if(dk===formatDateKey(new Date())) btn.classList.add('ring-2','ring-white/10'); 
        btn.onclick=()=>openDayPanel(dk); 
        days.appendChild(btn);
    } 
    month.appendChild(days); 
    grid.appendChild(month);
    } 
    el.appendChild(grid); 
    yearsContainer.appendChild(el); 
}

function applyDayCellStyle(btn, dk){
    const actives = data.habits.filter(h=>isHabitActiveOn(h,dk));
    const allGold = actives.length>0 && actives.every(h=>{ const cur=computeStreakForHabit(h.name, dk); const best=Math.max(h.bestStreak||0, computeBestStreakCached(h.name)); const doneToday=!!(data.completions[dk] && data.completions[dk][h.name]); return doneToday && cur>=best; });
    if(allGold){
    btn.style.background='linear-gradient(135deg, var(--gold), var(--gold-deep))';
    btn.classList.add('gold');
    btn.style.color = '#0a0a0a';
    } else {
    const rate=getCompletionRate(dk);
    btn.classList.remove('gold');
    btn.style.background='';
    btn.style.backgroundColor=`rgba(0,255,100,${rate})`;
    btn.style.color = rate>0 ? '#0a0a0a' : '';
    }
}

function updateDayCell(dk){ const el = document.querySelector(`button.day-cell[data-date-key="${dk}"]`); if(el) applyDayCellStyle(el, dk); }

function renderYears(){ yearsContainer.innerHTML=''; for(let y=minYear;y<=maxYear;y++) ensureYearRendered(y); }

const focusCurrentMonth = ()=>{
    const yEl=document.getElementById('year-'+currentYear);
    if(!yEl) return;
    const monthBtn=yEl.querySelector(`button.font-semibold[data-year="${currentYear}"][data-month="${currentMonth}"]`);
    if(monthBtn){ requestAnimationFrame(()=>{ monthBtn.scrollIntoView({block:'center', behavior:'smooth'}); }); }
    else { yEl.scrollIntoView({block:'center', behavior:'smooth'}); }
};

// ÉTAT D'OUVERTURE POUR LE PANEL JOUR (équivalent navIsOpen)
let dayIsOpen = false;
let dayJustOpenedAt = 0; // protection contre les "taps fantômes"

function openDayPanel(dateKey) {
dayIsOpen = true;
dayJustOpenedAt = Date.now();

focusedDateKey = dateKey;

// Mettre à jour l'en-tête (date courte + ISO)
panelDate.textContent = new Date(dateKey).toLocaleDateString(
'fr-FR',
{ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
);
panelDateLong.textContent = dateKey;

// Remplir la liste des habitudes du jour
populateHabits(dateKey, habitsList, false);

// Rendre visibles immédiatement le panel et l'overlay
dayPanel.classList.remove('hidden');
dayOverlay.classList.remove('hidden');

dayPanel.style.visibility = 'visible';

// Lancer l'animation slide-in au frame suivant
requestAnimationFrame(() => {
dayPanel.style.transform = 'translateX(0)';
});
}

function closeDayPanel() {
// Si déjà fermé logiquement, rien à faire
if (!dayIsOpen) return;

dayIsOpen = false;

// Lancer le slide-out
dayPanel.style.transform = 'translateX(calc(100% + 1rem))';
dayOverlay.classList.add('hidden');

// Quand la transition est finie, on HIDE vraiment
const onEnd = () => {
dayPanel.removeEventListener('transitionend', onEnd);

// si entre-temps l'utilisateur l'a rouvert (tap rapide),
// on NE recache PAS
if (!dayIsOpen) {
    dayPanel.classList.add('hidden');
    dayPanel.style.visibility = 'hidden';
}
};

dayPanel.addEventListener('transitionend', onEnd, { once: true });
}

// Bouton "Fermer" (en haut du panneau jour)
document.getElementById('closePanel').onclick = () => {
closeDayPanel();
};

// Clique sur overlay pour fermer
dayOverlay.addEventListener('click', (e) => {
// On ferme UNIQUEMENT si le panneau est ouvert
// ET que l'utilisateur a vraiment cliqué l'overlay
// ET qu'on n'est pas dans les 200ms post-ouverture (tap fantôme)
if (!dayIsOpen) return;
if (Date.now() - dayJustOpenedAt < 200) return;
if (e.target === dayOverlay) {
closeDayPanel();
}
});

// Escape pour fermer
document.addEventListener('keydown', (e) => {
if (e.key === 'Escape' && dayIsOpen) {
closeDayPanel();
}
});


const clamp3 = (n)=>{ const s = String(Math.max(0, n|0)); return s.length>3 ? s.slice(0,3) : s; };
const makeStreakBadge=(cur,best,isBestNow)=>{ const span=document.createElement('span'); span.className='streak-badge'+(isBestNow && cur>0 ? ' streak-badge--best':'' ); span.textContent=`${clamp3(cur)}/${clamp3(best)}`; span.title='Série actuelle / meilleur record'; return span; };

let persistTimer=null; const persistDebounced=(delay=250)=> new Promise(res=>{ clearTimeout(persistTimer); persistTimer=setTimeout(async()=>{ try{ data._rev=(data._rev||0)+1; lastLocalRev=data._rev; await setDoc(docRef, data); } finally { res(); } }, delay); });

function makeHabitToggleButton(h, dateKey, onChanged, opts = {}) {
    const { isDayView = false } = opts;
    const done = !!(data.completions[dateKey] && data.completions[dateKey][h.name]);
    const width = isDayView ? ['w-4/5'] : ['w-auto'];
    const textSize = isDayView ? 'text-xl' : 'text-xs';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', done ? 'true' : 'false');
    btn.className = [ ...width,'px-4','py-3','rounded-full','border','transition', textSize,'font-semibold', done ? 'bg-[rgb(0,200,75)] border-green-400/40 ring-1 ring-green-300/30 text-black' : 'bg-white/5 border-white/10 hover:bg-white/10 text-white' ].join(' ');
    btn.textContent = h.name;
    btn.onclick = async () => {
    if (!data.completions[dateKey]) data.completions[dateKey] = {};
    data.completions[dateKey][h.name] = !done;
    const d = new Date(dateKey);
    clearMonthCacheForHabit(h.name, d.getFullYear(), d.getMonth());
    clearHabitCaches(h.name);
    if (typeof onChanged === 'function') onChanged();
    updateDayCell(dateKey);
    await persistDebounced();
    };
    return btn;
}

function enableDragSort(container){
    let dragEl=null; let startIndex=-1;

    const rows = Array.from(container.querySelectorAll('[data-habit-row]'));
    rows.forEach((row)=>{
    const handle = row.querySelector('[data-drag-handle]');
    if(!handle) return;
    handle.addEventListener('pointerdown', (e)=>{
        row.draggable = true; row.classList.add('opacity-70'); dragEl=row; startIndex=[...container.children].indexOf(row);
    });
    row.addEventListener('pointerup', ()=>{ row.draggable=false; row.classList.remove('opacity-70'); });
    });

    container.addEventListener('dragstart', (e)=>{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',''); });
    container.addEventListener('dragover', (e)=>{
    e.preventDefault();
    const after = Array.from(container.querySelectorAll('[data-habit-row]')).find(el=>{
        const rect=el.getBoundingClientRect();
        return e.clientY < rect.top + rect.height/2;
    });
    if(!after) container.appendChild(dragEl); else container.insertBefore(dragEl, after);
    });
    container.addEventListener('drop', async ()=>{
    if(!dragEl) return;
    dragEl.classList.remove('opacity-70'); dragEl.draggable=false;
    const newOrderNames = Array.from(container.querySelectorAll('[data-habit-row]')).map(r=>r.getAttribute('data-habit-name'));
    data.habits.sort((a,b)=> newOrderNames.indexOf(a.name) - newOrderNames.indexOf(b.name));
    clearAllCaches();
    await persistDebounced(0);
    dragEl=null; startIndex=-1;
    });
}

function populateHabits(dateKey, container, minimal=false){
    container.innerHTML=''; const actives=data.habits.filter(h=>isHabitActiveOn(h,dateKey)); if(actives.length===0){ container.innerHTML='<div class="text-sm text-white/60">Aucune habitude active.</div>'; return; }
    const rerenderSelf = ()=> populateHabits(dateKey, container, minimal);
    const isDayContainer = container && container.id === 'habitsList' ? false : (container && container.id === 'dayHabitsList');
    if(minimal || isSmall()){
    actives.forEach(h=>{ const row=document.createElement('div'); row.className='w-full flex justify-center'; row.appendChild(makeHabitToggleButton(h, dateKey, rerenderSelf, { isDayView: isDayContainer })); container.appendChild(row); }); return; }

    actives.forEach(h=>{
    const row=document.createElement('div'); row.className='flex items-center justify-between gap-2'; row.setAttribute('data-habit-row',''); row.setAttribute('data-habit-name', h.name);

    const left=document.createElement('div'); left.className='flex items-center gap-2';
    if(container === habitsList){
        const handle=document.createElement('button');
        handle.type='button';
        handle.setAttribute('data-drag-handle','');
        handle.className='p-2 rounded-md hover:bg-white/5 cursor-grab active:cursor-grabbing select-none';
        handle.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
        left.appendChild(handle);
    }

    const toggleBtn=makeHabitToggleButton(h, dateKey, rerenderSelf, { isDayView: isDayContainer });
    left.append(toggleBtn);
    row.append(left);

    const right=document.createElement('div'); right.className='flex items-center gap-2';
    const curLabel=computeStreakForHabit(h.name, dateKey); const bestLabel=Math.max(h.bestStreak||0, computeBestStreakCached(h.name));
    const badge=makeStreakBadge(curLabel, bestLabel, curLabel>=bestLabel);

    if(container !== dayHabitsList){
        const edit=document.createElement('button'); edit.className='text-xs px-2 py-1 rounded hover:bg-white/5'; edit.textContent='✏️'; edit.onclick=async()=>{ const newName=prompt('Nouveau nom pour '+h.name,h.name); if(newName&&newName.trim()!==h.name){ const oldName=h.name; h.name=newName.trim(); for(const k in data.completions){ if(data.completions[k] && Object.prototype.hasOwnProperty.call(data.completions[k], oldName)){ data.completions[k][h.name]=data.completions[k][oldName]; delete data.completions[k][oldName]; } } clearHabitCaches(oldName); clearHabitCaches(h.name); await persistDebounced(0); rerenderSelf(); } };
        const del = document.createElement('button');
        del.className = 'text-xs px-2 py-1 rounded hover:bg-white/5';
        del.textContent = '🗑️';
        del.onclick = async ()=>{
        const cut = dateKey;

        if (!h.deletedAt || cmpDateStr(cut, h.deletedAt) < 0) {
            h.deletedAt = cut;
        }

        for (const k of Object.keys(data.completions)) {
            if (cmpDateStr(k, cut) >= 0 && data.completions[k] && data.completions[k][h.name]) {
            delete data.completions[k][h.name];
            if (Object.keys(data.completions[k]).length === 0) delete data.completions[k];
            }
        }

        clearHabitCaches(h.name);
        await persistDebounced(0);

        rerenderSelf();
        renderYears();
        };

        right.append(badge,edit,del);
    } else {
        right.append(badge);
    }

    row.append(right);
    container.append(row);
    });

    if(container === habitsList){ enableDragSort(container); }
}

function showDayPage(dateKey){
    homePage.classList.add('hidden'); dayPage.classList.remove('hidden');
    const d=parseDateKey(dateKey);
    const month = d.toLocaleDateString('fr-FR', { month: 'long'});
    const rest = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric' });
    dayTitle.innerHTML = `${month}<br>${rest}`;
    dayTitleSub.textContent=dateKey;
    dayHabitsList.className='mb-4 space-y-3 flex flex-col items-center';
    populateHabits(dateKey, dayHabitsList, true);
    focusedDateKey=dateKey;
    document.getElementById('prevDay').onclick=()=>{ const p=new Date(d); p.setDate(p.getDate()-1); showDayPage(formatDateKey(p)); };
    document.getElementById('nextDay').onclick=()=>{ const n=new Date(d); n.setDate(n.getDate()+1); showDayPage(formatDateKey(n)); };
    document.getElementById('todayBtn').onclick=()=>{ const t=new Date(); showDayPage(formatDateKey(t)); };
    window.location.hash = `#/day/${dateKey}`;
}

appTitle.onclick = ()=>{ const hash=window.location.hash||''; if(hash.startsWith('#/day')){ goHome(); } else { showDayPage(focusedDateKey || formatDateKey(new Date())); } };

function openMonthModal(year, month){
    monthSummary.innerHTML='';
    monthModal.classList.remove('hidden');
    monthModal.classList.add('flex');
    monthModalTitle.textContent = `${monthNameLong(month)} ${year}`;

    const presentHabits = data.habits.filter(h=>{
    const dim = new Date(year, month+1, 0).getDate();
    for(let d=1; d<=dim; d++){
        const dk = formatDateKey(new Date(year, month, d));
        if(isHabitActiveOn(h, dk)) return true;
    }
    return false;
    });

    const prev1Y = (month===0)? year-1 : year;
    const prev1M = (month===0)? 11 : month-1;
    const prev2Y = (month===0? year-1 : (month===1? year-1 : year));
    const prev2M = (month+10)%12;

    presentHabits.forEach(h=>{
    const rNow = monthRateCached(h, year, month);
    const r1   = monthRateCached(h, prev1Y, prev1M);
    const r2   = monthRateCached(h, prev2Y, prev2M);

    const arrow1 = r1>rNow ? '▼' : (r1<rNow ? '▲' : '=');
    const cls1   = r1>rNow ? 'chip-down' : (r1<rNow ? 'chip-up' : 'chip-neutral');
    const arrow2 = r2>rNow ? '▼' : (r2<rNow ? '▲' : '=');
    const cls2   = r2>rNow ? 'chip-down' : (r2<rNow ? 'chip-up' : 'chip-neutral');

    const bestMax = habitAllTimeMonthlyMaxCached(h);
    const isATH   = Math.round(rNow*1000) === Math.round(bestMax*1000) && bestMax>0;
    const nowClass= isATH ? 'gold-chip' : 'chip-neutral';

    const row=document.createElement('div');
    row.className='flex items-center justify-between bg-white/5 rounded-lg px-3 py-2';
    row.innerHTML=`
        <div class="font-medium">${h.name}</div>
        <div class="flex items-center gap-2 text-xs">
        <span class="chip ${nowClass}">${monthNameShort(month)}: ${Math.round(rNow*100)}%</span>
        <span class="chip ${cls1}">${arrow1} ${monthNameShort(prev1M)}: ${Math.round(r1*100)}%</span>
        <span class="chip ${cls2}">${arrow2} ${monthNameShort(prev2M)}: ${Math.round(r2*100)}%</span>
        </div>`;
    monthSummary.appendChild(row);
    });
}
document.getElementById('closeMonth').onclick=()=>{ monthModal.classList.add('hidden'); monthModal.classList.remove('flex'); };

function openYearModal(year){
    yearSummary.innerHTML='';
    yearModal.classList.remove('hidden');
    yearModal.classList.add('flex');
    yearModalTitle.textContent = `${year}`;

    const habitsInYear = data.habits.filter(h=>{
    for(let m=0;m<12;m++){
        const dim=new Date(year, m+1, 0).getDate();
        for(let d=1; d<=dim; d++){
        const dk=formatDateKey(new Date(year, m, d));
        if(isHabitActiveOn(h, dk)) return true;
        }
    }
    return false;
    });

    habitsInYear.forEach(h=>{
    const wrapper=document.createElement('div');
    wrapper.className='bg-white/5 rounded-lg p-3';

    const title=document.createElement('div');
    title.className='font-semibold mb-2';
    title.textContent=h.name;
    wrapper.appendChild(title);

    const bars=document.createElement('div');
    bars.className='grid grid-cols-12 items-end gap-1 h-24';

    for(let m=0;m<12;m++){
        const rate=monthRateCached(h, year, m);
        const height=Math.round(rate*100);
        const bar=document.createElement('div');
        bar.className='bar';
        bar.style.height=Math.max(2,height)+'%';
        bar.title=`${monthNameShort(m)}: ${Math.round(rate*100)}%`;
        if(height===0) bar.classList.add('bar-muted');
        bars.appendChild(bar);
    }

    const legend=document.createElement('div');
    legend.className='mt-2 text-[10px] text-white/60 grid grid-cols-12 gap-1';
    for(let m=0;m<12;m++){
        const l=document.createElement('div');
        l.className='text-center';
        l.textContent=monthNameShort(m)[0];
        legend.appendChild(l);
    }

    wrapper.appendChild(bars);
    wrapper.appendChild(legend);
    yearSummary.appendChild(wrapper);
    });
}
document.getElementById('closeYear').onclick=()=>{ yearModal.classList.add('hidden'); yearModal.classList.remove('flex'); };

function goHome(){ homePage.classList.remove('hidden'); dayPage.classList.add('hidden'); window.location.hash='#/home'; focusCurrentMonth(); }

const modalAddHabit=document.getElementById('modalAddHabit');
document.getElementById('addHabitBtn').onclick = ()=>{
    // reset champs de base
    document.getElementById('habitNameInput').value = '';
    document.getElementById('habitStartInput').value = new Date().toISOString().slice(0,10);

    // weekly par défaut
    document.getElementById('freqWeeklyRadio').checked   = true;
    document.getElementById('freqIntervalRadio').checked = false;
    document.getElementById('freqMonthlyRadio').checked  = false;

    // tous les jours actifs en vert
    Array.from(document.querySelectorAll('#weeklyDaysRow .dayToggle')).forEach(btn=>{
    btn.classList.add('bg-[rgb(0,200,75)]','text-black','border-green-400/40');
    btn.classList.remove('bg-white/10','text-white/80','border-white/10');
    });

    // valeurs défaut interval/monthly
    document.getElementById('everyXDaysInput').value = "3";
    document.getElementById('dayOfMonthInput').value = "1";

    modalAddHabit.classList.remove('hidden');
    modalAddHabit.classList.add('flex');
};

// Exclusivité visuelle des modes
function activateMode(mode){
    const rW = document.getElementById('freqWeeklyRadio');
    const rI = document.getElementById('freqIntervalRadio');
    const rM = document.getElementById('freqMonthlyRadio');

    rW.checked = (mode === 'weekly');
    rI.checked = (mode === 'interval');
    rM.checked = (mode === 'monthly');
}

// click sur le bloc weekly
document.getElementById('freqWeeklyBlock').addEventListener('click', (e)=>{
    // si on clique sur un bouton jour, on reste en weekly
    activateMode('weekly');
    e.stopPropagation();
});

// click sur le bloc interval
document.getElementById('freqIntervalBlock').addEventListener('click', (e)=>{
    activateMode('interval');
    e.stopPropagation();
});

// click sur le bloc monthly
document.getElementById('freqMonthlyBlock').addEventListener('click', (e)=>{
    activateMode('monthly');
    e.stopPropagation();
});

// toggle des jours de la semaine
document.querySelectorAll('#weeklyDaysRow .dayToggle').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
    // forcer le mode weekly (l'utilisateur a touché aux jours)
    activateMode('weekly');

    const active = btn.classList.contains('bg-[rgb(0,200,75)]');
    if (active){
        // passe en gris --> inactif
        btn.classList.remove('bg-[rgb(0,200,75)]','text-black','border-green-400/40');
        btn.classList.add('bg-white/10','text-white/80','border-white/10');
    } else {
        // passe en vert --> actif
        btn.classList.add('bg-[rgb(0,200,75)]','text-black','border-green-400/40');
        btn.classList.remove('bg-white/10','text-white/80','border-white/10');
    }
    e.stopPropagation();
    });
});

// si l'utilisateur tape dans le champ "tous les X jours", on force interval
document.getElementById('everyXDaysInput').addEventListener('input', ()=>{
    activateMode('interval');
});

// si l'utilisateur tape dans le champ "le X du mois", on force monthly
document.getElementById('dayOfMonthInput').addEventListener('input', ()=>{
    activateMode('monthly');
});


document.getElementById('cancelAddHabit').onclick=()=>{ modalAddHabit.classList.add('hidden'); modalAddHabit.classList.remove('flex'); };
document.getElementById('confirmAddHabit').onclick = async ()=>{
    const name  = document.getElementById('habitNameInput').value.trim();
    const start = document.getElementById('habitStartInput').value;

    if (!name || !start) {
    alert('Nom et date requis');
    return;
    }

    // Déterminer quel mode est actif
    const modeWeekly   = document.getElementById('freqWeeklyRadio').checked;
    const modeInterval = document.getElementById('freqIntervalRadio').checked;
    const modeMonthly  = document.getElementById('freqMonthlyRadio').checked;

    let habitPayload = {
    name,
    startDate: start,
    mode: null,
    daysOfWeek: null,
    everyXDays: null,
    dayOfMonth: null
    };

    if (modeWeekly) {
    habitPayload.mode = "weekly";
    const dayBtns = Array.from(document.querySelectorAll('#weeklyDaysRow .dayToggle'));
    habitPayload.daysOfWeek = dayBtns
        .filter(btn => btn.classList.contains('bg-[rgb(0,200,75)]')) // vert = actif
        .map(btn => parseInt(btn.getAttribute('data-dow'), 10));
    if (habitPayload.daysOfWeek.length === 0) {
        alert("Choisis au moins un jour pour l'option hebdomadaire.");
        return;
    }
    } else if (modeInterval) {
    habitPayload.mode = "interval";
    const val = parseInt(document.getElementById('everyXDaysInput').value, 10);
    if (isNaN(val) || val < 1) {
        alert("Nombre de jours invalide.");
        return;
    }
    habitPayload.everyXDays = val;
    } else if (modeMonthly) {
    habitPayload.mode = "monthly";
    const domVal = parseInt(document.getElementById('dayOfMonthInput').value, 10);
    if (isNaN(domVal) || domVal < 1 || domVal > 31) {
        alert("Jour du mois invalide (1-31).");
        return;
    }
    habitPayload.dayOfMonth = domVal;
    } else {
    // Si rien n'est coché, on force weekly par défaut avec tous les jours
    habitPayload.mode = "weekly";
    habitPayload.daysOfWeek = [1,2,3,4,5,6,0];
    }

    const res = addHabitSmart(habitPayload);

    clearHabitCaches(name);
    await persistDebounced(0);

    modalAddHabit.classList.add('hidden');
    modalAddHabit.classList.remove('flex');
    renderYears();
};


let lastIsSmall = null;
let resizeTimer = null;

function router(){
    const hash = window.location.hash || '';
    const [, route, a] = hash.split('/');
    const small = isSmall();

    if (route === 'day' && a) {
    showDayPage(a);
    return;
    }

    if (small) {
    const today = formatDateKey(new Date());
    if (route !== 'day') {
        window.location.hash = `#/day/${today}`;
    }
    showDayPage(a || today);
    return;
    }

    if (route === 'day' && !a) {
    const today = formatDateKey(new Date());
    window.location.hash = `#/day/${today}`;
    showDayPage(today);
    } else {
    goHome();
    }
}

window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
    const small = isSmall();
    if (lastIsSmall === null || small !== lastIsSmall) {
        lastIsSmall = small;
        router();
    }
    }, 120);
});

lastIsSmall = isSmall();

window.addEventListener('hashchange', router); window.addEventListener('resize', router);

function bindOverlayClose(overlayEl, closeFn){ if(!overlayEl) return; overlayEl.addEventListener('click', (e)=>{ if(e.target === overlayEl) closeFn(); }); }
bindOverlayClose(modalAddHabit, ()=>{ modalAddHabit.classList.add('hidden'); modalAddHabit.classList.remove('flex'); });
bindOverlayClose(monthModal, ()=>{ monthModal.classList.add('hidden'); monthModal.classList.remove('flex'); });
bindOverlayClose(yearModal, ()=>{ yearModal.classList.add('hidden'); yearModal.classList.remove('flex'); });
bindOverlayClose(modalInstall, ()=>{ modalInstall.classList.add('hidden'); modalInstall.classList.remove('flex'); });

let app, db, docRef, unsubSnap, auth, currentUser;

const authModal   = document.getElementById('authModal');
const authEmail   = document.getElementById('authEmail');
const authPass    = document.getElementById('authPassword');
const authErrorEl = document.getElementById('authError');
const authSubmit  = document.getElementById('authSubmit');
const authCreate  = document.getElementById('authCreate');
const forgotPassword = document.getElementById('forgotPassword');

const showAuthModal = () => { authModal.classList.remove('hidden'); authModal.classList.add('flex'); };
const hideAuthModal = () => { authModal.classList.add('hidden'); authModal.classList.remove('flex'); };
// === Pretty screenshot toggles (hide desc + buttons) ===
const monthModalRoot = document.getElementById('modalMonth');
const yearModalRoot  = document.getElementById('modalYear');

const monthScrBtn = document.getElementById('monthScrBtn');
const yearScrBtn  = document.getElementById('yearScrBtn');

const closeMonthBtn = document.getElementById('closeMonth');
const closeYearBtn  = document.getElementById('closeYear');

const monthBackdrop = document.getElementById('monthBackdrop');
const yearBackdrop  = document.getElementById('yearBackdrop');

const monthDesc = document.getElementById('monthDesc');
const yearDesc  = document.getElementById('yearDesc');

function setShotUI(active, { root, backdrop, scrBtn, closeBtn, desc }) {
  if (active) {
    backdrop.classList.remove('hidden');
    root.classList.add('modal-screenshot');
    // cache la description et les boutons
    desc?.classList.add('hidden');
    scrBtn?.classList.add('hidden');
    closeBtn?.classList.add('hidden');
  } else {
    backdrop.classList.add('hidden');
    root.classList.remove('modal-screenshot');
    // ré-affiche la description et les boutons
    desc?.classList.remove('hidden');
    scrBtn?.classList.remove('hidden');
    closeBtn?.classList.remove('hidden');
  }
}

function toggleScreenshot(root, backdrop, scrBtn, closeBtn, desc) {
  const active = !root.classList.contains('modal-screenshot');
  setShotUI(active, { root, backdrop, scrBtn, closeBtn, desc });
}

// Click sur “Scr Sht”
monthScrBtn?.addEventListener('click', () =>
  toggleScreenshot(monthModalRoot, monthBackdrop, monthScrBtn, closeMonthBtn, monthDesc)
);
yearScrBtn?.addEventListener('click', () =>
  toggleScreenshot(yearModalRoot, yearBackdrop, yearScrBtn, closeYearBtn, yearDesc)
);

// Fermeture via bouton → sort du mode screenshot proprement
closeMonthBtn?.addEventListener('click', () =>
  setShotUI(false, { root: monthModalRoot, backdrop: monthBackdrop, scrBtn: monthScrBtn, closeBtn: closeMonthBtn, desc: monthDesc })
);
closeYearBtn?.addEventListener('click', () =>
  setShotUI(false, { root: yearModalRoot, backdrop: yearBackdrop, scrBtn: yearScrBtn, closeBtn: closeYearBtn, desc: yearDesc })
);

// Fermeture en cliquant l’overlay → sort du mode screenshot aussi
function bindBlobAutoOff(overlayEl, backdropEl, scrBtn, closeBtn, desc) {
  overlayEl?.addEventListener('click', (e) => {
    if (e.target === overlayEl) {
      setShotUI(false, { root: overlayEl, backdrop: backdropEl, scrBtn, closeBtn, desc });
    }
  });
}
bindBlobAutoOff(monthModalRoot, monthBackdrop, monthScrBtn, closeMonthBtn, monthDesc);
bindBlobAutoOff(yearModalRoot,  yearBackdrop,  yearScrBtn,  closeYearBtn,  yearDesc);


// Utilitaire pour afficher des messages propres à l'utilisateur
function friendlyAuthError(code) {
  switch (code) {
    case 'auth/invalid-email':
      return "Email invalide.";
    case 'auth/missing-password':
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
      return "Email ou mot de passe incorrect.";
    case 'auth/user-not-found':
      return "Aucun compte trouvé avec cet email.";
    case 'auth/email-already-in-use':
      return "Cet email est déjà utilisé.";
    case 'auth/weak-password':
      return "Mot de passe trop faible (6 caractères minimum).";
    default:
      return "Une erreur est survenue. Réessaie.";
  }
}

// Bouton "Se connecter"
authSubmit.onclick = async () => {
  authErrorEl.textContent = "";

  const email = authEmail.value.trim();
  const pass  = authPass.value;

  if (!email || !pass) {
    authErrorEl.textContent = "Entre ton email et ton mot de passe.";
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, pass);
    // Pas besoin de plus ici : onAuthStateChanged() fera le reste
  } catch (err) {
    console.error("login error:", err);
    authErrorEl.textContent = friendlyAuthError(err.code);
  }
};

// Bouton "Créer un compte"
authCreate.onclick = async () => {
  authErrorEl.textContent = "";

  const email = authEmail.value.trim();
  const pass  = authPass.value;

  if (!email || !pass) {
    authErrorEl.textContent = "Choisis un email et un mot de passe (6+ caractères).";
    return;
  }

  try {
    await createUserWithEmailAndPassword(auth, email, pass);
    // L'utilisateur est maintenant connecté automatiquement,
    // puis onAuthStateChanged() va cacher la modale etc.
  } catch (err) {
    console.error("signup error:", err);
    authErrorEl.textContent = friendlyAuthError(err.code);
  }
};

// Lien "Mot de passe oublié ?"
forgotPassword.onclick = async () => {
  authErrorEl.textContent = "";

  const email = authEmail.value.trim();
  if (!email) {
    authErrorEl.textContent = "Entre d'abord ton email, puis reclique.";
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);
    authErrorEl.textContent = "Email de réinitialisation envoyé ✔︎";
  } catch (err) {
    console.error("reset error:", err);
    authErrorEl.textContent = friendlyAuthError(err.code);
  }
};


function setAuthedUI(authed){
    if (authed){
    hideAppForAuth(false);
    hideAuthModal();
    burgerBtn?.classList.remove('hidden');

    const em = (auth?.currentUser && auth.currentUser.email) || '';
    const local = extractLocalPart(em);
    if (local){
        userNamePart.textContent = local;
        userBadge.classList.remove('hidden');
    } else {
        userNamePart.textContent = '—';
        userBadge.classList.add('hidden');
    }
    } else {
    hideAppForAuth(true);
    showAuthModal();
    burgerBtn?.classList.add('hidden');
    closeNavPanel();

    userNamePart.textContent = '—';
    userBadge.classList.add('hidden');
    }
}

async function initFirebaseAll(){
    // initialise Firebase app
    app  = initializeApp(firebaseConfig);

    // initialise Firestore AVEC cache persistant moderne (remplace enableIndexedDbPersistence)
    db = initializeFirestore(app, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager() // support multi-onglets
    })
    });

    // auth
    auth = getAuth(app);

    // on garde ta persistance login dans le navigateur
    await setPersistence(auth, browserLocalPersistence);

    // le reste reste identique
    onAuthStateChanged(auth, async (user)=>{
    currentUser = user || null;

    if (unsubSnap) {
        try { unsubSnap(); } catch(e){}
        unsubSnap = null;
    }

    if (!currentUser){
        setAuthedUI(false);
        return;
    }

    setAuthedUI(true);

    docRef = doc(db, 'users', currentUser.uid, 'data', 'fourpill');

    unsubSnap = onSnapshot(docRef, (snap)=>{
        if (snap.exists()){
        const server = snap.data();
        if (server._rev && server._rev === lastLocalRev){
            return;
        }
        data = server;
        clearAllCaches();
        } else {
        data = { habits:[], completions:{}, _rev:0 };
        setDoc(docRef, data).catch(console.error);
        }

        if (!initialSynced){
        renderYears();
        router();
        focusCurrentMonth();
        initialSynced = true;
        } else {
        if (focusedDateKey) updateDayCell(focusedDateKey);
        }
    }, (err)=>{ console.error('onSnapshot error', err); });
    });
}

(async function initApp(){
    await initFirebaseAll();
})();
