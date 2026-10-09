const DEFAULT_API_KEY = "";
const STORAGE_KEY = "KoreanApp_Ecosystem_State_V5";

function getLocalToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

let appState = {
    apiKey: DEFAULT_API_KEY,
    ghToken: "",
    ghUser: "",
    ghRepo: "",
    autoSync: false,
    dailyLimit: 5,
    settings: { hardMode: false },
    words: [],
    flashcards: [],
    library: [],
    sessionStats: { date: "", again: [], hard: [], good: [], easy: [] },
    history: {}
};

let currentStoryId = null;
let currentStoryText = "";
let editingCardId = null;

function loadState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try { appState = { ...appState, ...JSON.parse(saved) }; } catch (e) {}
    }
    
    if (!appState.apiKey) appState.apiKey = DEFAULT_API_KEY;
    if (!appState.library) appState.library = [];
    if (!appState.history) appState.history = {};
    if (!appState.settings) appState.settings = { hardMode: false };
    
    const today = getLocalToday();
    
    if (!appState.sessionStats || appState.sessionStats.date !== today) {
        appState.sessionStats = { date: today, again: [], hard: [], good: [], easy: [] };
        saveState();
    } else {
        if (!appState.history[today]) {
            appState.history[today] = { again: 0, hard: 0, good: 0, easy: 0, completedAll: false, newCardsDone: 0, practicedMistakes: [] };
        } else if (!appState.history[today].practicedMistakes) {
            appState.history[today].practicedMistakes = [];
        }
        
        const hist = appState.history[today];
        const sess = appState.sessionStats;
        
        const totalHist = hist.again + hist.hard + hist.good + hist.easy;
        const totalSess = (sess.again?.length || 0) + (sess.hard?.length || 0) + (sess.good?.length || 0) + (sess.easy?.length || 0);
        
        if (totalHist === 0 && totalSess > 0) {
            hist.again = sess.again?.length || 0;
            hist.hard = sess.hard?.length || 0;
            hist.good = sess.good?.length || 0;
            hist.easy = sess.easy?.length || 0;
            saveState();
        }
    }

    updateSettingsUI();
    renderWordsTable();
    renderDeckTable();
    refreshStudySession();
}

function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(targetId).classList.add('active');
        
        if (targetId === 'tab-fiszki') refreshStudySession();
        if (targetId === 'tab-slowka') renderWordsTable();
        if (targetId === 'tab-aktywnosc') updateActivityStats();
    });
});

function updateSettingsUI() {
    document.getElementById('api-key').value = appState.apiKey;
    document.getElementById('gh-token').value = appState.ghToken || "";
    document.getElementById('gh-user').value = appState.ghUser || "";
    document.getElementById('gh-repo').value = appState.ghRepo || "";
    document.getElementById('auto-sync').checked = appState.autoSync || false;
    document.getElementById('daily-limit').value = appState.dailyLimit;
    
    const hardModeToggle = document.getElementById('hard-mode-setting');
    if (hardModeToggle) hardModeToggle.checked = appState.settings.hardMode || false;
}

function saveSettings() {
    appState.apiKey = document.getElementById('api-key').value.trim();
    appState.ghToken = document.getElementById('gh-token').value.trim();
    appState.ghUser = document.getElementById('gh-user').value.trim();
    appState.ghRepo = document.getElementById('gh-repo').value.trim();
    appState.autoSync = document.getElementById('auto-sync').checked;
    
    if (!appState.settings) appState.settings = {};
    const hardModeToggle = document.getElementById('hard-mode-setting');
    if (hardModeToggle) appState.settings.hardMode = hardModeToggle.checked;
    
    const lim = parseInt(document.getElementById('daily-limit').value);
    if (lim > 0) appState.dailyLimit = lim;
    
    saveState();
    refreshStudySession();
    alert("Ustawienia zostały zapisane.");
}

function deleteApiKey() {
    appState.apiKey = DEFAULT_API_KEY;
    updateSettingsUI();
    saveState();
    alert("Klucz API AI został usunięty z pamięci.");
}

// --- GITHUB CLOUD SYNC ---
function encodeBase64Unicode(str) { return btoa(unescape(encodeURIComponent(str))); }
function decodeBase64Unicode(str) { return decodeURIComponent(escape(atob(str))); }

