let initializeApp;
let initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, doc, onSnapshot, setDoc;
let getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence;
let signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail;

async function loadFirebaseSdk(){
    const [appModule, firestoreModule, authModule] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js'),
        import('https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js')
    ]);
    ({ initializeApp } = appModule);
    ({ initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, doc, onSnapshot, setDoc } = firestoreModule);
    ({
        getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence,
        signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
    } = authModule);
}


const firebaseConfig = { apiKey: "AIzaSyBptpMFEMc7ikXM0PtDOeWUHnMegKQ6hcs", authDomain: "habit-8d57f.firebaseapp.com", projectId: "habit-8d57f", storageBucket: "habit-8d57f.appspot.com", messagingSenderId: "934416417831", appId: "1:934416417831:web:63f2f0554daa6d3ff23a02" };

let data = { habits: [], tasks: [], taskRolloverSkips: {}, dayColors: {}, completions: {}, _rev: 0 };
let initialSynced = false;

const HABIT_STATUS = Object.freeze({
    PENDING: 'pending',
    DONE: 'done'
});
const TASK_STATUS = Object.freeze({
    PENDING: 'pending',
    DONE: 'done',
    LATER: 'later',
    SKIPPED: 'skipped'
});
const TASK_STATUS_CYCLE = [TASK_STATUS.DONE, TASK_STATUS.LATER, TASK_STATUS.SKIPPED, TASK_STATUS.PENDING];
const DAY_COLOR_CYCLE = ['default', 'green', 'blue', 'purple', 'orange', 'red', 'gray'];
const DAY_COLOR_LABELS = Object.freeze({
    default: 'Gris de base',
    green: 'Vert',
    blue: 'Bleu',
    purple: 'Violet',
    orange: 'Orange',
    red: 'Rouge',
    gray: 'Gris'
});
let activeDayColorPicker = null;
let activeDayColorAnchor = null;

function normalizeTaskStatus(status){
    if(status === true || status === TASK_STATUS.DONE) return TASK_STATUS.DONE;
    if(status === TASK_STATUS.LATER) return TASK_STATUS.LATER;
    if(status === TASK_STATUS.SKIPPED) return TASK_STATUS.SKIPPED;
    return TASK_STATUS.PENDING;
}

function normalizedTaskName(name){
    return String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr');
}

function taskRolloverRootId(task){
    return String(task?.rolloverRootId || task?.id || '');
}

function normalizeTaskRolloverSkips(rawSkips){
    const normalized = {};
    if(!rawSkips || typeof rawSkips !== 'object' || Array.isArray(rawSkips)) return normalized;
    Object.entries(rawSkips).forEach(([dateKey, rootIds]) => {
        if(!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !Array.isArray(rootIds)) return;
        const uniqueIds = [...new Set(rootIds.map(String).filter(Boolean))];
        if(uniqueIds.length) normalized[dateKey] = uniqueIds;
    });
    return normalized;
}

function normalizeData(raw){
    const safe = raw && typeof raw === 'object' ? raw : {};
    const sourceHabits = Array.isArray(safe.habits) ? safe.habits.filter(Boolean) : [];
    const recurringHabits = sourceHabits.filter(habit => habit.mode !== 'once');
    const storedTasks = Array.isArray(safe.tasks) ? safe.tasks.filter(Boolean) : [];
    const migratedOneOffTasks = sourceHabits
        .filter(habit => habit.mode === 'once' && habit.name && habit.startDate)
        .map((habit, index) => ({
            id: `legacy-${habit.startDate}-${normalizeHabitName(habit.name)}-${index}`,
            name: String(habit.name).trim(),
            date: habit.startDate,
            status: normalizeTaskStatus(safe.completions?.[habit.startDate]?.[habit.name])
        }));
    const seenTasks = new Set();
    const tasks = [...storedTasks, ...migratedOneOffTasks].map((task, index) => ({
        id: String(task.id || `task-${task.date || task.dateKey || task.startDate || 'unknown'}-${index}`),
        name: String(task.name || '').trim().replace(/\s+/g, ' '),
        date: String(task.date || task.dateKey || task.startDate || ''),
        kind: task.kind === 'separator' ? 'separator' : 'task',
        status: normalizeTaskStatus(task.status),
        important: task.important === true,
        groupBreakBefore: task.groupBreakBefore === true,
        rolloverFromId: task.rolloverFromId ? String(task.rolloverFromId) : null,
        rolloverRootId: task.rolloverRootId ? String(task.rolloverRootId) : null
    })).filter(task => {
        if((task.kind !== 'separator' && !task.name) || !/^\d{4}-\d{2}-\d{2}$/.test(task.date) || seenTasks.has(task.id)) return false;
        seenTasks.add(task.id);
        return true;
    });
    const tasksById = new Map(tasks.map(task => [task.id, task]));
    const latestTaskByName = new Map();
    [...tasks].sort((a, b) => a.date.localeCompare(b.date)).forEach(task => {
        const nameKey = normalizedTaskName(task.name);
        if(task.kind === 'separator'){
            task.rolloverRootId = null;
            return;
        }
        if(task.rolloverFromId && !task.rolloverRootId){
            let ancestor = tasksById.get(task.rolloverFromId);
            const visited = new Set([task.id]);
            while(ancestor && !visited.has(ancestor.id)){
                visited.add(ancestor.id);
                if(ancestor.rolloverRootId){
                    task.rolloverRootId = ancestor.rolloverRootId;
                    break;
                }
                if(!ancestor.rolloverFromId){
                    task.rolloverRootId = ancestor.id;
                    break;
                }
                ancestor = tasksById.get(ancestor.rolloverFromId);
            }
            if(!task.rolloverRootId){
                const previousSameName = latestTaskByName.get(nameKey);
                task.rolloverRootId = previousSameName ? taskRolloverRootId(previousSameName) : task.id;
            }
        }
        if(task.rolloverFromId) task.rolloverRootId ||= task.id;
        else task.rolloverRootId = null;
        const previousSameName = latestTaskByName.get(nameKey);
        if(!previousSameName || previousSameName.date < task.date) latestTaskByName.set(nameKey, task);
    });

    const taskStatusPriority = {
        [TASK_STATUS.LATER]: 0,
        [TASK_STATUS.PENDING]: 1,
        [TASK_STATUS.SKIPPED]: 2,
        [TASK_STATUS.DONE]: 3
    };
    const uniqueTasks = [];
    const taskByDateAndName = new Map();
    tasks.forEach(task => {
        if(task.kind === 'separator'){
            uniqueTasks.push(task);
            return;
        }
        const duplicateKey = `${task.date}|${normalizedTaskName(task.name)}`;
        const existing = taskByDateAndName.get(duplicateKey);
        if(!existing){
            taskByDateAndName.set(duplicateKey, task);
            uniqueTasks.push(task);
            return;
        }
        existing.important ||= task.important;
        if(existing.rolloverFromId && taskStatusPriority[task.status] > taskStatusPriority[existing.status]) existing.status = task.status;
        if(!existing.rolloverRootId && task.rolloverRootId) existing.rolloverRootId = task.rolloverRootId;
    });

    const taskRolloverSkips = normalizeTaskRolloverSkips(safe.taskRolloverSkips);
    const datesByRolloverRoot = new Map();
    uniqueTasks.filter(task => task.kind !== 'separator').forEach(task => {
        const rootId = taskRolloverRootId(task);
        if(!datesByRolloverRoot.has(rootId)) datesByRolloverRoot.set(rootId, new Set());
        datesByRolloverRoot.get(rootId).add(task.date);
    });
    datesByRolloverRoot.forEach((dateKeys, rootId) => {
        if(dateKeys.size < 2) return;
        const orderedDates = [...dateKeys].sort();
        let cursor = orderedDates[0];
        const lastDate = orderedDates.at(-1);
        while(cursor < lastDate){
            cursor = nextDateKey(cursor);
            if(dateKeys.has(cursor)) continue;
            taskRolloverSkips[cursor] ||= [];
            if(!taskRolloverSkips[cursor].includes(rootId)) taskRolloverSkips[cursor].push(rootId);
        }
    });
    const tasksWithSeparators = [];
    uniqueTasks.forEach(task => {
        if(task.kind !== 'separator' && task.groupBreakBefore){
            const separatorId = `separator-before-${task.id}`;
            if(!seenTasks.has(separatorId)){
                tasksWithSeparators.push({ id:separatorId, name:'', date:task.date, kind:'separator', status:TASK_STATUS.PENDING, important:false, groupBreakBefore:false, rolloverFromId:null, rolloverRootId:null });
                seenTasks.add(separatorId);
            }
            task.groupBreakBefore = false;
        }
        tasksWithSeparators.push(task);
    });
    const dayColors = {};
    if(safe.dayColors && typeof safe.dayColors === 'object' && !Array.isArray(safe.dayColors)){
        Object.entries(safe.dayColors).forEach(([dateKey, color]) => {
            if(/^\d{4}-\d{2}-\d{2}$/.test(dateKey) && DAY_COLOR_CYCLE.includes(color) && color !== 'default') dayColors[dateKey] = color;
        });
    }
    return {
        ...safe,
        habits: recurringHabits,
        tasks: tasksWithSeparators,
        taskRolloverSkips,
        dayColors,
        completions: safe.completions && typeof safe.completions === 'object' && !Array.isArray(safe.completions) ? safe.completions : {},
        _rev: Number.isFinite(Number(safe._rev)) ? Number(safe._rev) : 0
    };
}

function getHabitStatus(dateKey, habitName){
    const raw = data.completions?.[dateKey]?.[habitName];
    if (raw === true || raw === HABIT_STATUS.DONE) return HABIT_STATUS.DONE;
    return HABIT_STATUS.PENDING;
}

function isHabitDone(dateKey, habitName){
    return getHabitStatus(dateKey, habitName) === HABIT_STATUS.DONE;
}

function setHabitStatus(dateKey, habitName, status){
    if (!data.completions[dateKey]) data.completions[dateKey] = {};
    if (status === HABIT_STATUS.PENDING) {
        delete data.completions[dateKey][habitName];
        if (Object.keys(data.completions[dateKey]).length === 0) delete data.completions[dateKey];
        return;
    }
    data.completions[dateKey][habitName] = status;
}

function showToast(message, tone = 'info'){
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const toast = document.createElement('div');
    toast.className = `app-toast${tone === 'error' ? ' app-toast--error' : ''}`;
    toast.textContent = message;
    stack.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3200);
}

function bindInputEnterSubmit(form, submitButton){
    if(!form || !submitButton) return;
    form.addEventListener('keydown', (event) => {
        const target = event.target;
        const isSubmittableInput = target instanceof HTMLInputElement && !['radio', 'checkbox', 'file', 'button', 'submit'].includes(target.type);
        if(event.key !== 'Enter' || event.isComposing || !isSubmittableInput) return;
        event.preventDefault();
        form.requestSubmit(submitButton);
    });
}

const textInputModal = document.getElementById('textInputModal');
const textInputForm = document.getElementById('textInputForm');
const textInputTitle = document.getElementById('textInputTitle');
const textInputDescription = document.getElementById('textInputDescription');
const textInputValue = document.getElementById('textInputValue');
const textInputMultiline = document.getElementById('textInputMultiline');
const textInputMultilineHint = document.getElementById('textInputMultilineHint');
const textInputConfirm = document.getElementById('textInputConfirm');
const textInputCancel = document.getElementById('textInputCancel');
let textInputResolver = null;
let textInputUsesMultiline = false;

function closeTextInputModal(value = null){
    textInputModal.classList.add('hidden');
    textInputModal.classList.remove('flex');
    const resolve = textInputResolver;
    textInputResolver = null;
    resolve?.(value);
}

function requestTextInput({ title, description = '', value = '', placeholder = 'Nom', confirmLabel = 'Ajouter', multiline = false }){
    if(textInputResolver) closeTextInputModal(null);
    textInputUsesMultiline = multiline;
    textInputTitle.textContent = title;
    textInputDescription.textContent = description;
    const activeInput = multiline ? textInputMultiline : textInputValue;
    const inactiveInput = multiline ? textInputValue : textInputMultiline;
    activeInput.value = value;
    activeInput.placeholder = placeholder;
    activeInput.classList.remove('hidden');
    inactiveInput.classList.add('hidden');
    textInputMultilineHint.classList.toggle('hidden', !multiline);
    textInputConfirm.textContent = confirmLabel;
    textInputModal.classList.remove('hidden');
    textInputModal.classList.add('flex');
    requestAnimationFrame(() => {
        activeInput.focus();
        if(value) activeInput.select();
    });
    return new Promise(resolve => { textInputResolver = resolve; });
}

