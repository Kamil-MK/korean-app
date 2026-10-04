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
    words: [],
    flashcards: [],
    library: [],
    sessionStats: { date: "", again: [], hard: [], good: [], easy: [] },
    history: {}
};

let currentStoryId = null;
let currentStoryText = "";

function loadState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try { appState = { ...appState, ...JSON.parse(saved) }; } catch (e) {}
    }
    if (!appState.apiKey) appState.apiKey = DEFAULT_API_KEY;
    if (!appState.library) appState.library = [];
    if (!appState.history) appState.history = {};
    
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
}

function saveSettings() {
    appState.apiKey = document.getElementById('api-key').value.trim();
    appState.ghToken = document.getElementById('gh-token').value.trim();
    appState.ghUser = document.getElementById('gh-user').value.trim();
    appState.ghRepo = document.getElementById('gh-repo').value.trim();
    appState.autoSync = document.getElementById('auto-sync').checked;
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

// --- LOKALNY BACKUP ---
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
    const isAdded = createFlashcardData(frontTranslation, w.ko, 0, 0, 2.5);
    
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
function createFlashcardData(front, back, rep, interval, ef, nextReviewStr = null) {
    if(!front || !back || appState.flashcards.some(f => f.front === front && f.back === back)) return false;
    appState.flashcards.push({