async function syncToGitHub() {
    appState.ghToken = document.getElementById('gh-token').value.trim();
    appState.ghUser = document.getElementById('gh-user').value.trim();
    appState.ghRepo = document.getElementById('gh-repo').value.trim();
    appState.autoSync = document.getElementById('auto-sync').checked;
    saveState();

    if (!appState.ghToken || !appState.ghUser || !appState.ghRepo) {
        return alert("Wypełnij najpierw wszystkie 3 pola synchronizacji (Token, Użytkownik, Repozytorium)!");
    }
    const msg = document.getElementById('sync-msg');
    const loader = document.getElementById('sync-loader');
    loader.style.display = 'block'; msg.textContent = "Wysyłanie..."; msg.style.color = 'var(--text-dark)';

    const url = `https://api.github.com/repos/${appState.ghUser}/${appState.ghRepo}/contents/database.json`;
    let sha = "";

    try {
        const getRes = await fetch(url, { headers: { "Authorization": `token ${appState.ghToken}` } });
        if (getRes.ok) {
            const getData = await getRes.json();
            sha = getData.sha;
        }

        const safeState = {
            dailyLimit: appState.dailyLimit,
            autoSync: appState.autoSync || false,
            settings: appState.settings || { hardMode: false },
            words: appState.words || [],
            flashcards: appState.flashcards || [],
            library: appState.library || [],
            history: appState.history || {}, 
            sessionStats: appState.sessionStats || { again: [], hard: [], good: [], easy: [] }
        };

        const body = {
            message: `Zapis postępów z aplikacji (${getLocalToday()})`,
            content: encodeBase64Unicode(JSON.stringify(safeState, null, 2))
        };
        if (sha) body.sha = sha;

        const putRes = await fetch(url, {
            method: 'PUT',
            headers: { "Authorization": `token ${appState.ghToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        if (putRes.ok) {
            msg.textContent = "✅ Postępy pomyślnie zapisane w repozytorium GitHub!";
            msg.style.color = "var(--success)";
        } else {
            const errData = await putRes.json();
            throw new Error(errData.message || "Błąd zapisu");
        }
    } catch (e) {
        msg.textContent = `❌ Błąd: ${e.message}`;
        msg.style.color = "var(--danger)";
    } finally {
        loader.style.display = 'none';
    }
}

async function syncFromGitHub() {
    appState.ghToken = document.getElementById('gh-token').value.trim();
    appState.ghUser = document.getElementById('gh-user').value.trim();
    appState.ghRepo = document.getElementById('gh-repo').value.trim();
    saveState();

    if (!appState.ghToken || !appState.ghUser || !appState.ghRepo) {
        return alert("Wypełnij najpierw wszystkie 3 pola synchronizacji (Token, Użytkownik, Repozytorium)!");
    }
    const msg = document.getElementById('sync-msg');
    const loader = document.getElementById('sync-loader');
    loader.style.display = 'block'; msg.textContent = "Pobieranie..."; msg.style.color = 'var(--text-dark)';

    const url = `https://api.github.com/repos/${appState.ghUser}/${appState.ghRepo}/contents/database.json`;
    
    try {
        const getRes = await fetch(url, { headers: { "Authorization": `token ${appState.ghToken}` } });
        if (!getRes.ok) throw new Error("Nie znaleziono pliku database.json w tym repozytorium.");
        
        const data = await getRes.json();
        const jsonStr = decodeBase64Unicode(data.content);
        const imported = JSON.parse(jsonStr);
        
        if (imported && Array.isArray(imported.flashcards)) {
            const currentApiKey = appState.apiKey;
            const currentGhToken = appState.ghToken;
            const currentGhUser = appState.ghUser;
            const currentGhRepo = appState.ghRepo;

            appState = imported;

            appState.apiKey = currentApiKey;
            appState.ghToken = currentGhToken;
            appState.ghUser = currentGhUser;
            appState.ghRepo = currentGhRepo;

            if(!appState.history) appState.history = {};
            if(!appState.settings) appState.settings = { hardMode: false };

            saveState();
            msg.textContent = "✅ Postępy pobrane i wczytane!";
            msg.style.color = "var(--success)";
            setTimeout(() => location.reload(), 1500);
        } else {
            throw new Error("Pobrany plik ma zły format.");
        }
    } catch (e) {
        msg.textContent = `❌ Błąd: ${e.message}`;
        msg.style.color = "var(--danger)";
    } finally {
        loader.style.display = 'none';
    }
}

// --- AUTO SYNC W TLE ---
async function silentSyncToGitHub() {
    if (!appState.autoSync || !appState.ghToken || !appState.ghUser || !appState.ghRepo) return;
    const url = `https://api.github.com/repos/${appState.ghUser}/${appState.ghRepo}/contents/database.json`;
    try {
        let sha = "";
        const getRes = await fetch(url, { headers: { "Authorization": `token ${appState.ghToken}` } });
        if (getRes.ok) { const getData = await getRes.json(); sha = getData.sha; }

        const safeState = {
            dailyLimit: appState.dailyLimit, autoSync: appState.autoSync,
            settings: appState.settings || { hardMode: false },
            words: appState.words || [], flashcards: appState.flashcards || [],
            library: appState.library || [], history: appState.history || {},
            sessionStats: appState.sessionStats || { again: [], hard: [], good: [], easy: [] }
        };

        const body = {
            message: `Auto-sync w tle (${getLocalToday()} ${new Date().toLocaleTimeString('pl-PL')})`,
            content: encodeBase64Unicode(JSON.stringify(safeState, null, 2))
        };
        if (sha) body.sha = sha;

        await fetch(url, {
            method: 'PUT',
            headers: { "Authorization": `token ${appState.ghToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            keepalive: true 
        });

        const msg = document.getElementById('sync-msg');
        if (msg) { msg.textContent = "⏱️ Ostatnia automatyczna kopia zapasowa: " + new Date().toLocaleTimeString('pl-PL'); msg.style.color = "var(--text-light)"; }
    } catch (e) { console.error("Auto-sync error:", e); }
}

setInterval(() => { if (document.visibilityState === 'visible') silentSyncToGitHub(); }, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') silentSyncToGitHub(); });

function exportData() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState, null, 2));
    const dl = document.createElement('a');
    dl.setAttribute("href", dataStr);
    dl.setAttribute("download", `korean_fiszki_backup_${getLocalToday()}.json`);
    dl.click();
}

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const imported = JSON.parse(e.target.result);
            if (imported && Array.isArray(imported.flashcards)) {
                appState = imported;
                saveState();
                alert(`Pomyślnie wgrano postępy! Załadowano ${appState.flashcards.length} fiszek.`);
                location.reload();
            } else { alert("Nieprawidłowy format pliku z postępami."); }
        } catch (err) { alert("Błąd odczytu pliku JSON."); }
        event.target.value = '';
    };
    reader.readAsText(file);
}

// --- CZYTELNIA I BIBLIOTEKA ---
function toggleLibrary() {
    const libView = document.getElementById('library-view');
    const setupView = document.getElementById('reader-setup');
    const readerView = document.getElementById('reader-view');
    
    if (libView.classList.contains('hidden')) {
        readerView.classList.add('hidden');
        setupView.classList.add('hidden');
        libView.classList.remove('hidden');
        renderLibrary();
    } else {
        libView.classList.add('hidden');
        setupView.classList.remove('hidden');
    }
}

function renderLibrary() {
    const list = document.getElementById('library-list');
    list.innerHTML = "";
    if (!appState.library || appState.library.length === 0) {
        list.innerHTML = '<p class="hint text-center">Brak zapisanych historii. Wygeneruj lub wklej nową!</p>';
        return;
    }
    appState.library.forEach(story => {
        const div = document.createElement('div');
        div.className = 'library-item';
        div.onclick = () => loadStoryFromLibrary(story.id);
        div.innerHTML = `
            <div class="flex-between">
                <h4>${story.title || "Bez tytułu"}</h4>
                <button class="btn btn-danger btn-sm" onclick="deleteStory(event, '${story.id}')">Usuń</button>
            </div>
            <p>${story.text.substring(0, 80)}...</p>
        `;
        list.appendChild(div);
    });
}

function saveStoryToLibrary() {
    const title = document.getElementById('story-title').value.trim() || "Moja historia " + getLocalToday();
    if (!currentStoryText) return;

    if (currentStoryId) {
        const s = appState.library.find(x => x.id == currentStoryId);
        if(s) s.title = title;
    } else {
        currentStoryId = Date.now().toString();
        appState.library.push({ id: currentStoryId, title: title, text: currentStoryText });
    }
    saveState();
    alert("Zapisano w bibliotece!");
}

function loadStoryFromLibrary(id) {
    const story = appState.library.find(x => x.id == id);
    if (!story) return;
    document.getElementById('library-view').classList.add('hidden');
    currentStoryId = story.id;
    currentStoryText = story.text;
    document.getElementById('story-title').value = story.title;
    setupReaderContent(story.text);
}

function deleteStory(event, id) {
    event.stopPropagation();
    if(confirm("Usunąć tę historię z biblioteki?")) {
        appState.library = appState.library.filter(x => x.id != id);
        saveState();
        renderLibrary();
    }
}

function startReadingCustom() {
    const text = document.getElementById('custom-text').value.trim();
    if (!text) return alert("Wklej tekst!");
    currentStoryId = null;
    currentStoryText = text;
    document.getElementById('story-title').value = "";
    setupReaderContent(text);
}

async function fetchWithRetry(url, options, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;
            if ([503, 429].includes(response.status) && i < retries - 1) {
                await new Promise(res => setTimeout(res, delay * Math.pow(2, i)));
                continue;
            }
            return response;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, delay));
        }
    }
}

async function generateAIStory() {
    if (!appState.apiKey || appState.apiKey.trim() === "") {
        alert("Aby wygenerować historię, przejdź do zakładki Ustawienia i podaj swój klucz Gemini API.");
        return;
    }

    const loader = document.getElementById('ai-loader');
    const errorP = document.getElementById('ai-error');
    loader.style.display = 'block'; errorP.style.display = 'none';

    const known = appState.flashcards.filter(f => f.interval > 10).map(f => f.front);
    const learning = appState.flashcards.filter(f => f.interval <= 10).map(f => f.front);
    const prompt = `Jesteś osobistym nauczycielem koreańskiego i twórcą Graded Readers. Napisz krótką (100-180 słów) historię po koreańsku. ZNANE słowa: [${known.join(', ')}], W TRAKCIE NAUKI: [${learning.join(', ')}]. Używaj 70% słów ZNANYCH, 20% W TRAKCIE NAUKI, max 10% CAŁKOWICIE NOWYCH. Historia ma być naturalna i współczesna. Zwróć WYŁĄCZNIE sam tekst koreański, bez tłumaczeń i markdown.`;

    try {
        const response = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${appState.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ? data.error.message : "Błąd API Gemini.");
        let aiText = data.candidates[0].content.parts[0].text.replace(/```/g, '').trim();
        document.getElementById('custom-text').value = aiText;
        
        currentStoryId = null;
        currentStoryText = aiText;
        document.getElementById('story-title').value = "Wygenerowana historia " + getLocalToday();
        setupReaderContent(aiText);
    } catch (err) {
        errorP.textContent = "Błąd: " + err.message; errorP.style.display = 'block';
    } finally { loader.style.display = 'none'; }
}

function setupReaderContent(text) {
    document.getElementById('reader-setup').classList.add('hidden');
    document.getElementById('reader-view').classList.remove('hidden');
    document.getElementById('sumup-result').textContent = "";
    const container = document.getElementById('reader-content');
    container.innerHTML = "";
    
    text.split(/([\s]+)/).forEach(token => {
        if (/\s+/.test(token)) {
            container.appendChild(document.createTextNode(token));
        } else {
            const cleanWord = token.replace(/[.,!?()\[\]"'“”]/g, '').trim();
            const isFiszka = appState.flashcards.some(f => f.back === cleanWord || f.front === cleanWord);
            
            const span = document.createElement('span');
            span.className = 'word-span';
            if(isFiszka) span.classList.add('known-word');
            span.textContent = token;
            
            span.onclick = () => {
                if(!isFiszka) span.classList.toggle('selected');
            };
            container.appendChild(span);
        }
    });
}

function closeReader() {
    document.getElementById('reader-view').classList.add('hidden');
    document.getElementById('reader-setup').classList.remove('hidden');
}

function sumUpWords() {
    const selected = document.querySelectorAll('.word-span.selected');
    if (selected.length === 0) return alert("Zaznacz słowa.");
    let count = 0;
    selected.forEach(span => {
        let clean = span.textContent.replace(/[.,!?()\[\]"'“”]/g, '').trim();
        if (clean && !appState.words.find(w => w.ko === clean)) {
            const wObj = { id: Date.now() + Math.random(), ko: clean, autoPl: "Ładowanie...", custom: "" };
            appState.words.push(wObj);
            fetchTranslation(clean, wObj.id);
            count++;
        }
    });
    saveState();
    document.getElementById('sumup-result').textContent = `Dodano ${count} słów do słownika!`;
    selected.forEach(s => s.classList.remove('selected'));
}

async function fetchTranslation(word, id) {
    try {
        const targetUrl = `[https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=pl&dt=t&q=$](https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=pl&dt=t&q=$){encodeURIComponent(word)}`;
        const proxyUrl = `[https://api.allorigins.win/get?url=$](https://api.allorigins.win/get?url=$){encodeURIComponent(targetUrl)}`;
        
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error("Błąd proxy");
        const proxyData = await res.json();
        const data = JSON.parse(proxyData.contents);
        let tr = data[0][0][0];
        
        if (!tr || tr === word) tr = "Brak tłumaczenia";
        
        const w = appState.words.find(item => item.id == id);
        if (w) { 
            w.autoPl = tr; 
            saveState(); 
            renderWordsTable(); 
        }
    } catch (e) {
        const w = appState.words.find(item => item.id == id);
        if (w) { w.autoPl = "Błąd pobierania"; saveState(); renderWordsTable(); }
    }
}

function renderWordsTable() {
    const tbody = document.getElementById('words-tbody');
    tbody.innerHTML = "";
    appState.words.forEach(w => {
        const isAdded = appState.flashcards.some(f => f.back === w.ko || f.front === w.ko);
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${w.ko}</strong></td>
            <td>${w.autoPl}</td>
            <td><input type="text" value="${w.custom}" placeholder="Własne..." onchange="updateCustomTranslation('${w.id}', this.value)"></td>
            <td>
                <div style="display: flex; gap: 5px;">
                    <button class="btn btn-primary btn-sm" style="flex: 1;" ${isAdded ? 'disabled' : ''} onclick="addWordToSRS('${w.id}')">${isAdded ? 'Dodane' : 'Fiszka'}</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteWord('${w.id}')">Usuń</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function deleteWord(id) {
    if (confirm("Usunąć to słówko z listy?")) {
        appState.words = appState.words.filter(w => w.id != id);
        saveState();
        renderWordsTable();
    }
}

function updateCustomTranslation(id, val) {
    const w = appState.words.find(item => item.id == id);
    if (w) { w.custom = val; saveState(); }
}

function addWordToSRS(id) {
    const w = appState.words.find(item => item.id == id);
    if (!w) return;
    
    const frontTranslation = w.custom.trim() !== "" ? w.custom : w.autoPl;
    const isAdded = createFlashcardData(frontTranslation, w.ko, 0, 0, 2.5, null, "");
    
    if (isAdded) {
        saveState();
        renderDeckTable();
        refreshStudySession();
    }
    renderWordsTable();
    if(!document.getElementById('reader-view').classList.contains('hidden')) {
        setupReaderContent(currentStoryText);
    }
}

// --- ZARZĄDZANIE FISZKAMI I SRS ---
function createFlashcardData(front, back, rep, interval, ef, nextReviewStr = null, exampleSentence = "") {
    if(!front || !back || appState.flashcards.some(f => f.front === front && f.back === back)) return false;
    appState.flashcards.push({
        id: Date.now() + Math.random(),
        front: front.trim(),
        back: back.trim(),
        exampleSentence: exampleSentence.trim(),
        rep: rep > 0 ? rep : (interval > 0 ? 1 : 0),
        interval: interval > 0 ? interval : 0,
        ef: ef >= 1.3 ? ef : 2.5,
        nextReview: nextReviewStr || (interval > 0 ? new Date(Date.now() + interval * 86400000).toISOString() : new Date().toISOString())
    });
    return true;
}

function addManualFlashcard() {
    const front = document.getElementById('manual-front').value.trim();
    const back = document.getElementById('manual-back').value.trim();
    const example = document.getElementById('manual-example').value.trim();
    if (!front || !back) return alert("Uzupełnij przynajmniej pola Awers i Rewers.");
    
    if (createFlashcardData(front, back, 0, 0, 2.5, null, example)) {
        saveState(); renderDeckTable(); refreshStudySession();
        document.getElementById('manual-front').value = ""; 
        document.getElementById('manual-back').value = "";
        document.getElementById('manual-example').value = "";
    } else { alert("Taka fiszka już istnieje!"); }
}

function toggleDeckList() {
    const container = document.getElementById('deck-list-container');
    container.classList.toggle('hidden');
}

function renderDeckTable() {
    const tbody = document.getElementById('deck-tbody');
    tbody.innerHTML = "";
    const countSpan = document.getElementById('total-cards-count');
    if(countSpan) countSpan.textContent = appState.flashcards.length;

    appState.flashcards.forEach(f => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><input type="text" value="${f.front}" onchange="updateCardField('${f.id}', 'front', this.value)"></td>
            <td><input type="text" value="${f.back}" onchange="updateCardField('${f.id}', 'back', this.value)"></td>
            <td>${f.interval}d</td>
            <td>
                <div style="display: flex; gap: 5px;">
                    <button class="btn btn-outline btn-sm" style="flex: 1; padding: 4px;" onclick="openQuickEdit('${f.id}')">✏️ Edytuj</button>
                    <button class="btn btn-danger btn-sm" style="flex: 1; padding: 4px;" onclick="deleteCard('${f.id}')">Usuń</button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function updateCardField(id, field, val) {
    const c = appState.flashcards.find(item => item.id == id);
    if (c) { c[field] = val; saveState(); }
}

function deleteCard(id) {
    if (confirm("Usunąć fiszkę?")) {
        appState.flashcards = appState.flashcards.filter(item => item.id != id);
        saveState(); renderDeckTable(); refreshStudySession(); renderWordsTable();
    }
}

let studyQueue = [];
let currentCard = null;

function updateStudyCounter() {
    document.getElementById('study-stats').textContent = `Do powtórki: ${studyQueue.length}`;
}

function refreshStudySession() {
    const todayStr = getLocalToday();
    
    if (!appState.history) appState.history = {};
    if (!appState.history[todayStr]) {
        appState.history[todayStr] = { again: 0, hard: 0, good: 0, easy: 0, completedAll: false, newCardsDone: 0, practicedMistakes: [] };
    } else if (!appState.history[todayStr].practicedMistakes) {
        appState.history[todayStr].practicedMistakes = [];
    }

    let newCardsDone = appState.history[todayStr].newCardsDone || 0;
    let newCardsInQueue = 0;
    
    const todayObj = new Date();
    todayObj.setHours(0, 0, 0, 0); 
    
    studyQueue = appState.flashcards.filter(c => {
        let isDue = false;
        if (!c.nextReview) {
            isDue = true;
        } else {
            const reviewDate = new Date(c.nextReview);
            reviewDate.setHours(0, 0, 0, 0); 
            if (reviewDate.getTime() <= todayObj.getTime()) {
                isDue = true;
            }
        }

        if (isDue) {
            if (c.interval === 0) {
                if (newCardsDone + newCardsInQueue >= appState.dailyLimit) return false;
                newCardsInQueue++;
            }
            return true;
        }
        return false;
    });

    studyQueue.sort((a, b) => (a.interval > 0 && b.interval === 0 ? -1 : (a.interval === 0 && b.interval > 0 ? 1 : 0)));

    updateSessionProgressUI();
    updateStudyCounter();

    if (studyQueue.length === 0) {
        appState.history[todayStr].completedAll = true;
        saveState();
        document.getElementById('study-empty').classList.remove('hidden');
        document.getElementById('study-active').classList.add('hidden');
        updateActivityStats();
        
        const practiceBtn = document.getElementById('btn-practice-mistakes');
        if (appState.sessionStats && appState.sessionStats.date === todayStr && appState.sessionStats.again && appState.sessionStats.again.length > 0) {
            const practiced = appState.history[todayStr].practicedMistakes || [];
            const uniqueMistakes = Array.from(new Map(appState.sessionStats.again.map(item => [item.id, item])).values())
                                        .filter(item => !practiced.includes(item.id));

            if (uniqueMistakes.length > 0) {
                practiceBtn.textContent = `Przećwicz dzisiejsze błędy (${uniqueMistakes.length})`;
                practiceBtn.classList.remove('hidden');
            } else {
                practiceBtn.classList.add('hidden');
            }
        } else {
            if(practiceBtn) practiceBtn.classList.add('hidden');
        }

    } else {
        appState.history[todayStr].completedAll = false;
        saveState();
        document.getElementById('study-empty').classList.add('hidden');
        document.getElementById('study-active').classList.remove('hidden');
        
        const practiceBtn = document.getElementById('btn-practice-mistakes');
        if(practiceBtn) practiceBtn.classList.add('hidden');

        nextStudyCard();
    }
}

function nextStudyCard() {
    if (studyQueue.length === 0) { refreshStudySession(); return; }
    currentCard = studyQueue[0];
    
    document.getElementById('study-front').textContent = currentCard.front;
    
    let backHtml = `<div class="study-back-content"><div>${currentCard.back}</div>`;
    if (currentCard.exampleSentence) {
        backHtml += `<div class="example-sentence">${currentCard.exampleSentence}</div>`;
    }
    backHtml += `</div>`;
    
    document.getElementById('study-back').innerHTML = backHtml;
    
    document.getElementById('study-front').classList.remove('hidden');
    document.getElementById('study-back').classList.add('hidden');
    document.getElementById('srs-actions').classList.add('hidden');
    
    const isHardMode = appState.settings && appState.settings.hardMode;
    if (isHardMode) {
        document.getElementById('btn-show-answer').classList.add('hidden');
        document.getElementById('hard-mode-container').classList.remove('hidden');
        
        const hmInput = document.getElementById('hard-mode-input');
        hmInput.value = '';
        hmInput.classList.remove('error', 'success-input');
        hmInput.disabled = false;
        
        setTimeout(() => hmInput.focus(), 150);
    } else {
        document.getElementById('btn-show-answer').classList.remove('hidden');
        document.getElementById('hard-mode-container').classList.add('hidden');
    }

    document.getElementById('time-hard').textContent = previewSM2(currentCard, 3);
    document.getElementById('time-good').textContent = previewSM2(currentCard, 4);
    document.getElementById('time-easy').textContent = previewSM2(currentCard, 5);
}

function checkHardMode() {
    const inputEl = document.getElementById('hard-mode-input');
    const answerRaw = inputEl.value;
    const targetRaw = currentCard.back;
    
    if (!answerRaw.trim()) return;

    const normalize = str => str.replace(/\s+/g, '').toLowerCase();
    
    if (normalize(answerRaw) === normalize(targetRaw)) {
        inputEl.classList.add('success-input');
        inputEl.disabled = true;
        
        setTimeout(() => {
            processAnswer(4);
        }, 400);
    } else {
        inputEl.classList.add('error');
        setTimeout(() => {
            inputEl.classList.remove('error');
            inputEl.value = '';
            inputEl.focus();
        }, 400);
    }
}

function giveUpHardMode() {
    const inputEl = document.getElementById('hard-mode-input');
    inputEl.value = currentCard.back;
    inputEl.disabled = true;
    inputEl.style.color = "var(--danger)";
    
    document.getElementById('study-back').classList.remove('hidden');
    
    setTimeout(() => {
        inputEl.style.color = "";
        processAnswer(0);
    }, 1500);
}

function showAnswer() {
    document.getElementById('study-back').classList.remove('hidden');
    document.getElementById('btn-show-answer').classList.add('hidden');
    document.getElementById('srs-actions').classList.remove('hidden');
}

function previewSM2(card, quality) {
    let temp = { ...card }; applySM2(temp, quality); return `${temp.interval}d`;
}

function processAnswer(quality) {
    if ('vibrate' in navigator) {
        if (quality === 4) {
            navigator.vibrate(50);
        } else if (quality === 5) {
            navigator.vibrate([30, 50, 30]);
        }
    }

    const today = getLocalToday();
    if (!appState.sessionStats || appState.sessionStats.date !== today) {
        appState.sessionStats = { date: today, again: [], hard: [], good: [], easy: [] };
    }
    
    if (!appState.history) appState.history = {};
    if (!appState.history[today]) {
        appState.history[today] = { again: 0, hard: 0, good: 0, easy: 0, completedAll: false, newCardsDone: 0, practicedMistakes: [] };
    } else if (!appState.history[today].practicedMistakes) {
        appState.history[today].practicedMistakes = [];
    }

    let cat = quality < 3 ? 'again' : (quality === 3 ? 'hard' : (quality === 4 ? 'good' : 'easy'));
    appState.sessionStats[cat].push({ ...currentCard });
    appState.history[today][cat]++; 

    if (currentCard.interval === 0) {
        appState.history[today].newCardsDone = (appState.history[today].newCardsDone || 0) + 1;
    }

    applySM2(currentCard, quality);
    studyQueue.shift(); 
    saveState(); 
    renderDeckTable(); 
    
    updateStudyCounter();
    updateSessionProgressUI();

    if (studyQueue.length === 0) {
        appState.history[today].completedAll = true;
        saveState();
        document.getElementById('study-empty').classList.remove('hidden');
        document.getElementById('study-active').classList.add('hidden');
        updateActivityStats();
        refreshStudySession(); 
    } else {
        nextStudyCard();
    }
}

function applySM2(card, quality) {
    if (quality < 3) { 
        card.rep = 0; 
        card.interval = 1; 
    } else {
        if (card.rep === 0) {
            if (quality === 3) card.interval = 1;
            else if (quality === 4) card.interval = 3;
            else if (quality === 5) card.interval = 5;
        }
        else if (card.rep === 1) {
            if (quality === 3) card.interval = 2;
            else if (quality === 4) card.interval = 6;
            else if (quality === 5) card.interval = 8;
        }
        else {
            card.interval = Math.round(card.interval * card.ef);
            if (quality === 3) card.interval = Math.max(1, Math.round(card.interval * 0.8));
            else if (quality === 5) card.interval = Math.round(card.interval * 1.2);
        }
        card.rep++;
    }
    card.ef = Math.max(1.3, card.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    
    let next = new Date(); 
    next.setDate(next.getDate() + card.interval); 
    next.setHours(0, 0, 0, 0); 
    card.nextReview = next.toISOString();
}

function updateSessionProgressUI() {
    if (!appState.sessionStats) return;
    const total = appState.sessionStats.again.length + appState.sessionStats.hard.length + appState.sessionStats.good.length + appState.sessionStats.easy.length;
    
    if (total === 0) {
        document.getElementById('prog-again').style.width = '0%';
        document.getElementById('prog-hard').style.width = '0%';
        document.getElementById('prog-good').style.width = '0%';
        document.getElementById('prog-easy').style.width = '0%';
        document.getElementById('prog-percent').textContent = '0';
        return;
    }
    const pAgain = (appState.sessionStats.again.length / total) * 100;
    const pHard = (appState.sessionStats.hard.length / total) * 100;
    const pGood = (appState.sessionStats.good.length / total) * 100;
    const pEasy = (appState.sessionStats.easy.length / total) * 100;

    document.getElementById('prog-again').style.width = pAgain + '%';
    document.getElementById('prog-hard').style.width = pHard + '%';
    document.getElementById('prog-good').style.width = pGood + '%';
    document.getElementById('prog-easy').style.width = pEasy + '%';

    const successRate = ((appState.sessionStats.good.length + appState.sessionStats.easy.length) / total * 100).toFixed(0);
    document.getElementById('prog-percent').textContent = successRate;
}

function openStatsModal() {
    if (!appState.sessionStats) return;
    const container = document.getElementById('stats-details-container');
    container.innerHTML = '';
    
    const cats = [
        { id: 'again', name: 'Złe (Nie znam)', color: 'var(--danger)', data: appState.sessionStats.again },
        { id: 'hard', name: 'Średnie (Słabo)', color: 'var(--warning)', data: appState.sessionStats.hard },
        { id: 'good', name: 'Dobre', color: '#3B82F6', data: appState.sessionStats.good },
        { id: 'easy', name: 'Bardzo Dobre', color: 'var(--success)', data: appState.sessionStats.easy }
    ];

    let html = '';
    cats.forEach(c => {
        if(c.data.length > 0) {
            html += `<h4 style="color: ${c.color}; margin-top: 10px;">${c.name} (${c.data.length})</h4>`;
            html += `<ul class="stats-list">`;
            c.data.forEach(card => { html += `<li><b>${card.front}</b> - ${card.back}</li>`; });
            html += `</ul>`;
        }
    });

    if(html === '') html = '<p class="text-center hint">Brak danych w dzisiejszej sesji.</p>';
    container.innerHTML = html;
    document.getElementById('modal-stats').classList.remove('hidden');
}

// --- LOGIKA AKTYWNOŚCI ---
function updateActivityStats() {
    if (!appState.history) return;
    const today = getLocalToday();
    
    const dates = Object.keys(appState.history).sort();
    const completedDates = dates.filter(d => appState.history[d].completedAll);
    
    let currentStreak = 0;
    let maxStreak = 0;
    let totalDays = completedDates.length;
    
    let tempStreak = 0;
    let prevDate = null;
    
    for (let i = 0; i < completedDates.length; i++) {
        const d = completedDates[i];
        if (!prevDate) {
            tempStreak = 1;
        } else {
            const diffTime = Math.abs(new Date(d) - new Date(prevDate));
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
            if (diffDays === 1) {
                tempStreak++;
            } else {
                tempStreak = 1;
            }
        }
        if (tempStreak > maxStreak) maxStreak = tempStreak;
        prevDate = d;
        
        if (i === completedDates.length - 1) {
            const diffToday = Math.round(Math.abs(new Date(today) - new Date(d)) / (1000 * 60 * 60 * 24));
            if (diffToday === 0 || diffToday === 1) {
                currentStreak = tempStreak;
            }
        }
    }
    
    document.getElementById('streak-current').textContent = currentStreak;
    document.getElementById('streak-max').textContent = maxStreak;
    document.getElementById('streak-total').textContent = totalDays;
    
    render7DayChart();
    renderCalendar();
}

function render7DayChart() {
    const container = document.getElementById('chart-7days');
    container.innerHTML = "";
    const todayObj = new Date(getLocalToday());
    
    let daysData = [];
    let maxWords = 0;
    for (let i = 6; i >= 0; i--) {
        let d = new Date(todayObj);
        d.setDate(d.getDate() - i);
        let ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        let stats = appState.history[ds] || { again: 0, hard: 0, good: 0, easy: 0 };
        let total = stats.again + stats.hard + stats.good + stats.easy;
        if (total > maxWords) maxWords = total;
        daysData.push({ date: ds, short: d.toLocaleDateString('pl-PL', {weekday: 'short'}), stats, total });
    }
    
    daysData.forEach(day => {
        const col = document.createElement('div');
        col.className = 'chart-col';
        
        let html = '';
        if (day.total > 0) {
            const pAgain = (day.stats.again / day.total) * 100;
            const pHard = (day.stats.hard / day.total) * 100;
            const pGood = (day.stats.good / day.total) * 100;
            const pEasy = (day.stats.easy / day.total) * 100;
            
            const heightPct = Math.max(15, (day.total / maxWords) * 100);
            
            html = `<div class="chart-total">${day.total}<br><span style="font-size:8px;font-weight:normal;">słów</span></div>`;
            html += `<div class="bar-wrapper" style="height: ${heightPct}%;">`;
            if(pEasy > 0) html += `<div class="bar-segment bar-easy" style="height: ${pEasy}%"></div>`;
            if(pGood > 0) html += `<div class="bar-segment bar-good" style="height: ${pGood}%"></div>`;
            if(pHard > 0) html += `<div class="bar-segment bar-hard" style="height: ${pHard}%"></div>`;
            if(pAgain > 0) html += `<div class="bar-segment bar-again" style="height: ${pAgain}%"></div>`;
            html += `</div>`;
        } else {
            html += `<div class="chart-total" style="color:transparent;">0</div>`;
            html += `<div class="bar-wrapper" style="height: 0%;"></div>`;
        }
        
        html += `<div class="chart-label">${day.short}</div>`;
        col.innerHTML = html;
        container.appendChild(col);
    });
}

let currentCalDate = new Date(getLocalToday());

function changeMonth(offset) {
    currentCalDate.setMonth(currentCalDate.getMonth() + offset);
    renderCalendar();
}

function renderCalendar() {
    const grid = document.getElementById('calendar-grid');
    grid.innerHTML = "";
    
    const year = currentCalDate.getFullYear();
    const month = currentCalDate.getMonth();
    
    const monthNames = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
    document.getElementById('calendar-month-label').textContent = `${monthNames[month]} ${year}`;
    
    const daysOfWeek = ["pon", "wt", "śr", "czw", "pt", "sob", "nd"];
    daysOfWeek.forEach(d => {
        const el = document.createElement('div');
        el.className = "cal-day-header";
        el.textContent = d;
        grid.appendChild(el);
    });
    
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    
    let startDayIndex = firstDay.getDay() - 1; 
    if (startDayIndex === -1) startDayIndex = 6;
    
    for (let i = 0; i < startDayIndex; i++) {
        const el = document.createElement('div');
        el.className = "cal-day empty";
        grid.appendChild(el);
    }
    
    for (let i = 1; i <= lastDay.getDate(); i++) {
        const el = document.createElement('div');
        el.className = "cal-day";
        el.textContent = i;
        
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(i).padStart(2,'0')}`;
        if (appState.history && appState.history[dateStr] && appState.history[dateStr].completedAll) {
            el.classList.add('completed');
        }
        grid.appendChild(el);
    }
}

function openQuickEdit(id = null) {
    let cardToEdit;
    if (id) {
        cardToEdit = appState.flashcards.find(c => c.id == id);
    } else {
        cardToEdit = currentCard; 
    }

    if (!cardToEdit) return;
    
    editingCardId = cardToEdit.id;
    document.getElementById('qe-front').value = cardToEdit.front;
    document.getElementById('qe-back').value = cardToEdit.back;
    document.getElementById('qe-example').value = cardToEdit.exampleSentence || "";
    document.getElementById('modal-quick-edit').classList.remove('hidden');
}

function saveQuickEdit() {
    if (!editingCardId) return;
    const f = document.getElementById('qe-front').value.trim();
    const b = document.getElementById('qe-back').value.trim();
    const e = document.getElementById('qe-example').value.trim();
    if(!f || !b) return alert("Wypełnij oba główne pola (Awers i Rewers)!");
    
    const idx = appState.flashcards.findIndex(x => x.id == editingCardId);
    if(idx !== -1) {
        appState.flashcards[idx].front = f;
        appState.flashcards[idx].back = b;
        appState.flashcards[idx].exampleSentence = e;
    }

    saveState();
    renderDeckTable(); 
    
    if (currentCard && currentCard.id == editingCardId) {
        currentCard.front = f;
        currentCard.back = b;
        currentCard.exampleSentence = e;
        
        document.getElementById('study-front').textContent = currentCard.front;
        
        let backHtml = `<div class="study-back-content"><div>${currentCard.back}</div>`;
        if (currentCard.exampleSentence) {
            backHtml += `<div class="example-sentence">${currentCard.exampleSentence}</div>`;
        }
        backHtml += `</div>`;
        document.getElementById('study-back').innerHTML = backHtml;
    }
    
    closeModal('modal-quick-edit');
    editingCardId = null;
}

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function exportCSV() {
    if (appState.flashcards.length === 0) return alert("Brak fiszek!");
    let content = "Awers;Rewers;Interwal\n";
    appState.flashcards.forEach(f => { content += `${f.front.replace(/;/g, ",")};${f.back.replace(/;/g, ",")};${f.interval}\n`; });
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = "korean_export.csv"; a.click();
}

function stripHTML(html) {
    if(typeof html !== 'string') return String(html || '');
    let tmp = document.createElement("DIV"); tmp.innerHTML = html; return tmp.textContent || tmp.innerText || "";
}

function parseCSV(content) {
    let count = 0;
    const lines = content.replace(/\r/g, '').split('\n');
    if (lines.length === 0) return 0;
    
    const headerCheck = lines[0].toLowerCase();
    const hasHeader = headerCheck.includes('strona') || headerCheck.includes('awers') || headerCheck.includes('poziom');
    
    lines.forEach((line, index) => {
        if (hasHeader && index === 0) return;
        if (!line.trim()) return; 
        
        let parts = line.split(';');
        if (parts.length < 2) parts = line.split('\t');
        
        if (parts.length >= 2) {
            const front = stripHTML(parts[0].replace(/^"|"$/g, '').trim());
            const back = stripHTML(parts[1].replace(/^"|"$/g, '').trim());
            if (!front || !back) return;

            let interval = 0;
            let nextReview = new Date().toISOString();
            let ef = 2.5;
            let rep = 0;

            if (parts.length >= 4) {
                const level = parts[2].replace(/^"|"$/g, '').trim();
                const nextRevStr = parts[3].replace(/^"|"$/g, '').trim();
                if (level === 'Przyswojona') { rep = 2; interval = 14; } 
                else if (level === 'W trakcie nauki' || level === 'W trakcie') { rep = 1; interval = 3; }

                if (nextRevStr && nextRevStr !== 'Brak — nowa karta' && nextRevStr.length >= 10) {
                    const dateMatch = nextRevStr.match(/\d{4}-\d{2}-\d{2}/);
                    if (dateMatch) {
                        nextReview = new Date(dateMatch[0]).toISOString();
                        const diffTime = new Date(dateMatch[0]).getTime() - new Date().getTime();
                        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                        if (diffDays > 0) interval = diffDays;
                    }
                }
            } else if (parts.length === 3) {
                const parsedInt = parseInt(parts[2].replace(/^"|"$/g, '').trim());
                if (!isNaN(parsedInt)) {
                    interval = parsedInt;
                    rep = interval > 0 ? 1 : 0;
                    if (interval > 0) {
                        let next = new Date(); next.setDate(next.getDate() + interval); nextReview = next.toISOString();
                    }
                }
            }
            if (createFlashcardData(front, back, rep, interval, ef, nextReview)) count++;
        }
    });
    return count;
}

function importCSV(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const content = e.target.result;
            let addedCards = parseCSV(content);
            if (addedCards > 0) {
                saveState(); renderDeckTable(); refreshStudySession();
                alert(`Sukces! Zaimportowano ${addedCards} fiszek.`);
            } else { alert("Nie odnaleziono fiszek. Sprawdź format CSV."); }
        } catch(err) { alert("Błąd odczytu pliku: " + err.message); }
        event.target.value = '';
    };
    reader.readAsText(file, "UTF-8");
}

// ==========================================
// TAP-TO-MATCH GAME LOGIC (Rozsypanki)
// ==========================================

let matchingChunks = [];
let currentMatchRound = 0;
let matchSelKo = null;
let matchSelPl = null;
let matchedInRound = 0;

function shuffleArray(array) {
    let curId = array.length;
    while (0 !== curId) {
        let randId = Math.floor(Math.random() * curId);
        curId -= 1;
        let tmp = array[curId];
        array[curId] = array[randId];
        array[randId] = tmp;
    }
    return array;
}

function startMatchingGame() {
    const todayStr = getLocalToday();
    if (!appState.sessionStats || appState.sessionStats.date !== todayStr || !appState.sessionStats.again) return;
    
    const hist = appState.history[todayStr] || {};
    const practiced = hist.practicedMistakes || [];

    const uniqueMistakes = Array.from(new Map(appState.sessionStats.again.map(item => [item.id, item])).values())
                                .filter(item => !practiced.includes(item.id));

    if (uniqueMistakes.length === 0) {
        alert("Nie ma już błędów do przećwiczenia na dzisiaj!");
        return;
    }

    matchingChunks = [];
    for (let i = 0; i < uniqueMistakes.length; i += 10) {
        matchingChunks.push(uniqueMistakes.slice(i, i + 10));
    }

    currentMatchRound = 0;
    document.getElementById('matching-game-view').classList.remove('hidden');
    renderMatchingRound();
}

function renderMatchingRound() {
    matchSelKo = null;
    matchSelPl = null;
    matchedInRound = 0;

    const chunk = matchingChunks[currentMatchRound];
    document.getElementById('matching-progress').textContent = `Runda ${currentMatchRound + 1} z ${matchingChunks.length}`;

    const koCol = document.getElementById('match-col-ko');
    const plCol = document.getElementById('match-col-pl');
    koCol.innerHTML = '';
    plCol.innerHTML = '';

    let koArr = shuffleArray([...chunk]);
    let plArr = shuffleArray([...chunk]);

    koArr.forEach(item => {
        const div = document.createElement('div');
        div.className = 'match-card';
        div.textContent = item.back; 
        div.onclick = () => handleMatchClick('ko', item.id, item.back, div);
        koCol.appendChild(div);
    });

    plArr.forEach(item => {
        const div = document.createElement('div');
        div.className = 'match-card';
        div.textContent = item.front; 
        div.onclick = () => handleMatchClick('pl', item.id, item.front, div);
        plCol.appendChild(div);
    });
}

function handleMatchClick(type, id, text, el) {
    if (el.classList.contains('matched')) return;

    if (type === 'ko') {
        if (matchSelKo) matchSelKo.el.classList.remove('selected');
        matchSelKo = { id, el };
        el.classList.add('selected');
        speakKorean(text);
    } else {
        if (matchSelPl) matchSelPl.el.classList.remove('selected');
        matchSelPl = { id, el };
        el.classList.add('selected');
    }

    if (matchSelKo && matchSelPl) {
        const koRef = matchSelKo;
        const plRef = matchSelPl;
        
        if (koRef.id === plRef.id) {
            if ('vibrate' in navigator) navigator.vibrate(50);
            koRef.el.classList.remove('selected');
            plRef.el.classList.remove('selected');
            koRef.el.classList.add('matched');
            plRef.el.classList.add('matched');
            matchedInRound++;
            
            matchSelKo = null;
            matchSelPl = null;

            if (matchedInRound === matchingChunks[currentMatchRound].length) {
                const todayStr = getLocalToday();
                if (!appState.history[todayStr].practicedMistakes) appState.history[todayStr].practicedMistakes = [];
                
                const chunkIds = matchingChunks[currentMatchRound].map(item => item.id);
                appState.history[todayStr].practicedMistakes.push(...chunkIds);
                saveState();

                setTimeout(() => {
                    currentMatchRound++;
                    if (currentMatchRound < matchingChunks.length) {
                        renderMatchingRound();
                    } else {
                        alert("Świetna robota! Przećwiczyłeś wszystkie dzisiejsze błędy.");
                        closeMatchingGame();
                    }
                }, 600);
            }
        } else {
            if ('vibrate' in navigator) navigator.vibrate(200);
            koRef.el.classList.remove('selected');
            plRef.el.classList.remove('selected');
            
            koRef.el.classList.add('error');
            plRef.el.classList.add('error');
            
            matchSelKo = null;
            matchSelPl = null;

            setTimeout(() => {
                koRef.el.classList.remove('error');
                plRef.el.classList.remove('error');
            }, 400);
        }
    }
}

function speakKorean(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel(); 
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ko-KR';
        window.speechSynthesis.speak(u);
    }
}

function closeMatchingGame() {
    document.getElementById('matching-game-view').classList.add('hidden');
    matchSelKo = null;
    matchSelPl = null;
    refreshStudySession(); 
}

window.addEventListener('DOMContentLoaded', () => {
    loadState();
    const hmInput = document.getElementById('hard-mode-input');
    if (hmInput) {
        hmInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') checkHardMode();
        });
    }
});