textInputForm?.addEventListener('submit', event => {
    event.preventDefault();
    closeTextInputModal(textInputUsesMultiline ? textInputMultiline.value : textInputValue.value);
});
bindInputEnterSubmit(textInputForm, textInputConfirm);
textInputMultiline?.addEventListener('keydown', event => {
    if(event.key !== 'Enter' || event.isComposing || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    textInputForm.requestSubmit(textInputConfirm);
});
textInputCancel?.addEventListener('click', () => closeTextInputModal(null));
textInputModal?.addEventListener('click', event => {
    if(event.target === textInputModal) closeTextInputModal(null);
});

const caches = { bestStreak:new Map(), monthRate:new Map(), monthlyMax:new Map() };
const clearAllCaches = ()=>{ caches.bestStreak.clear(); caches.monthRate.clear(); caches.monthlyMax.clear(); };
const clearHabitCaches = (habitName)=>{ caches.bestStreak.delete(habitName); caches.monthlyMax.delete(habitName); for(const k of caches.monthRate.keys()){ if(k.startsWith(habitName+'|')) caches.monthRate.delete(k); } };
const clearMonthCacheForHabit = (habitName, y, m)=>{ caches.monthRate.delete(`${habitName}|${y}-${m}`); caches.monthlyMax.delete(habitName); };

const homePage = document.getElementById('homePage');
const yearsContainer = homePage;
const addHabitBtn = document.getElementById('addHabitBtn');
const dayPanel = document.getElementById('dayPanel');
const dayOverlay = document.getElementById('dayOverlay');
const panelDate = document.getElementById('panelDate');
const panelDateLong = document.getElementById('panelDateLong');
const habitsList = document.getElementById('habitsList');

const dayPage = document.getElementById('dayPage');
const dayTitle = document.getElementById('dayTitle');
const dayTitleSub = document.getElementById('dayTitleSub');
const mobileDayColor = document.getElementById('mobileDayColor');
const dayHabitsList = document.getElementById('dayHabitsList');
const mobileHabitsMode = document.getElementById('mobileHabitsMode');
const mobileTasksMode = document.getElementById('mobileTasksMode');

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
        showToast("Fichier invalide : export HBTRK attendu.", 'error');
        fileInput.value = '';
        return;
    }

    // 4. Injecter dans l'app
    data = normalizeData(imported);
    rollForwardLaterTasks();

    clearAllCaches();

    // 5. Forcer un rerender immédiat en local
    renderYears();

    // Si on a déjà une date affichée en vue day, on la rerend aussi
    if (focusedDateKey) {
        if (!dayPage.classList.contains('hidden')) {
        showDayPage(focusedDateKey);
        } else if (!isSmall()) {
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
        await setDoc(docRef, data);
        }
    } catch (errFirestore) {
        console.warn("Import local OK mais sync Firestore impossible (probablement pas connecté) :", errFirestore);
    }

    showToast('Importation réussie.');

    } catch (err) {
    console.error("Erreur d'import JSON :", err);
    showToast("Impossible de lire ce fichier. Vérifie qu’il s’agit bien d’un export HBTRK.", 'error');
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
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    showToast('HBTRK est installé.');
});

const appTitle = document.getElementById('appTitle');

let focusedDateKey = null;
const now = new Date(); const currentYear = now.getFullYear(); const currentMonth = now.getMonth();
let mobileLandscapeLocked = false;
let landscapeFullscreenOwned = false;
let mobileDayMode = localStorage.getItem('hbtrk-mobile-day-mode') === 'tasks' ? 'tasks' : 'habits';
let expandedMonthKey = null;
let expandedMonthMode = 'habits';
let expandedMonthFocusDateKey = null;
let minYear = 2025; let maxYear = currentYear + 5;
const viewportIsSmall = () => window.matchMedia('(max-width: 639px)').matches;
const isSmall = () => mobileLandscapeLocked || viewportIsSmall();

const formatDateKey = (d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseDateKey = (s)=> new Date(s+'T00:00:00');
const isValidDateKey = (value)=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parsed = parseDateKey(value);
    return !Number.isNaN(parsed.getTime()) && formatDateKey(parsed) === value;
};
const updateRouteHash = (hash, replace = false)=>{
    if(window.location.hash === hash) return;
    history[replace ? 'replaceState' : 'pushState'](null, '', hash);
};
const calendarDayNumber = (d)=> Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
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
    const diffDays = calendarDayNumber(d) - calendarDayNumber(start);
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


const getCompletionRate = (dateKey)=>{ const activeHabits = data.habits.filter(h=>isHabitActiveOn(h,dateKey)); if(activeHabits.length===0) return 0; const completed = activeHabits.filter(h=>isHabitDone(dateKey, h.name)).length; return completed / activeHabits.length; };

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
    dayPanel.setAttribute('aria-hidden', 'true');

    navOverlay.classList.add('hidden');
    navPanel.classList.add('hidden');
    navPanel.style.transform = 'translateX(calc(100% + 1rem))';
    navPanel.style.visibility = 'hidden';
    burgerIcon.classList.remove('hidden');
    closeIcon.classList.add('hidden');
    burgerBtn?.setAttribute('aria-expanded', 'false');

    modalAddHabit.classList.add('hidden'); modalAddHabit.classList.remove('flex');
    monthModal.classList.add('hidden');    monthModal.classList.remove('flex');
    yearModal.classList.add('hidden');     yearModal.classList.remove('flex');
    modalInstall.classList.add('hidden');  modalInstall.classList.remove('flex');
    if(textInputModal.classList.contains('flex')) closeTextInputModal(null);
};

const cmpDateStr = (a,b)=> (a<b? -1 : a>b? 1 : 0);

function normalizeHabitName(name){
    return String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr-FR');
}

function findHabitNameConflict(name, excludedHabit = null){
    const normalized = normalizeHabitName(name);
    return data.habits.find(h => h !== excludedHabit && normalizeHabitName(h.name) === normalized) || null;
}

function addHabitSmart(habitObj){
    const cleanName = String(habitObj.name || '').trim().replace(/\s+/g, ' ');
    if (!cleanName) return { action: 'invalid' };
    const duplicate = findHabitNameConflict(cleanName);
    if (duplicate) return { action: 'duplicate', target: duplicate };

    const created = {
        name: cleanName,
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
    burgerBtn?.setAttribute('aria-expanded', 'true');
}

function closeNavPanel() {
    navIsOpen = false;
    burgerBtn?.setAttribute('aria-expanded', 'false');

    // slide-out
    navPanel.style.transform = 'translateX(calc(100% + 1rem))';
    navOverlay.classList.add('hidden');

    // on cache APRÈS l'anim de transition
    let finished = false;
    const onEnd = () => {
    if(finished) return;
    finished = true;
    navPanel.removeEventListener('transitionend', onEnd);
    // si jamais entre-temps l'utilisateur a réouvert -> ne pas tout recacher
    if (!navIsOpen) {
        navPanel.classList.add('hidden');
        navPanel.style.visibility = 'hidden';

        burgerIcon.classList.remove('hidden');
        closeIcon.classList.add('hidden');
        burgerBtn?.setAttribute('aria-expanded', 'false');
    }
    };
    navPanel.addEventListener('transitionend', onEnd, { once: true });
    window.setTimeout(onEnd, 360);
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
    a.href=url;
    a.download=`HBTRK-backup-${formatDateKey(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(()=>URL.revokeObjectURL(url), 1000);
    showToast('Sauvegarde HBTRK exportée.');
    closeNavPanel();
};

menuLogout.onclick = async () => {
    try { await signOut(auth); } catch(e){ console.error(e); }
    closeNavPanel();
};

menuInstall.onclick = async () => {
    closeNavPanel();
    if(deferredInstallPrompt){
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        if(choice.outcome === 'accepted') showToast('Installation lancée.');
        return;
    }
    modalInstall.classList.remove('hidden');
    modalInstall.classList.add('flex');
    requestAnimationFrame(()=>closeInstall?.focus({ preventScroll:true }));
};

closeInstall.onclick = () => {
    modalInstall.classList.add('hidden');
    modalInstall.classList.remove('flex');
};

function computeStreakForHabit(habitName, asOfDateKey){
    let d = parseDateKey(asOfDateKey);
    let streak = 0;
    const habit = data.habits.find(h=>h.name===habitName && isHabitActiveOn(h, asOfDateKey)) || data.habits.find(h=>h.name===habitName);
    if(!habit) return 0;
    const start = parseDateKey(habit.startDate);
    while(d >= start){
        const key = formatDateKey(d);
        if(isHabitActiveOn(habit, key)){
            if(isHabitDone(key, habitName)) streak++;
            else break;
        }
        d.setDate(d.getDate()-1);
    }
    return streak;
}

function computeBestStreakCached(habitName){
    if(caches.bestStreak.has(habitName)) return caches.bestStreak.get(habitName);
    const habit = data.habits.find(h=>h.name===habitName); if(!habit) return 0;
    const keys = Object.keys(data.completions).sort();
    if(keys.length===0){ caches.bestStreak.set(habitName,0); return 0; }
    const start = parseDateKey(habit.startDate);
    const lastRecorded = parseDateKey(keys[keys.length-1]);
    const today = parseDateKey(formatDateKey(new Date()));
    const to = lastRecorded > today ? lastRecorded : today;
    let best = 0;
    let current = 0;
    for(let d = new Date(start); d <= to; d.setDate(d.getDate()+1)){
        const key = formatDateKey(d);
        if(!isHabitActiveOn(habit, key)) continue;
        if(isHabitDone(key, habitName)){
            current++;
            best = Math.max(best, current);
        } else {
            current = 0;
        }
    }
    caches.bestStreak.set(habitName,best); return best;
}

function monthRateCached(h, year, month){ const key=`${h.name}|${year}-${month}`; if(caches.monthRate.has(key)) return caches.monthRate.get(key); const r = monthRate(h, year, month); caches.monthRate.set(key,r); return r; }
function monthRate(h, year, month){ const daysInMonth = new Date(year, month+1, 0).getDate(); let activeDays = 0, doneDays = 0; for(let d=1; d<=daysInMonth; d++){ const dk = formatDateKey(new Date(year, month, d)); if(isHabitActiveOn(h, dk)){ activeDays++; if(isHabitDone(dk, h.name)) doneDays++; } } return activeDays===0 ? 0 : doneDays/activeDays; }
function habitAllTimeMonthlyMaxCached(h){ if(caches.monthlyMax.has(h.name)) return caches.monthlyMax.get(h.name); let max=0; for(let y=minYear;y<=maxYear;y++){ for(let m=0;m<12;m++){ const r=monthRateCached(h,y,m); if(r>max) max=r; } } caches.monthlyMax.set(h.name,max); return max; }

function expandedMonthCard(year, month){
    return document.querySelector(`.month-task-card[data-year="${year}"][data-month="${month}"]`);
}

function refreshHomeMonthCard(year, month){
    const current = expandedMonthCard(year, month);
    if(!current) return null;
    const replacement = makeHomeMonthCard(year, month);
    current.replaceWith(replacement);
    return replacement;
}

function scrollExpandedMonthIntoView(year, month, dateKey = null){
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const card = expandedMonthCard(year, month);
        if(!card) return;
        const focusedDay = dateKey ? card.querySelector(`.compact-day[data-date-key="${dateKey}"]`) : null;
        (focusedDay || card).scrollIntoView({ block:focusedDay ? 'center' : 'start', inline:'nearest', behavior:'smooth' });
        if(!focusedDay) return;
        const wrap = focusedDay.closest('.compact-calendar-wrap');
        if(wrap){
            const targetLeft = focusedDay.offsetLeft - (wrap.clientWidth - focusedDay.clientWidth) / 2;
            wrap.scrollTo({ left:Math.max(0, targetLeft), behavior:'smooth' });
        }
        focusedDay.focus({ preventScroll:true });
    }));
}

function openExpandedMonth(year, month, mode = 'habits', dateKey = null){
    const previousMonthKey = expandedMonthKey;
    expandedMonthKey = `${year}-${month}`;
    expandedMonthMode = mode === 'tasks' ? 'tasks' : 'habits';
    expandedMonthFocusDateKey = dateKey;
    closeDayPanel();
    if(previousMonthKey && previousMonthKey !== expandedMonthKey){
        const [previousYear, previousMonth] = previousMonthKey.split('-').map(Number);
        refreshHomeMonthCard(previousYear, previousMonth);
    }
    refreshHomeMonthCard(year, month);
    scrollExpandedMonthIntoView(year, month, dateKey);
}

function setExpandedMonthMode(mode, year, month){
    const nextMode = mode === 'tasks' ? 'tasks' : 'habits';
    if(expandedMonthKey !== `${year}-${month}`) return openExpandedMonth(year, month, nextMode);
    if(expandedMonthMode === nextMode) return;
    expandedMonthMode = nextMode;
    closeDayColorPicker();
    refreshHomeMonthCard(year, month);
    scrollExpandedMonthIntoView(year, month, expandedMonthFocusDateKey);
}

function closeExpandedMonth(year, month){
    if(expandedMonthKey !== `${year}-${month}`) return;
    expandedMonthKey = null;
    expandedMonthFocusDateKey = null;
    closeDayColorPicker();
    refreshHomeMonthCard(year, month);
    requestAnimationFrame(() => expandedMonthCard(year, month)?.scrollIntoView({ block:'center', inline:'nearest', behavior:'smooth' }));
}

function makeHomeMonthCard(y, m){
    const expanded = expandedMonthKey === `${y}-${m}`;
    const month=document.createElement('div');
    month.className='p-3 rounded-lg bg-white/5 month-task-card';
    month.dataset.year=y;
    month.dataset.month=m;
    month.classList.toggle('is-current-month', y === currentYear && m === currentMonth);
    if(expanded) month.classList.add('compact-month-card','is-expanded');

    const titleRow=document.createElement('div');
    titleRow.className='month-title-row';
    const mtitle=document.createElement('button');
    mtitle.type='button';
    mtitle.className='month-name-button';
    mtitle.textContent=expanded ? monthNameLong(m) : monthNameShort(m);
    mtitle.dataset.year=y;
    mtitle.dataset.month=m;
    mtitle.setAttribute('aria-label', `Voir le bilan de ${monthNameLong(m)} ${y}`);
    mtitle.onclick=()=>openMonthModal(y,m);

    if(expanded){
        const controls=document.createElement('div');
        controls.className='expanded-month-controls';
        const modeToggle=document.createElement('div');
        modeToggle.className='mobile-mode-toggle expanded-month-mode-toggle';
        modeToggle.setAttribute('role', 'group');
        modeToggle.setAttribute('aria-label', `Contenu de ${monthNameLong(m)} ${y}`);
        const habitsMode=document.createElement('button');
        habitsMode.type='button';
        habitsMode.className='mobile-mode-option expanded-month-mode-option';
        habitsMode.textContent='Habits';
        habitsMode.setAttribute('aria-pressed', String(expandedMonthMode === 'habits'));
        habitsMode.onclick=()=>setExpandedMonthMode('habits', y, m);
        const tasksMode=document.createElement('button');
        tasksMode.type='button';
        tasksMode.className='mobile-mode-option expanded-month-mode-option';
        tasksMode.textContent='Tasks';
        tasksMode.setAttribute('aria-pressed', String(expandedMonthMode === 'tasks'));
        tasksMode.onclick=()=>setExpandedMonthMode('tasks', y, m);
        modeToggle.append(habitsMode, tasksMode);

        const close=document.createElement('button');
        close.type='button';
        close.className='expanded-month-close';
        close.setAttribute('aria-label', `Fermer ${monthNameLong(m)} ${y}`);
        close.title='Fermer le mois';
        close.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
        close.onclick=()=>closeExpandedMonth(y,m);
        controls.append(modeToggle, close);
        titleRow.append(mtitle, controls);
    } else {
        const expand=document.createElement('button');
        expand.type='button';
        expand.className='month-expand-button';
        expand.setAttribute('aria-label', `Développer ${monthNameLong(m)} ${y}`);
        expand.title='Développer le mois';
        expand.innerHTML='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        expand.onclick=()=>openExpandedMonth(y,m,'habits');
        titleRow.append(mtitle, expand);
    }
    month.appendChild(titleRow);

    if(expanded){
        const meta=document.createElement('div');
        meta.className='compact-month-meta';
        meta.textContent=expandedMonthMeta(y,m,expandedMonthMode);
        month.append(meta, makeCompactCalendarWrap(y,m,expandedMonthMode));
    } else {
        const weekdays=document.createElement('div');
        weekdays.className='grid grid-cols-7 gap-1 mb-1 text-[9px] text-white/35 text-center';
        ['L','M','M','J','V','S','D'].forEach(label=>{
            const weekday=document.createElement('div');
            weekday.textContent=label;
            weekdays.appendChild(weekday);
        });
        month.appendChild(weekdays);
        const days=document.createElement('div');
        days.className='grid grid-cols-7 gap-1 text-xs text-white/80';
        const first=new Date(y,m,1);
        const total=new Date(y,m+1,0).getDate();
        const offset=(first.getDay() + 6) % 7;
        for(let i=0;i<offset;i++) days.appendChild(Object.assign(document.createElement('div'),{className:'text-white/10',innerHTML:'\u00A0'}));
        for(let d=1; d<=total; d++){
            const date=new Date(y,m,d);
            const dk=formatDateKey(date);
            const btn=document.createElement('button');
            btn.className='day-cell text-[11px]';
            btn.textContent=d;
            btn.dataset.dateKey=dk;
            btn.setAttribute('aria-label', parseDateKey(dk).toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' }));
            applyDayCellStyle(btn, dk);
            if(dk===formatDateKey(new Date())){
                btn.classList.add('ring-2','ring-white/10');
                btn.setAttribute('aria-current', 'date');
            }
            btn.onclick=()=>openExpandedMonth(y,m,'habits',dk);
            days.appendChild(btn);
        }
        month.appendChild(days);
    }
    return month;
}

function ensureYearRendered(y){
    if(document.getElementById('year-'+y)) return;
    const el = document.createElement('section');
    el.id='year-'+y;
    el.className='year-block rounded-full p-4';
    const title=document.createElement('h2');
    title.className='year-title';
    const titleButton=document.createElement('button');
    titleButton.type='button';
    titleButton.className='year-title-button';
    titleButton.textContent=y;
    titleButton.dataset.year=y;
    titleButton.setAttribute('aria-label', `Voir le bilan de l’année ${y}`);
    titleButton.onclick=()=>openYearModal(y);
    title.appendChild(titleButton);
    el.appendChild(title);
    const grid=document.createElement('div');
    grid.className='grid month-grid gap-4';
    for(let m=0;m<12;m++) grid.appendChild(makeHomeMonthCard(y,m));
    el.appendChild(grid);
    yearsContainer.appendChild(el);
}

function tasksForDate(dateKey){
    return data.tasks.filter(task => task.date === dateKey);
}

function nextDateKey(dateKey){
    const next = parseDateKey(dateKey);
    next.setDate(next.getDate() + 1);
    return formatDateKey(next);
}

function isTaskRolloverSkipped(rootId, dateKey){
    return Array.isArray(data.taskRolloverSkips?.[dateKey]) && data.taskRolloverSkips[dateKey].includes(rootId);
}

function rememberTaskRolloverSkip(task){
    if(!task?.rolloverFromId) return;
    const rootId = taskRolloverRootId(task);
    if(!rootId) return;
    data.taskRolloverSkips ||= {};
    data.taskRolloverSkips[task.date] ||= [];
    if(!data.taskRolloverSkips[task.date].includes(rootId)) data.taskRolloverSkips[task.date].push(rootId);
}

function rollForwardLaterTasks(){
    const todayKey = formatDateKey(new Date());
    const occupiedTargets = new Set(data.tasks
        .filter(task => task.kind !== 'separator')
        .flatMap(task => [
            `${taskRolloverRootId(task)}|${task.date}`,
            `name:${normalizedTaskName(task.name)}|${task.date}`
        ]));
    const createdCopies = [];
    let created = 0;
    for(let index = 0; index < data.tasks.length; index++){
        const task = data.tasks[index];
        if(task.kind === 'separator' || task.status !== TASK_STATUS.LATER || task.date >= todayKey) continue;
        const targetDate = nextDateKey(task.date);
        const rootId = taskRolloverRootId(task);
        const targetKey = `${rootId}|${targetDate}`;
        const targetNameKey = `name:${normalizedTaskName(task.name)}|${targetDate}`;
        if(isTaskRolloverSkipped(rootId, targetDate) || occupiedTargets.has(targetKey) || occupiedTargets.has(targetNameKey)) continue;
        const copy = {
            id: makeTaskId(),
            name: task.name,
            date: targetDate,
            kind: 'task',
            status: TASK_STATUS.LATER,
            important: task.important,
            groupBreakBefore: task.groupBreakBefore,
            rolloverFromId: task.id,
            rolloverRootId: rootId
        };
        data.tasks.push(copy);
        createdCopies.push(copy);
        occupiedTargets.add(targetKey);
        occupiedTargets.add(targetNameKey);
        created++;
    }
    createdCopies.filter(task => task.important).forEach(task => moveTaskToDayIndex(task, 0));
    return created;
}

function dayColorFor(dateKey){
    return data.dayColors?.[dateKey] || 'default';
}

function isPastDateKey(dateKey){
    return dateKey < formatDateKey(new Date());
}

function applyExpandedDayAppearance(element, dateKey, mode = null){
    const resolvedMode = mode || element.closest('.compact-calendar-wrap')?.dataset.monthMode || 'tasks';
    element.dataset.dayColor = dayColorFor(dateKey);
    element.classList.toggle('is-past', resolvedMode === 'tasks' && isPastDateKey(dateKey));
}

async function setDayColor(dateKey, color){
    const nextColor = DAY_COLOR_CYCLE.includes(color) ? color : 'default';
    if(nextColor === 'default') delete data.dayColors[dateKey];
    else data.dayColors[dateKey] = nextColor;
    document.querySelectorAll(`.compact-day[data-date-key="${dateKey}"]`).forEach(day => applyExpandedDayAppearance(day, dateKey));
    if(focusedDateKey === dateKey) applyMobileDayAppearance(dateKey);
    await persistDebounced();
}

function closeDayColorPicker(){
    activeDayColorPicker?.remove();
    activeDayColorAnchor?.setAttribute('aria-expanded', 'false');
    activeDayColorPicker = null;
    activeDayColorAnchor = null;
}

function openDayColorPicker(anchor, dateKey, onApplied){
    if(activeDayColorAnchor === anchor){
        closeDayColorPicker();
        return;
    }
    closeDayColorPicker();
    const picker = document.createElement('div');
    picker.className = 'day-color-picker';
    picker.setAttribute('role', 'menu');
    picker.setAttribute('aria-label', 'Couleur du jour');
    const currentColor = dayColorFor(dateKey);
    DAY_COLOR_CYCLE.forEach(color => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'day-color-option';
        option.dataset.color = color;
        option.classList.toggle('is-selected', color === currentColor);
        option.title = DAY_COLOR_LABELS[color];
        option.setAttribute('aria-label', DAY_COLOR_LABELS[color]);
        option.setAttribute('aria-checked', String(color === currentColor));
        option.setAttribute('role', 'menuitemradio');
        option.onclick = async event => {
            event.stopPropagation();
            await setDayColor(dateKey, color);
            anchor.dataset.dayColor = dayColorFor(dateKey);
            onApplied?.();
            closeDayColorPicker();
        };
        picker.appendChild(option);
    });
    document.body.appendChild(picker);
    activeDayColorPicker = picker;
    activeDayColorAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    const anchorRect = anchor.getBoundingClientRect();
    const pickerRect = picker.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.right - pickerRect.width, window.innerWidth - pickerRect.width - 8));
    const fitsBelow = anchorRect.bottom + pickerRect.height + 8 <= window.innerHeight;
    picker.style.left = `${left}px`;
    picker.style.top = `${fitsBelow ? anchorRect.bottom + 6 : anchorRect.top - pickerRect.height - 6}px`;
    picker.querySelector('.is-selected')?.focus({ preventScroll:true });
}

function bindDayColorPicker(button, getDateKey, onApplied){
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', event => {
        event.stopPropagation();
        const dateKey = typeof getDateKey === 'function' ? getDateKey() : getDateKey;
        if(dateKey) openDayColorPicker(button, dateKey, onApplied);
    });
}

document.addEventListener('pointerdown', event => {
    if(!activeDayColorPicker) return;
    if(activeDayColorPicker.contains(event.target) || activeDayColorAnchor?.contains(event.target)) return;
    closeDayColorPicker();
});
document.addEventListener('keydown', event => {
    if(event.key === 'Escape' && activeDayColorPicker) closeDayColorPicker();
});
window.addEventListener('resize', closeDayColorPicker);
window.addEventListener('scroll', closeDayColorPicker, true);

function taskPosition(task){
    const siblings = tasksForDate(task.date);
    return { siblings, index: siblings.findIndex(candidate => candidate.id === task.id) };
}

function applyDayTaskOrder(dateKey, orderedIds){
    const positions = [];
    const currentTasks = [];
    data.tasks.forEach((task, index) => {
        if(task.date !== dateKey) return;
        positions.push(index);
        currentTasks.push(task);
    });
    const byId = new Map(currentTasks.map(task => [task.id, task]));
    const ordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
    currentTasks.forEach(task => { if(!ordered.includes(task)) ordered.push(task); });
    positions.forEach((position, index) => { data.tasks[position] = ordered[index]; });
}

function moveTaskToDayIndex(task, targetIndex){
    const siblings = tasksForDate(task.date);
    const currentIndex = siblings.findIndex(candidate => candidate.id === task.id);
    if(currentIndex < 0) return false;
    const boundedTarget = Math.max(0, Math.min(targetIndex, siblings.length - 1));
    if(currentIndex === boundedTarget) return false;
    siblings.splice(currentIndex, 1);
    siblings.splice(boundedTarget, 0, task);
    applyDayTaskOrder(task.date, siblings.map(candidate => candidate.id));
    return true;
}

async function moveTaskWithinDay(task, direction){
    const { siblings, index } = taskPosition(task);
    const targetIndex = index + direction;
    if(index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return;
    moveTaskToDayIndex(task, targetIndex);
    rerenderTaskViews(task.date);
    persistDebounced();
}

async function setTaskImportant(task, important){
    if(task.kind === 'separator') return;
    task.important = important;
    if(important) moveTaskToDayIndex(task, 0);
    rerenderTaskViews(task.date);
    persistDebounced();
}

function taskCompletionRate(dateKey){
    const tasks = tasksForDate(dateKey).filter(task => task.kind !== 'separator');
    if(!tasks.length) return 0;
    return tasks.filter(task => task.status === TASK_STATUS.DONE).length / tasks.length;
}

function taskMonthStats(year, month){
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
    const tasks = data.tasks.filter(task => task.kind !== 'separator' && task.date.startsWith(prefix));
    const done = tasks.filter(task => task.status === TASK_STATUS.DONE).length;
    return { total: tasks.length, done, rate: tasks.length ? done / tasks.length : 0 };
}

function compactMonthMeta(year, month){
    const stats = taskMonthStats(year, month);
    if (!stats.total) return 'Aucune tâche';
    return `${stats.done}/${stats.total} terminées · ${Math.round(stats.rate * 100)}%`;
}

function habitMonthStats(year, month){
    const totalDays = new Date(year, month + 1, 0).getDate();
    let total = 0;
    let done = 0;
    for(let day = 1; day <= totalDays; day++){
        const dateKey = formatDateKey(new Date(year, month, day));
        data.habits.filter(habit => isHabitActiveOn(habit, dateKey)).forEach(habit => {
            total++;
            if(isHabitDone(dateKey, habit.name)) done++;
        });
    }
    return { total, done, rate:total ? done / total : 0 };
}

function expandedMonthMeta(year, month, mode){
    if(mode === 'tasks') return compactMonthMeta(year, month);
    const stats = habitMonthStats(year, month);
    if(!stats.total) return 'Aucune habitude active';
    return `${stats.done}/${stats.total} habitudes cochées · ${Math.round(stats.rate * 100)}%`;
}

const taskStatusLabel = {
    [TASK_STATUS.PENDING]: 'À faire',
    [TASK_STATUS.DONE]: 'Fait',
    [TASK_STATUS.LATER]: 'À plus tard',
    [TASK_STATUS.SKIPPED]: 'Non fait'
};

function makeTaskId(){
    if(globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function findTaskNameConflict(name, dateKey, excludedTask = null){
    const normalized = normalizeHabitName(name);
    return data.tasks.find(task => task.kind !== 'separator' && task !== excludedTask && task.date === dateKey && normalizeHabitName(task.name) === normalized) || null;
}

function refreshCompactProgress(dateKey){
    const dayCell = document.querySelector(`.compact-day[data-date-key="${dateKey}"]`);
    if(dayCell){
        const rate = Math.round(taskCompletionRate(dateKey) * 100);
        const rateEl = dayCell.querySelector('.compact-day-rate');
        if(rateEl) rateEl.textContent = `${rate}%`;
    }
    const date = parseDateKey(dateKey);
    const monthCard = document.querySelector(`.compact-month-card[data-year="${date.getFullYear()}"][data-month="${date.getMonth()}"]`);
    const meta = monthCard?.querySelector('.compact-month-meta');
    if(meta) meta.textContent = compactMonthMeta(date.getFullYear(), date.getMonth());
}

function setTaskButtonContent(button, task){
    button.replaceChildren();
    if(task.important){
        const flag = document.createElement('span');
        flag.className = 'task-important-mark';
        flag.setAttribute('aria-hidden', 'true');
        flag.textContent = '⚑';
        button.appendChild(flag);
    }
    if(task.rolloverFromId){
        const rollover = document.createElement('span');
        rollover.className = 'task-rollover-mark';
        rollover.setAttribute('aria-hidden', 'true');
        rollover.textContent = '↪';
        button.appendChild(rollover);
    }
    const name = document.createElement('span');
    name.className = 'task-name';
    name.textContent = task.name;
    button.appendChild(name);
}

function suppressTaskClick(row){
    row.dataset.suppressClick = 'true';
}

function releaseTaskClickSuppression(row){
    window.setTimeout(() => { delete row.dataset.suppressClick; }, 120);
}

async function deleteTaskDirect(task){
    const taskDate = task.date;
    rememberTaskRolloverSkip(task);
    data.tasks = data.tasks.filter(candidate => candidate.id !== task.id);
    rerenderTaskViews(taskDate);
    persistDebounced();
    showToast(task.kind === 'separator' ? 'Séparation supprimée.' : 'Tâche supprimée.');
}

function reorderRowAtPointer(row, container, rowSelector, clientY){
    const candidates = Array.from(container.querySelectorAll(rowSelector)).filter(candidate => candidate !== row);
    const before = candidates.find(candidate => {
        const rect = candidate.getBoundingClientRect();
        return clientY < rect.top + rect.height / 2;
    });
    if(before) container.insertBefore(row, before);
    else container.insertBefore(row, container.querySelector('.mobile-task-gesture-hint, .mobile-add-task-button'));
}

function persistRenderedTaskOrder(container, rowSelector, dateKey){
    const orderedIds = Array.from(container.querySelectorAll(rowSelector)).map(row => row.dataset.taskId).filter(Boolean);
    applyDayTaskOrder(dateKey, orderedIds);
    persistDebounced(0);
}

function bindTaskPointerGestures({ row, activationElement, swipeSurface, revealElement, task, rowSelector, holdDelay = 320, enableDrag = true, enableSwipe = true, dragOnMove = false }){
    let pointerState = null;
    let holdTimer = null;
    const surface = swipeSurface || activationElement;
    const reveal = revealElement || row;
    let detachWindowListeners = () => {};
    const preventTouchScrollWhileDragging = event => {
        if(pointerState?.dragging) event.preventDefault();
    };
    const resetSwipe = () => {
        surface.style.transform = '';
        surface.style.opacity = '';
        row.classList.remove('is-swiping');
        row.classList.remove('is-swipe-ready');
        delete reveal.dataset.swipeDirection;
        delete reveal.dataset.swipeSide;
        delete reveal.dataset.swipeVariant;
        delete reveal.dataset.swipeReady;
    };
    const finishDrag = () => {
        if(!pointerState?.dragging) return;
        row.classList.remove('is-dragging');
        activationElement.style.touchAction = '';
        persistRenderedTaskOrder(row.parentElement, rowSelector, task.date);
    };
    const clearGesture = () => {
        clearTimeout(holdTimer);
        holdTimer = null;
        detachWindowListeners();
        detachWindowListeners = () => {};
        activationElement.removeEventListener('touchmove', preventTouchScrollWhileDragging);
        activationElement.style.touchAction = '';
        pointerState = null;
    };
    const startDrag = () => {
        if(!pointerState || pointerState.dragging || pointerState.swiping) return;
        pointerState.dragging = true;
        suppressTaskClick(row);
        resetSwipe();
        activationElement.style.touchAction = 'none';
        activationElement.addEventListener('touchmove', preventTouchScrollWhileDragging, { passive:false });
        row.classList.add('is-dragging');
        if(navigator.vibrate) navigator.vibrate(12);
    };

    const updateSwipeFeedback = deltaX => {
        const side = deltaX > 0 ? 'right' : 'left';
        const action = task.kind === 'separator' || side === 'right' ? 'delete' : 'flag';
        const distance = Math.abs(deltaX);
        const revealed = distance >= pointerState.revealThreshold;
        const ready = distance >= pointerState.activationThreshold;
        const wasReady = pointerState.thresholdReady;
        pointerState.thresholdReady = ready;
        pointerState.action = action;
        surface.style.transform = `translate3d(${deltaX}px, 0, 0)`;
        row.classList.add('is-swiping');
        row.classList.toggle('is-swipe-ready', ready);
        if(!revealed){
            delete reveal.dataset.swipeDirection;
            delete reveal.dataset.swipeSide;
            delete reveal.dataset.swipeVariant;
            delete reveal.dataset.swipeReady;
            if(ready !== wasReady && navigator.vibrate) navigator.vibrate(4);
            return;
        }
        reveal.dataset.swipeDirection = action;
        reveal.dataset.swipeSide = side;
        reveal.dataset.swipeVariant = action === 'flag' && task.important ? 'unflag' : action;
        reveal.dataset.swipeReady = String(ready);
        if(ready !== wasReady && navigator.vibrate) navigator.vibrate(ready ? 10 : 4);
    };

    const animateSwipeDelete = async deltaX => {
        const direction = deltaX < 0 ? -1 : 1;
        const exitDistance = Math.max(window.innerWidth, reveal.getBoundingClientRect().width * 1.35);
        surface.style.transform = `translate3d(${direction * exitDistance}px, 0, 0)`;
        surface.style.opacity = '0';
        row.classList.add('is-swipe-committing');
        await new Promise(resolve => window.setTimeout(resolve, 150));
        await deleteTaskDirect(task);
    };

    const onPointerMove = event => {
        if(!pointerState || pointerState.id !== event.pointerId) return;
        pointerState.lastX = event.clientX;
        pointerState.lastY = event.clientY;
        const deltaX = event.clientX - pointerState.startX;
        const deltaY = event.clientY - pointerState.startY;
        const verticalIntent = Math.abs(deltaY) > Math.abs(deltaX);
        if(!pointerState.dragging && dragOnMove && verticalIntent && Math.abs(deltaY) >= 5) startDrag();
        if(pointerState.dragging){
            event.preventDefault();
            reorderRowAtPointer(row, row.parentElement, rowSelector, event.clientY);
            return;
        }
        const movementSlop = pointerState.pointerType === 'mouse' ? 9 : 18;
        if(Math.abs(deltaY) > movementSlop && verticalIntent){
            clearTimeout(holdTimer);
            holdTimer = null;
            return;
        }
        if(enableSwipe && Math.abs(deltaX) > 8 && Math.abs(deltaX) > Math.abs(deltaY) * 1.15){
            clearTimeout(holdTimer);
            holdTimer = null;
            pointerState.swiping = true;
            suppressTaskClick(row);
            updateSwipeFeedback(deltaX);
            event.preventDefault();
        }
    };

    const onPointerUp = async event => {
        if(!pointerState || pointerState.id !== event.pointerId) return;
        clearTimeout(holdTimer);
        const deltaX = event.clientX - pointerState.startX;
        if(pointerState.dragging){
            finishDrag();
            releaseTaskClickSuppression(row);
            clearGesture();
            return;
        }
        if(pointerState.swiping){
            const action = pointerState.action;
            const thresholdReached = Math.abs(deltaX) >= pointerState.activationThreshold;
            if(thresholdReached && action === 'delete'){
                clearGesture();
                await animateSwipeDelete(deltaX);
                return;
            }
            if(thresholdReached && action === 'flag' && task.kind !== 'separator'){
                const nextImportant = !task.important;
                clearGesture();
                await setTaskImportant(task, nextImportant);
                showToast(nextImportant ? 'Tâche marquée comme importante.' : 'Flag important retiré.');
                return;
            }
            resetSwipe();
            releaseTaskClickSuppression(row);
        }
        clearGesture();
    };

    const onPointerCancel = () => {
        finishDrag();
        resetSwipe();
        releaseTaskClickSuppression(row);
        clearGesture();
    };

    activationElement.addEventListener('pointerdown', event => {
        if(event.pointerType === 'mouse' && event.button !== 0) return;
        if(pointerState) onPointerCancel();
        const surfaceWidth = Math.max(1, reveal.getBoundingClientRect().width);
        pointerState = {
            id:event.pointerId,
            pointerType:event.pointerType,
            startX:event.clientX,
            startY:event.clientY,
            lastX:event.clientX,
            lastY:event.clientY,
            dragging:false,
            swiping:false,
            action:null,
            thresholdReady:false,
            revealThreshold:Math.min(38, Math.max(26, surfaceWidth * .09)),
            activationThreshold:Math.min(96, Math.max(68, surfaceWidth * .25))
        };
        try { activationElement.setPointerCapture(event.pointerId); } catch(error){}
        window.addEventListener('pointermove', onPointerMove, { capture:true, passive:false });
        window.addEventListener('pointerup', onPointerUp, { capture:true });
        window.addEventListener('pointercancel', onPointerCancel, { capture:true });
        detachWindowListeners = () => {
            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('pointerup', onPointerUp, true);
            window.removeEventListener('pointercancel', onPointerCancel, true);
        };
        if(enableDrag){
            holdTimer = window.setTimeout(startDrag, holdDelay);
        }
    });
}

function makeTaskDragHandle(task, row, rowSelector){
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'task-drag-handle';
    handle.textContent = '☰';
    handle.setAttribute('aria-label', task.kind === 'separator' ? 'Déplacer la séparation' : `Déplacer ${task.name}`);
    handle.title = 'Maintenir puis glisser';
    handle.addEventListener('keydown', event => {
        if(event.key === 'ArrowUp' || event.key === 'ArrowDown'){
            event.preventDefault();
            moveTaskWithinDay(task, event.key === 'ArrowUp' ? -1 : 1);
        }
        if(event.key === 'Delete' && task.kind === 'separator') deleteTaskDirect(task);
    });
    bindTaskPointerGestures({ row, activationElement:handle, task, rowSelector, holdDelay:150, enableSwipe:false, dragOnMove:true });
    return handle;
}

function bindTaskKeyboardShortcuts(button, task){
    button.addEventListener('keydown', event => {
        if(event.key === 'Delete'){
            event.preventDefault();
            deleteTaskDirect(task);
        } else if(event.key.toLowerCase() === 'f' && task.kind !== 'separator'){
            event.preventDefault();
            setTaskImportant(task, !task.important);
        } else if(event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')){
            event.preventDefault();
            moveTaskWithinDay(task, event.key === 'ArrowUp' ? -1 : 1);
        }
    });
}

function makeCompactSeparatorRow(task){
    const row = document.createElement('div');
    row.className = 'compact-task-row task-separator-row';
    row.dataset.taskId = task.id;
    const handle = makeTaskDragHandle(task, row, '.compact-task-row');
    const swipeShell = document.createElement('div');
    swipeShell.className = 'task-swipe-shell task-separator-swipe-shell';
    const separator = document.createElement('button');
    separator.type = 'button';
    separator.className = 'compact-task-separator task-separator-line';
    separator.setAttribute('aria-label', 'Séparation. Glisser à gauche ou à droite pour supprimer.');
    separator.innerHTML = '<span></span><span></span>';
    bindTaskKeyboardShortcuts(separator, task);
    bindTaskPointerGestures({ row, activationElement:separator, swipeSurface:separator, revealElement:swipeShell, task, rowSelector:'.compact-task-row', enableDrag:false, enableSwipe:true });
    swipeShell.append(separator);
    row.append(handle, swipeShell);
    return row;
}

function makeCompactTaskRow(task){
    if(task.kind === 'separator') return makeCompactSeparatorRow(task);
    const row = document.createElement('div');
    row.className = 'compact-task-row';
    row.dataset.taskId = task.id;
    row.classList.toggle('is-important', task.important);

    const handle = makeTaskDragHandle(task, row, '.compact-task-row');
    const swipeShell = document.createElement('div');
    swipeShell.className = 'task-swipe-shell';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'compact-task';
    setTaskButtonContent(button, task);
    const syncState = () => {
        task.status = normalizeTaskStatus(task.status);
        button.dataset.status = task.status;
        button.title = `${task.name} — ${taskStatusLabel[task.status]}. Cliquer pour changer.`;
        button.setAttribute('aria-label', `${task.name}, ${taskStatusLabel[task.status]}. Cliquer pour passer au statut suivant.`);
    };
    syncState();
    button.onclick = async event => {
        if(row.dataset.suppressClick === 'true'){
            event.preventDefault();
            return;
        }
        const currentIndex = TASK_STATUS_CYCLE.indexOf(task.status);
        task.status = TASK_STATUS_CYCLE[(currentIndex + 1) % TASK_STATUS_CYCLE.length];
        syncState();
        refreshCompactProgress(task.date);
        const carried = rollForwardLaterTasks();
        if(carried) rerenderTaskViews(task.date, { month:true });
        persistDebounced();
    };
    bindTaskKeyboardShortcuts(button, task);
    bindTaskPointerGestures({ row, activationElement:button, swipeSurface:button, revealElement:swipeShell, task, rowSelector:'.compact-task-row', enableDrag:false, enableSwipe:true });
    swipeShell.appendChild(button);
    row.append(handle, swipeShell);
    return row;
}

async function addCompactTask(dateKey){
    const dateLabel = parseDateKey(dateKey).toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' });
    const rawTasks = await requestTextInput({
        title: 'Ajouter des tâches',
        description: `${dateLabel} · une ligne = une tâche, une ligne vide = une séparation.`,
        placeholder: 'Acheter les courses\nAppeler le garage\n\nPréparer la réunion',
        confirmLabel: 'Ajouter la liste',
        multiline: true
    });
    if(rawTasks === null) return;
    const normalizedText = rawTasks.replace(/\r\n?/g, '\n');
    const lines = normalizedText.split('\n');
    if(lines.length > 1 && normalizedText.endsWith('\n')) lines.pop();
    let addedTasks = 0;
    let addedSeparators = 0;
    let skippedDuplicates = 0;
    lines.forEach(line => {
        const name = line.trim().replace(/[ \t]+/g, ' ');
        if(!name){
            data.tasks.push({ id: makeTaskId(), name: '', date: dateKey, kind: 'separator', status: TASK_STATUS.PENDING, important: false, groupBreakBefore: false, rolloverFromId: null, rolloverRootId: null });
            addedSeparators++;
            return;
        }
        if(findTaskNameConflict(name, dateKey)){
            skippedDuplicates++;
            return;
        }
        data.tasks.push({ id: makeTaskId(), name, date: dateKey, kind: 'task', status: TASK_STATUS.PENDING, important: false, groupBreakBefore: false, rolloverFromId: null, rolloverRootId: null });
        addedTasks++;
    });
    if(!addedTasks && !addedSeparators){
        showToast('Toutes ces tâches existent déjà pour cette journée.', 'error');
        return;
    }
    rerenderTaskViews(dateKey);
    persistDebounced();
    const summary = [
        addedTasks ? `${addedTasks} tâche${addedTasks > 1 ? 's' : ''}` : '',
        addedSeparators ? `${addedSeparators} séparation${addedSeparators > 1 ? 's' : ''}` : ''
    ].filter(Boolean).join(' et ');
    showToast(`${summary} ajoutée${addedTasks + addedSeparators > 1 ? 's' : ''}.${skippedDuplicates ? ` ${skippedDuplicates} doublon${skippedDuplicates > 1 ? 's' : ''} ignoré${skippedDuplicates > 1 ? 's' : ''}.` : ''}`);
}

function rerenderTaskViews(dateKey, { month = false } = {}){
    if(!dayPage.classList.contains('hidden') && mobileDayMode === 'tasks'){
        if((focusedDateKey || dateKey) === dateKey) populateMobileTasks(dateKey, dayHabitsList);
        return;
    }
    const date = parseDateKey(dateKey);
    const year = date.getFullYear();
    const monthIndex = date.getMonth();
    if(expandedMonthKey !== `${year}-${monthIndex}` || expandedMonthMode !== 'tasks') return;
    const card = expandedMonthCard(year, monthIndex);
    if(!card) return;
    if(month){
        const previousWrap = card.querySelector('.compact-calendar-wrap');
        const scrollLeft = previousWrap?.scrollLeft || 0;
        const replacement = makeCompactCalendarWrap(year, monthIndex, 'tasks');
        previousWrap?.replaceWith(replacement);
        replacement.scrollLeft = scrollLeft;
    } else {
        const currentDay = card.querySelector(`.compact-day[data-date-key="${dateKey}"]`);
        currentDay?.replaceWith(makeCompactTaskDay(date));
    }
    const meta = card.querySelector('.compact-month-meta');
    if(meta) meta.textContent = compactMonthMeta(year, monthIndex);
}

function decorateExpandedMonthDay(day, dateKey, mode){
    applyExpandedDayAppearance(day, dateKey, mode);
    if(dateKey === formatDateKey(new Date())) day.classList.add('is-today');
    if(dateKey === expandedMonthFocusDateKey){
        day.classList.add('is-focused-day');
        day.tabIndex = -1;
    }
}

function makeCompactDayHead(date, dateKey, completionRate){
    const head = document.createElement('div');
    head.className = 'compact-day-head';
    const number = document.createElement('span');
    number.className = 'compact-day-number';
    number.textContent = date.getDate();
    const rate = document.createElement('span');
    rate.className = 'compact-day-rate';
    rate.textContent = `${Math.round(completionRate * 100)}%`;
    const headTools = document.createElement('div');
    headTools.className = 'compact-day-head-tools';
    const color = document.createElement('button');
    color.type = 'button';
    color.className = 'compact-day-color';
    color.textContent = '●';
    color.dataset.dayColor = dayColorFor(dateKey);
    color.title = `Changer la couleur du ${date.toLocaleDateString('fr-FR')}`;
    color.setAttribute('aria-label', color.title);
    bindDayColorPicker(color, dateKey, () => { color.dataset.dayColor = dayColorFor(dateKey); });
    headTools.append(rate, color);
    head.append(number, headTools);
    return head;
}

function makeCompactTaskDay(date){
    const dateKey = formatDateKey(date);
    const day = document.createElement('div');
    day.className = 'compact-day';
    day.dataset.dateKey = dateKey;
    decorateExpandedMonthDay(day, dateKey, 'tasks');
    day.setAttribute('aria-label', `${date.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' })}, tâches`);

    const list = document.createElement('div');
    list.className = 'compact-task-list';
    tasksForDate(dateKey).forEach(task => list.appendChild(makeCompactTaskRow(task)));

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'compact-add-task';
    add.textContent = '+ Tâche';
    add.setAttribute('aria-label', `Ajouter une tâche le ${date.toLocaleDateString('fr-FR')}`);
    add.onclick = () => addCompactTask(dateKey);

    day.append(makeCompactDayHead(date, dateKey, taskCompletionRate(dateKey)), list, add);
    return day;
}

function refreshExpandedHabitDay(dateKey){
    if(expandedMonthMode !== 'habits') return;
    const current = document.querySelector(`.compact-day[data-date-key="${dateKey}"]`);
    if(current) current.replaceWith(makeCompactHabitDay(parseDateKey(dateKey)));
    const date = parseDateKey(dateKey);
    const card = expandedMonthCard(date.getFullYear(), date.getMonth());
    const meta = card?.querySelector('.compact-month-meta');
    if(meta) meta.textContent = expandedMonthMeta(date.getFullYear(), date.getMonth(), 'habits');
}

function makeCompactHabitDay(date){
    const dateKey = formatDateKey(date);
    const day = document.createElement('div');
    day.className = 'compact-day compact-habit-day';
    day.dataset.dateKey = dateKey;
    decorateExpandedMonthDay(day, dateKey, 'habits');
    day.setAttribute('aria-label', `${date.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' })}, habitudes`);

    const list = document.createElement('div');
    list.className = 'compact-habit-list';
    const activeHabits = data.habits.filter(habit => isHabitActiveOn(habit, dateKey));
    if(!activeHabits.length){
        const empty = document.createElement('div');
        empty.className = 'compact-habit-empty';
        empty.textContent = 'Repos';
        list.appendChild(empty);
    } else {
        activeHabits.forEach(habit => list.appendChild(makeHabitToggleButton(
            habit,
            dateKey,
            () => refreshExpandedHabitDay(dateKey),
            { isCompactMonth:true }
        )));
    }

    day.append(makeCompactDayHead(date, dateKey, getCompletionRate(dateKey)), list);
    return day;
}

function makeCompactCalendarWrap(year, month, mode = 'tasks'){
    const wrap = document.createElement('div');
    wrap.className = 'compact-calendar-wrap';
    wrap.dataset.monthMode = mode;
    const calendar = document.createElement('div');
    calendar.className = 'compact-calendar';
    ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'].forEach(dayName => {
        const weekday = document.createElement('div');
        weekday.className = 'compact-weekday';
        weekday.textContent = dayName;
        calendar.appendChild(weekday);
    });
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    for(let i = 0; i < offset; i++){
        const outside = document.createElement('div');
        outside.className = 'compact-day is-outside';
        outside.setAttribute('aria-hidden', 'true');
        calendar.appendChild(outside);
    }
    const total = new Date(year, month + 1, 0).getDate();
    for(let day = 1; day <= total; day++){
        const date = new Date(year, month, day);
        calendar.appendChild(mode === 'habits' ? makeCompactHabitDay(date) : makeCompactTaskDay(date));
    }
    wrap.appendChild(calendar);
    return wrap;
}

function applyDayCellStyle(btn, dk){
    const actives = data.habits.filter(h=>isHabitActiveOn(h,dk));
    const allGold = actives.length>0 && actives.every(h=>{ const cur=computeStreakForHabit(h.name, dk); const best=Math.max(h.bestStreak||0, computeBestStreakCached(h.name)); return isHabitDone(dk, h.name) && cur>=best; });
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

function renderYears(){
    syncPrimaryActionButton();
    yearsContainer.innerHTML='';
    yearsContainer.classList.add('space-y-10');
    for(let y=minYear;y<=maxYear;y++) ensureYearRendered(y);
}

const focusCurrentMonth = ()=>{
    const yEl=document.getElementById('year-'+currentYear);
    if(!yEl) return;
    const monthBtn=yEl.querySelector(`button.month-name-button[data-year="${currentYear}"][data-month="${currentMonth}"]`);
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
panelDate.textContent = parseDateKey(dateKey).toLocaleDateString(
'fr-FR',
{ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
);
panelDateLong.textContent = dateKey;

// Remplir la liste des habitudes du jour
populateHabits(dateKey, habitsList, false);

// Rendre visibles immédiatement le panel et l'overlay
dayPanel.classList.remove('hidden');
dayOverlay.classList.remove('hidden');
dayPanel.setAttribute('aria-hidden', 'false');

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
dayPanel.setAttribute('aria-hidden', 'true');

// Lancer le slide-out
dayPanel.style.transform = 'translateX(calc(100% + 1rem))';
dayOverlay.classList.add('hidden');

// Quand la transition est finie, on HIDE vraiment
let finished = false;
const onEnd = () => {
if(finished) return;
finished = true;
dayPanel.removeEventListener('transitionend', onEnd);

// si entre-temps l'utilisateur l'a rouvert (tap rapide),
// on NE recache PAS
if (!dayIsOpen) {
    dayPanel.classList.add('hidden');
    dayPanel.style.visibility = 'hidden';
}
};

dayPanel.addEventListener('transitionend', onEnd, { once: true });
window.setTimeout(onEnd, 360);
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

let persistTimer = null;
let persistResolvers = [];
let lastLocalWriteRevision = -1;
const persistDebounced = (delay = 450) => new Promise(resolve => {
    persistResolvers.push(resolve);
    clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
        try {
            data._rev = (data._rev || 0) + 1;
            lastLocalWriteRevision = data._rev;
            if(docRef) await setDoc(docRef, data);
        } catch(error){
            console.error('persist error', error);
            showToast('Synchronisation impossible. Les changements seront retentés à la prochaine action.', 'error');
        } finally {
            const pendingResolvers = persistResolvers;
            persistResolvers = [];
            pendingResolvers.forEach(done => done());
        }
    }, delay);
});

let taskRolloverTimer = null;

async function processTaskRollovers(){
    const created = rollForwardLaterTasks();
    if(!created) return 0;
    if(focusedDateKey && !dayPage.classList.contains('hidden') && mobileDayMode === 'tasks'){
        populateMobileTasks(focusedDateKey, dayHabitsList);
    } else if(expandedMonthKey && expandedMonthMode === 'tasks'){
        const [year, month] = expandedMonthKey.split('-').map(Number);
        rerenderTaskViews(formatDateKey(new Date(year, month, 1)), { month:true });
    }
    persistDebounced();
    return created;
}

function scheduleTaskRollover(){
    clearTimeout(taskRolloverTimer);
    const nowDate = new Date();
    const nextMidnight = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1, 0, 0, 2);
    taskRolloverTimer = window.setTimeout(async () => {
        await processTaskRollovers();
        scheduleTaskRollover();
    }, Math.max(1000, nextMidnight.getTime() - nowDate.getTime()));
}

document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible') processTaskRollovers();
});

function makeHabitToggleButton(h, dateKey, onChanged, opts = {}) {
    const { isDayView = false, isCompactMonth = false } = opts;
    const done = isHabitDone(dateKey, h.name);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', done ? 'true' : 'false');
    if(isCompactMonth){
        btn.className = 'compact-habit';
        btn.dataset.status = done ? HABIT_STATUS.DONE : HABIT_STATUS.PENDING;
        const name = document.createElement('span');
        name.className = 'compact-habit-name';
        name.textContent = h.name;
        const current = computeStreakForHabit(h.name, dateKey);
        const best = Math.max(h.bestStreak || 0, computeBestStreakCached(h.name));
        const streak = document.createElement('span');
        streak.className = 'compact-habit-streak';
        streak.textContent = `${clamp3(current)}/${clamp3(best)}`;
        streak.title = 'Série actuelle / meilleur record';
        btn.append(name, streak);
    } else {
        const width = isDayView ? ['w-4/5'] : ['w-auto'];
        const textSize = isDayView ? 'text-xl' : 'text-xs';
        btn.className = [ ...width,'px-4','py-3','rounded-full','border','transition', textSize,'font-semibold', done ? 'bg-[rgb(0,200,75)] border-green-400/40 ring-1 ring-green-300/30 text-black' : 'bg-white/5 border-white/10 hover:bg-white/10 text-white' ].join(' ');
        btn.textContent = h.name;
    }
    btn.setAttribute('aria-label', `${h.name}, ${done ? 'faite' : 'à faire'}. Appuyer pour ${done ? 'décocher' : 'cocher'}.`);
    btn.onclick = async () => {
    setHabitStatus(dateKey, h.name, done ? HABIT_STATUS.PENDING : HABIT_STATUS.DONE);
    const d = parseDateKey(dateKey);
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
        const edit=document.createElement('button');
        edit.className='text-xs px-2 py-1 rounded hover:bg-white/5';
        edit.textContent='✏️';
        edit.setAttribute('aria-label', `Renommer ${h.name}`);
        edit.onclick=async()=>{
            const proposed=await requestTextInput({
                title: 'Renommer l’habitude',
                description: 'Le nom doit rester unique parmi tes habitudes.',
                value: h.name,
                placeholder: 'Nom de l’habitude',
                confirmLabel: 'Enregistrer'
            });
            if(proposed === null) return;
            const newName=proposed.trim().replace(/\s+/g, ' ');
            if(!newName || newName===h.name) return;
            if(findHabitNameConflict(newName, h)){
                showToast('Ce nom est déjà utilisé.', 'error');
                return;
            }
            const oldName=h.name;
            h.name=newName;
            for(const k in data.completions){
                if(data.completions[k] && Object.prototype.hasOwnProperty.call(data.completions[k], oldName)){
                    data.completions[k][h.name]=data.completions[k][oldName];
                    delete data.completions[k][oldName];
                }
            }
            clearHabitCaches(oldName);
            clearHabitCaches(h.name);
            await persistDebounced(0);
            rerenderSelf();
            renderYears();
        };
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

function makeMobileSeparatorRow(task){
    const row = document.createElement('div');
    row.className = 'mobile-task-row task-separator-row w-full flex flex-col items-center';
    row.dataset.taskId = task.id;
    const main = document.createElement('div');
    main.className = 'mobile-task-main task-separator-main';
    const separator = document.createElement('button');
    separator.type = 'button';
    separator.className = 'mobile-task-separator';
    separator.setAttribute('aria-label', 'Séparation. Maintenir pour déplacer, glisser à gauche ou à droite pour supprimer.');
    separator.innerHTML = '<span></span><span></span>';
    main.append(separator);
    row.append(main);
    bindTaskKeyboardShortcuts(separator, task);
    bindTaskPointerGestures({ row, activationElement:separator, swipeSurface:separator, revealElement:main, task, rowSelector:'.mobile-task-row', holdDelay:320, enableDrag:true, enableSwipe:true });
    return row;
}

function makeMobileTaskRow(task){
    if(task.kind === 'separator') return makeMobileSeparatorRow(task);
    const row = document.createElement('div');
    row.className = 'mobile-task-row w-full flex flex-col items-center';
    row.dataset.taskId = task.id;
    row.classList.toggle('is-important', task.important);

    const main = document.createElement('div');
    main.className = 'mobile-task-main';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mobile-task-button w-4/5 px-4 py-3 rounded-full border transition text-xl font-semibold bg-white/5 border-white/10 hover:bg-white/10 text-white';
    button.classList.toggle('is-important', task.important);
    setTaskButtonContent(button, task);
    const syncState = () => {
        task.status = normalizeTaskStatus(task.status);
        button.dataset.status = task.status;
        button.setAttribute('aria-label', `${task.name}, ${taskStatusLabel[task.status]}. Appuyer pour changer. Maintenir pour déplacer.`);
        button.setAttribute('aria-pressed', String(task.status === TASK_STATUS.DONE));
    };
    syncState();
    button.onclick = async event => {
        if(row.dataset.suppressClick === 'true'){
            event.preventDefault();
            return;
        }
        const currentIndex = TASK_STATUS_CYCLE.indexOf(task.status);
        task.status = TASK_STATUS_CYCLE[(currentIndex + 1) % TASK_STATUS_CYCLE.length];
        syncState();
        const carried = rollForwardLaterTasks();
        if(carried) rerenderTaskViews(task.date, { month:true });
        persistDebounced();
    };
    bindTaskKeyboardShortcuts(button, task);
    main.append(button);
    row.append(main);
    bindTaskPointerGestures({ row, activationElement:button, swipeSurface:button, revealElement:main, task, rowSelector:'.mobile-task-row', holdDelay:320, enableDrag:true, enableSwipe:true });
    return row;
}

function populateMobileTasks(dateKey, container){
    container.innerHTML = '';
    const tasks = tasksForDate(dateKey);
    if(!tasks.length){
        const empty = document.createElement('div');
        empty.className = 'text-sm text-white/60 mobile-task-empty';
        empty.textContent = 'Aucune tâche prévue.';
        container.appendChild(empty);
    }
    tasks.forEach(task => container.appendChild(makeMobileTaskRow(task)));
    const hint = document.createElement('div');
    hint.className = 'mobile-task-gesture-hint';
    hint.textContent = 'Maintenir pour déplacer · ← flag / unflag · → supprimer';
    container.appendChild(hint);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mobile-add-task-button w-4/5 px-4 py-3 rounded-full border transition text-xl font-semibold bg-white/5 border-white/10 hover:bg-white/10 text-white';
    add.textContent = '+ Task';
    add.setAttribute('aria-label', `Ajouter une tâche le ${parseDateKey(dateKey).toLocaleDateString('fr-FR')}`);
    add.onclick = () => addCompactTask(dateKey);
    container.appendChild(add);
}

function syncMobileDayMode(){
    const tasksMode=mobileDayMode === 'tasks';
    dayPage.dataset.contentMode = mobileDayMode;
    mobileHabitsMode?.setAttribute('aria-pressed', String(!tasksMode));
    mobileTasksMode?.setAttribute('aria-pressed', String(tasksMode));
    syncPrimaryActionButton();
}

function setMobileDayMode(mode){
    mobileDayMode=mode === 'tasks' ? 'tasks' : 'habits';
    localStorage.setItem('hbtrk-mobile-day-mode', mobileDayMode);
    syncMobileDayMode();
    if(focusedDateKey) showDayPage(focusedDateKey);
}

function syncPrimaryActionButton(){
    addHabitBtn.classList.remove('hidden');
    addHabitBtn.textContent = '+ Habitude';
    addHabitBtn.setAttribute('aria-label', 'Ajouter une habitude');
}

mobileHabitsMode?.addEventListener('click', ()=>setMobileDayMode('habits'));
mobileTasksMode?.addEventListener('click', ()=>setMobileDayMode('tasks'));

function applyMobileDayAppearance(dateKey){
    if(!dayPage) return;
    const color = dayColorFor(dateKey);
    dayPage.dataset.dayColor = color;
    dayPage.classList.toggle('is-past-day', isPastDateKey(dateKey));
    if(mobileDayColor){
        mobileDayColor.dataset.dayColor = color;
        mobileDayColor.title = `Changer la couleur du ${parseDateKey(dateKey).toLocaleDateString('fr-FR')}`;
        mobileDayColor.setAttribute('aria-label', mobileDayColor.title);
    }
}

if(mobileDayColor){
    bindDayColorPicker(mobileDayColor, () => focusedDateKey, () => {
        if(focusedDateKey) applyMobileDayAppearance(focusedDateKey);
    });
}

function showDayPage(dateKey){
    if(!isValidDateKey(dateKey)) dateKey = formatDateKey(new Date());
    homePage.classList.add('hidden'); dayPage.classList.remove('hidden');
    const d=parseDateKey(dateKey);
    const month = d.toLocaleDateString('fr-FR', { month: 'long'});
    const rest = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric' });
    dayTitle.innerHTML = `${month}<br>${rest}`;
    dayTitleSub.textContent=dateKey;
    dayHabitsList.className='w-full max-w-2xl mx-auto mb-4 space-y-3 flex flex-col items-center';
    focusedDateKey=dateKey;
    applyMobileDayAppearance(dateKey);
    syncMobileDayMode();
    if(mobileDayMode === 'tasks') populateMobileTasks(dateKey, dayHabitsList);
    else populateHabits(dateKey, dayHabitsList, true);
    document.getElementById('prevDay').onclick=()=>{ const p=new Date(d); p.setDate(p.getDate()-1); showDayPage(formatDateKey(p)); };
    document.getElementById('nextDay').onclick=()=>{ const n=new Date(d); n.setDate(n.getDate()+1); showDayPage(formatDateKey(n)); };
    document.getElementById('todayBtn').onclick=()=>{ const t=new Date(); showDayPage(formatDateKey(t)); };
    updateRouteHash(`#/day/${dateKey}`);
}

function syncOrientationButton(){
    if(viewportIsSmall() || mobileLandscapeLocked){
        appTitle.setAttribute('aria-pressed', String(mobileLandscapeLocked));
        appTitle.title=mobileLandscapeLocked ? 'Déverrouiller la rotation' : 'Passer en paysage';
    } else {
        appTitle.removeAttribute('aria-pressed');
        appTitle.title='Ouvrir le jour courant';
    }
    document.documentElement.classList.toggle('mobile-landscape-lock', mobileLandscapeLocked);
}

async function toggleMobileLandscape(){
    if(mobileLandscapeLocked){
        try {
            if(screen.orientation?.lock) await screen.orientation.lock('portrait');
        } catch(error){
            console.warn('portrait restore unavailable', error);
        }
        try { screen.orientation?.unlock?.(); } catch(error){ console.warn('orientation unlock unavailable', error); }
        if(landscapeFullscreenOwned && document.fullscreenElement){
            try { await document.exitFullscreen(); } catch(error){ console.warn('fullscreen exit unavailable', error); }
        }
        mobileLandscapeLocked=false;
        landscapeFullscreenOwned=false;
        syncOrientationButton();
        router();
        return;
    }

    mobileLandscapeLocked=true;
    syncOrientationButton();
    try {
        if(!screen.orientation?.lock) throw new Error('Orientation lock unsupported');
        try {
            await screen.orientation.lock('landscape');
        } catch(firstError){
            if(!document.fullscreenElement && document.documentElement.requestFullscreen){
                await document.documentElement.requestFullscreen({ navigationUI:'hide' });
                landscapeFullscreenOwned=true;
                await screen.orientation.lock('landscape');
            } else {
                throw firstError;
            }
        }
        router();
    } catch(error){
        mobileLandscapeLocked=false;
        if(landscapeFullscreenOwned && document.fullscreenElement){
            try { await document.exitFullscreen(); } catch(exitError){}
        }
        landscapeFullscreenOwned=false;
        syncOrientationButton();
        showToast("Le verrouillage paysage n’est pas disponible dans ce navigateur.", 'error');
    }
}

syncOrientationButton();
appTitle.onclick = async ()=>{
    if(viewportIsSmall() || mobileLandscapeLocked){
        await toggleMobileLandscape();
        return;
    }
    const hash=window.location.hash||'';
    if(hash.startsWith('#/day')) goHome();
    else showDayPage(focusedDateKey || formatDateKey(new Date()));
};

function openMonthModal(year, month){
    monthSummary.innerHTML='';
    monthModal.classList.remove('hidden');
    monthModal.classList.add('flex');
    monthModalTitle.textContent = `${monthNameLong(month)} ${year}`;
    requestAnimationFrame(()=>document.getElementById('closeMonth')?.focus({ preventScroll:true }));

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

    if(presentHabits.length === 0){
        const empty = document.createElement('div');
        empty.className = 'rounded-lg border border-white/10 bg-white/5 p-6 text-center text-sm text-white/50';
        empty.textContent = 'Aucune habitude planifiée pour ce mois.';
        monthSummary.appendChild(empty);
        return;
    }

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
    row.className='flex flex-wrap items-center justify-between gap-2 bg-white/5 rounded-lg px-3 py-2';
    const habitName = document.createElement('div');
    habitName.className = 'font-medium';
    habitName.textContent = h.name;
    const chips = document.createElement('div');
    chips.className = 'flex flex-wrap items-center gap-2 text-xs';
    const createChip = (className, text) => {
        const chip = document.createElement('span');
        chip.className = `chip ${className}`;
        chip.textContent = text;
        return chip;
    };
    chips.append(
        createChip(nowClass, `${monthNameShort(month)} : ${Math.round(rNow*100)}%`),
        createChip(cls1, `${arrow1} ${monthNameShort(prev1M)} : ${Math.round(r1*100)}%`),
        createChip(cls2, `${arrow2} ${monthNameShort(prev2M)} : ${Math.round(r2*100)}%`)
    );
    row.append(habitName, chips);
    monthSummary.appendChild(row);
    });
}
document.getElementById('closeMonth').onclick=()=>{ monthModal.classList.add('hidden'); monthModal.classList.remove('flex'); };

function openYearModal(year){
    yearSummary.innerHTML='';
    yearModal.classList.remove('hidden');
    yearModal.classList.add('flex');
    yearModalTitle.textContent = `${year}`;
    requestAnimationFrame(()=>document.getElementById('closeYear')?.focus({ preventScroll:true }));

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

    if(habitsInYear.length === 0){
        const empty = document.createElement('div');
        empty.className = 'rounded-lg border border-white/10 bg-white/5 p-6 text-center text-sm text-white/50';
        empty.textContent = 'Aucune habitude planifiée pour cette année.';
        yearSummary.appendChild(empty);
        return;
    }

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
        bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', `${monthNameLong(m)} : ${Math.round(rate*100)}%`);
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

function goHome(){
    homePage.classList.remove('hidden');
    dayPage.classList.add('hidden');
    syncPrimaryActionButton();
    updateRouteHash('#/home', !window.location.hash);
    focusCurrentMonth();
}

const modalAddHabit=document.getElementById('modalAddHabit');
addHabitBtn.onclick = ()=>{
    // reset champs de base
    document.getElementById('habitNameInput').value = '';
    document.getElementById('habitStartInput').value = new Date().toISOString().slice(0,10);

    // weekly par défaut
    activateMode('weekly');

    // tous les jours actifs en vert
    Array.from(document.querySelectorAll('#weeklyDaysRow .dayToggle')).forEach(btn=>{
    btn.classList.add('bg-[rgb(0,200,75)]','text-black','border-green-400/40');
    btn.classList.remove('bg-white/10','text-white/80','border-white/10');
    btn.setAttribute('aria-pressed', 'true');
    });

    // valeurs défaut interval/monthly
    document.getElementById('everyXDaysInput').value = "3";
    document.getElementById('dayOfMonthInput').value = "1";

    modalAddHabit.classList.remove('hidden');
    modalAddHabit.classList.add('flex');
    requestAnimationFrame(()=>document.getElementById('habitNameInput').focus());
};

// Exclusivité visuelle des modes
function activateMode(mode){
    const rW = document.getElementById('freqWeeklyRadio');
    const rI = document.getElementById('freqIntervalRadio');
    const rM = document.getElementById('freqMonthlyRadio');

    rW.checked = (mode === 'weekly');
    rI.checked = (mode === 'interval');
    rM.checked = (mode === 'monthly');
    document.getElementById('freqWeeklyBlock').classList.toggle('is-selected', mode === 'weekly');
    document.getElementById('freqIntervalBlock').classList.toggle('is-selected', mode === 'interval');
    document.getElementById('freqMonthlyBlock').classList.toggle('is-selected', mode === 'monthly');
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
        btn.setAttribute('aria-pressed', 'false');
    } else {
        // passe en vert --> actif
        btn.classList.add('bg-[rgb(0,200,75)]','text-black','border-green-400/40');
        btn.classList.remove('bg-white/10','text-white/80','border-white/10');
        btn.setAttribute('aria-pressed', 'true');
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


const addHabitForm = document.getElementById('addHabitForm');
const confirmAddHabit = document.getElementById('confirmAddHabit');
let habitSubmitBusy = false;
bindInputEnterSubmit(addHabitForm, confirmAddHabit);

document.getElementById('cancelAddHabit').onclick=()=>{ modalAddHabit.classList.add('hidden'); modalAddHabit.classList.remove('flex'); };
addHabitForm.addEventListener('submit', async (event)=>{
    event.preventDefault();
    if(habitSubmitBusy) return;

    const name  = document.getElementById('habitNameInput').value.trim();
    const start = document.getElementById('habitStartInput').value;

    if (!name || !start) {
    showToast('Ajoute un nom et une date de début.', 'error');
    (!name ? document.getElementById('habitNameInput') : document.getElementById('habitStartInput')).focus();
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
        showToast('Choisis au moins un jour pour la fréquence hebdomadaire.', 'error');
        return;
    }
    } else if (modeInterval) {
    habitPayload.mode = "interval";
    const val = parseInt(document.getElementById('everyXDaysInput').value, 10);
    if (isNaN(val) || val < 1) {
        showToast('Le nombre de jours doit être supérieur ou égal à 1.', 'error');
        document.getElementById('everyXDaysInput').focus();
        return;
    }
    habitPayload.everyXDays = val;
    } else if (modeMonthly) {
    habitPayload.mode = "monthly";
    const domVal = parseInt(document.getElementById('dayOfMonthInput').value, 10);
    if (isNaN(domVal) || domVal < 1 || domVal > 31) {
        showToast('Le jour du mois doit être compris entre 1 et 31.', 'error');
        document.getElementById('dayOfMonthInput').focus();
        return;
    }
    habitPayload.dayOfMonth = domVal;
    } else {
    // Si rien n'est coché, on force weekly par défaut avec tous les jours
    habitPayload.mode = "weekly";
    habitPayload.daysOfWeek = [1,2,3,4,5,6,0];
    }

    const res = addHabitSmart(habitPayload);
    if (res.action === 'duplicate') {
        showToast('Une habitude porte déjà ce nom. Choisis un nom unique.', 'error');
        document.getElementById('habitNameInput').focus();
        return;
    }

    habitSubmitBusy = true;
    confirmAddHabit.disabled = true;
    try {
        clearHabitCaches(res.target.name);
        await persistDebounced(0);
        modalAddHabit.classList.add('hidden');
        modalAddHabit.classList.remove('flex');
        if (dayPage.classList.contains('hidden')) renderYears();
        else showDayPage(focusedDateKey || formatDateKey(new Date()));
    } finally {
        habitSubmitBusy = false;
        confirmAddHabit.disabled = false;
    }
});


let lastIsSmall = null;
let resizeTimer = null;

function router(){
    const hash = window.location.hash || '';
    const [, route, a] = hash.split('/');
    const small = isSmall();
    const today = formatDateKey(new Date());

    if (route === 'day') {
    const dateKey = isValidDateKey(a) ? a : today;
    if(a !== dateKey) history.replaceState(null, '', `#/day/${dateKey}`);
    showDayPage(dateKey);
    return;
    }

    if (small) {
    history.replaceState(null, '', `#/day/${today}`);
    showDayPage(today);
    return;
    }

    goHome();
}

window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
    const small = isSmall();
    syncOrientationButton();
    if (lastIsSmall === null || small !== lastIsSmall) {
        lastIsSmall = small;
        showViewportDefault();
    }
    }, 120);
});

lastIsSmall = isSmall();

window.addEventListener('popstate', router);

function bindOverlayClose(overlayEl, closeFn){ if(!overlayEl) return; overlayEl.addEventListener('click', (e)=>{ if(e.target === overlayEl) closeFn(); }); }
bindOverlayClose(modalAddHabit, ()=>{ modalAddHabit.classList.add('hidden'); modalAddHabit.classList.remove('flex'); });
bindOverlayClose(monthModal, ()=>{ monthModal.classList.add('hidden'); monthModal.classList.remove('flex'); });
bindOverlayClose(yearModal, ()=>{ yearModal.classList.add('hidden'); yearModal.classList.remove('flex'); });
bindOverlayClose(modalInstall, ()=>{ modalInstall.classList.add('hidden'); modalInstall.classList.remove('flex'); });

let app, db, docRef, unsubSnap, auth, currentUser;

const authModal   = document.getElementById('authModal');
const authForm    = document.getElementById('authForm');
const authEmail   = document.getElementById('authEmail');
const authPass    = document.getElementById('authPassword');
const authErrorEl = document.getElementById('authError');
const authSubmit  = document.getElementById('authSubmit');
const authCreate  = document.getElementById('authCreate');
const forgotPassword = document.getElementById('forgotPassword');
bindInputEnterSubmit(authForm, authSubmit);

const showAuthModal = () => {
    authModal.classList.remove('hidden');
    authModal.classList.add('flex');
    requestAnimationFrame(() => (authEmail.value ? authPass : authEmail).focus());
};
const hideAuthModal = () => { authModal.classList.add('hidden'); authModal.classList.remove('flex'); };
// === Beau visuel + export PNG ===
const monthModalRoot = document.getElementById('modalMonth');
const yearModalRoot  = document.getElementById('modalYear');

const monthPrettyBtn = document.getElementById('monthPrettyBtn');
const yearPrettyBtn  = document.getElementById('yearPrettyBtn');
const monthDownloadBtn = document.getElementById('monthDownloadBtn');
const yearDownloadBtn  = document.getElementById('yearDownloadBtn');

const closeMonthBtn = document.getElementById('closeMonth');
const closeYearBtn  = document.getElementById('closeYear');

const monthBackdrop = document.getElementById('monthBackdrop');
const yearBackdrop  = document.getElementById('yearBackdrop');

const monthDesc = document.getElementById('monthDesc');
const yearDesc  = document.getElementById('yearDesc');

function setPrettyUI(active, { root, backdrop, prettyBtn, desc }) {
    backdrop?.classList.toggle('hidden', !active);
    root?.classList.toggle('modal-screenshot', active);
    desc?.classList.toggle('hidden', active);
    prettyBtn?.setAttribute('aria-pressed', String(active));
    if(prettyBtn) prettyBtn.textContent = active ? 'Vue normale' : 'Beau visuel';
}

function togglePrettyUI(config) {
    setPrettyUI(!config.root.classList.contains('modal-screenshot'), config);
}

function canvasToDownload(canvas, filename){
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if(!blob){ reject(new Error('Image vide')); return; }
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            resolve();
        }, 'image/png');
    });
}

async function downloadSummaryPng({ root, desc, downloadBtn, filename }){
    if(typeof window.html2canvas !== 'function'){
        downloadBtn.dataset.exportState = 'unavailable';
        showToast("Le module d'image n'a pas pu charger. Vérifie ta connexion puis réessaie.", 'error');
        return;
    }
    const previousLabel = downloadBtn.textContent;
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Création…';
    downloadBtn.dataset.exportState = 'loading';
    let exportRoot;
    try {
        exportRoot = root.cloneNode(true);
        const cloneDesc = desc?.id ? exportRoot.querySelector(`#${desc.id}`) : null;
        cloneDesc?.classList.add('hidden');
        exportRoot.querySelector('.blob-field')?.classList.remove('hidden');
        exportRoot.classList.remove('hidden');
        exportRoot.classList.add('modal-screenshot', 'exporting');
        exportRoot.removeAttribute('id');
        exportRoot.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
        document.body.appendChild(exportRoot);
        const width = Math.max(1200, exportRoot.scrollWidth);
        const height = Math.max(800, exportRoot.scrollHeight);
        const canvas = await window.html2canvas(exportRoot, {
            backgroundColor: '#000000',
            scale: 1.5,
            useCORS: true,
            logging: false,
            width,
            height,
            windowWidth: width,
            windowHeight: height
        });
        await canvasToDownload(canvas, filename);
        downloadBtn.dataset.exportState = 'success';
        showToast('PNG téléchargé avec succès.');
    } catch(error){
        console.error('export png error', error);
        downloadBtn.dataset.exportState = 'error';
        showToast("Impossible de générer l'image pour le moment.", 'error');
    } finally {
        exportRoot?.remove();
        downloadBtn.disabled = false;
        downloadBtn.textContent = previousLabel;
    }
}

function showViewportDefault(){
    if(isSmall()){
        showDayPage(focusedDateKey || formatDateKey(new Date()));
        return;
    }
    goHome();
}

const monthPrettyConfig = { root: monthModalRoot, backdrop: monthBackdrop, prettyBtn: monthPrettyBtn, desc: monthDesc };
const yearPrettyConfig = { root: yearModalRoot, backdrop: yearBackdrop, prettyBtn: yearPrettyBtn, desc: yearDesc };

monthPrettyBtn?.addEventListener('click', () => togglePrettyUI(monthPrettyConfig));
yearPrettyBtn?.addEventListener('click', () => togglePrettyUI(yearPrettyConfig));
monthDownloadBtn?.addEventListener('click', () => downloadSummaryPng({
    root: monthModalRoot,
    desc: monthDesc,
    downloadBtn: monthDownloadBtn,
    filename: `HBTRK-${monthModalTitle.textContent.trim().replace(/\s+/g, '-')}.png`
}));
yearDownloadBtn?.addEventListener('click', () => downloadSummaryPng({
    root: yearModalRoot,
    desc: yearDesc,
    downloadBtn: yearDownloadBtn,
    filename: `HBTRK-${yearModalTitle.textContent.trim().replace(/\s+/g, '-')}.png`
}));

closeMonthBtn?.addEventListener('click', () => setPrettyUI(false, monthPrettyConfig));
closeYearBtn?.addEventListener('click', () => setPrettyUI(false, yearPrettyConfig));
monthModalRoot?.addEventListener('click', event => { if(event.target === monthModalRoot) setPrettyUI(false, monthPrettyConfig); });
yearModalRoot?.addEventListener('click', event => { if(event.target === yearModalRoot) setPrettyUI(false, yearPrettyConfig); });
document.addEventListener('keydown', event => {
    if(event.key !== 'Escape') return;
    if(textInputModal?.classList.contains('flex')) closeTextInputModal(null);
    else if(monthModalRoot?.classList.contains('flex')) closeMonthBtn?.click();
    else if(yearModalRoot?.classList.contains('flex')) closeYearBtn?.click();
    else if(modalAddHabit?.classList.contains('flex')) document.getElementById('cancelAddHabit')?.click();
    else if(modalInstall?.classList.contains('flex')) closeInstall?.click();
});


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

let authSubmitBusy = false;

// Bouton "Se connecter" et touche Entrée dans les champs de connexion
authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authSubmitBusy) return;
  authErrorEl.textContent = "";

  const email = authEmail.value.trim();
  const pass  = authPass.value;

  if (!email || !pass) {
    authErrorEl.textContent = "Entre ton email et ton mot de passe.";
    return;
  }

  authSubmitBusy = true;
  const authSubmitLabel = authSubmit.textContent;
  authSubmit.disabled = true;
  authSubmit.textContent = 'Connexion…';
  authCreate.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    // Pas besoin de plus ici : onAuthStateChanged() fera le reste
  } catch (err) {
    console.error("login error:", err);
    authErrorEl.textContent = friendlyAuthError(err.code);
  } finally {
    authSubmitBusy = false;
    authSubmit.disabled = false;
    authSubmit.textContent = authSubmitLabel;
    authCreate.disabled = false;
  }
});

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
    await loadFirebaseSdk();
    // initialise Firebase app
    app  = initializeApp(firebaseConfig);

    // initialise Firestore AVEC cache persistant moderne (remplace enableIndexedDbPersistence)
    try {
        db = initializeFirestore(app, {
            localCache: persistentLocalCache({
                tabManager: persistentMultipleTabManager()
            })
        });
    } catch(error){
        console.warn('persistent cache unavailable', error);
        db = getFirestore(app);
    }

    // auth
    auth = getAuth(app);

    // on garde ta persistance login dans le navigateur
    try {
        await setPersistence(auth, browserLocalPersistence);
    } catch(error){
        console.warn('auth persistence unavailable', error);
    }

    // le reste reste identique
    onAuthStateChanged(auth, async (user)=>{
    const previousUserId = currentUser?.uid || null;
    const nextUserId = user?.uid || null;
    if(previousUserId !== nextUserId){
        initialSynced = false;
        lastLocalWriteRevision = -1;
        focusedDateKey = null;
        docRef = null;
        data = { habits: [], tasks: [], taskRolloverSkips: {}, dayColors: {}, completions: {}, _rev: 0 };
        clearAllCaches();
    }
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
    homePage.innerHTML = '<div class="py-24 text-center text-sm text-white/50">Synchronisation de votre calendrier…</div>';

    docRef = doc(db, 'users', currentUser.uid, 'data', 'fourpill');

    unsubSnap = onSnapshot(docRef, (snap)=>{
        if (snap.exists()){
        const server = snap.data();
        const serverRevision = Number.isFinite(Number(server?._rev)) ? Number(server._rev) : 0;
        if(initialSynced && (snap.metadata.hasPendingWrites || serverRevision <= lastLocalWriteRevision)) return;
        data = normalizeData(server);
        const carriedTaskCount = rollForwardLaterTasks();
        const migratedTaskGroups = Array.isArray(server.tasks) && server.tasks.some(task => task?.groupBreakBefore === true);
        const serverRolloverTasks = Array.isArray(server.tasks) ? server.tasks.filter(task => task?.rolloverFromId) : [];
        const normalizedRolloverTasks = data.tasks.filter(task => task?.rolloverFromId);
        const savedRolloverSkips = normalizeTaskRolloverSkips(server.taskRolloverSkips);
        const inferredRolloverSkips = Object.entries(data.taskRolloverSkips || {}).some(([dateKey, rootIds]) =>
            rootIds.some(rootId => !savedRolloverSkips[dateKey]?.includes(rootId))
        );
        const migratedTaskRollovers = serverRolloverTasks.length !== normalizedRolloverTasks.length
            || serverRolloverTasks.some(task => !task.rolloverRootId)
            || inferredRolloverSkips;
        if(carriedTaskCount || migratedTaskGroups || migratedTaskRollovers) persistDebounced(0);
        clearAllCaches();
        } else {
        data = { habits:[], tasks:[], taskRolloverSkips:{}, dayColors:{}, completions:{}, _rev:0 };
        setDoc(docRef, data).catch(console.error);
        }

        if (!initialSynced){
        renderYears();
        router();
        initialSynced = true;
        } else {
        renderYears();
        if (focusedDateKey){
            if(isSmall() || dayPage.classList.contains('hidden') === false) showDayPage(focusedDateKey);
            else {
                updateDayCell(focusedDateKey);
                if(dayIsOpen) populateHabits(focusedDateKey, habitsList, false);
            }
        }
        }
    }, (err)=>{
        console.error('onSnapshot error', err);
        homePage.innerHTML = '<div class="compact-empty"><strong>Synchronisation indisponible.</strong><br>Vérifie ta connexion puis recharge la page.</div>';
        showToast('Impossible de synchroniser vos données.', 'error');
    });
    });
}

function buildLocalPreviewData(){
    const year = currentYear;
    const month = currentMonth;
    const monthStart = formatDateKey(new Date(year, month, 1));
    const habits = [
        { name:'Hydratation', startDate:monthStart, mode:'weekly', daysOfWeek:[0,1,2,3,4,5,6] },
        { name:'Lecture', startDate:monthStart, mode:'weekly', daysOfWeek:[0,1,2,3,4,5,6] },
        { name:'Sport', startDate:monthStart, mode:'weekly', daysOfWeek:[1,3,5] },
        { name:'Méditation', startDate:monthStart, mode:'interval', everyXDays:2 }
    ];
    const preview = { habits, tasks:[], taskRolloverSkips:{}, dayColors:{}, completions:{}, _rev:0 };
    const taskNames = ['Envoyer le dossier', 'Appeler le garage', 'Réserver le train', 'Acheter les courses'];
    const taskStates = [TASK_STATUS.PENDING, TASK_STATUS.DONE, TASK_STATUS.LATER, TASK_STATUS.SKIPPED];
    preview.tasks.push({
        id: 'preview-rollover-long-task',
        name: 'Préparer la présentation complète pour la réunion de lancement avec toute l’équipe',
        date: formatDateKey(new Date(year, month, 1)),
        status: TASK_STATUS.LATER,
        important: true,
        groupBreakBefore: false,
        rolloverFromId: null,
        rolloverRootId: null
    });
    for(let day = 1; day <= Math.min(14, new Date(year, month + 1, 0).getDate()); day++){
        const dateKey = formatDateKey(new Date(year, month, day));
        habits.filter(h => isHabitActiveOn(h, dateKey)).forEach((habit, index) => {
            if((day + index) % 3 === 0){
                if(!preview.completions[dateKey]) preview.completions[dateKey] = {};
                preview.completions[dateKey][habit.name] = HABIT_STATUS.DONE;
            }
        });
        if(day === 3){
            preview.tasks.push({ id:'preview-separator-3', name:'', date:dateKey, kind:'separator', status:TASK_STATUS.PENDING, important:false, groupBreakBefore:false, rolloverFromId:null, rolloverRootId:null });
        }
        preview.tasks.push({
            id: `preview-task-${day}-1`,
            name: taskNames[(day - 1) % taskNames.length],
            date: dateKey,
            status: taskStates[(day - 1) % taskStates.length],
            important: day % 4 === 0,
            groupBreakBefore: false
        });
        if(day % 3 === 0){
            preview.tasks.push({
                id: `preview-task-${day}-2`,
                name: `Finaliser le point ${day}`,
                date: dateKey,
                status: taskStates[day % taskStates.length],
                important: false,
                groupBreakBefore: day % 6 === 0
            });
        }
    }
    const colorSamples = ['green', 'purple', 'blue', 'orange'];
    colorSamples.forEach((color, index) => {
        const day = index + 1;
        if(day <= new Date(year, month + 1, 0).getDate()) preview.dayColors[formatDateKey(new Date(year, month, day))] = color;
    });
    return preview;
}

function initLocalPreview(){
    data = buildLocalPreviewData();
    rollForwardLaterTasks();
    clearAllCaches();
    setAuthedUI(true);
    userBadge.classList.add('hidden');
    menuLogout.disabled = true;
    menuLogout.textContent = 'Aperçu local';
    menuLogout.title = 'Les données de cet aperçu ne sont pas synchronisées.';
    renderYears();
    router();
    initialSynced = true;
}

(async function initApp(){
    scheduleTaskRollover();
    const localPreview = ['127.0.0.1', 'localhost'].includes(window.location.hostname) && new URLSearchParams(window.location.search).has('preview');
    if(localPreview){
        initLocalPreview();
        return;
    }
    try {
        await initFirebaseAll();
    } catch(error){
        console.error('initialization error', error);
        headerEl?.classList.remove('hidden');
        homePage?.classList.remove('hidden');
        homePage.innerHTML = '<div class="compact-empty"><strong>HBTRK ne peut pas démarrer.</strong><br>Vérifie ta connexion internet puis recharge la page.</div>';
        showToast("Le service de synchronisation n'a pas pu démarrer.", 'error');
    }
})();
