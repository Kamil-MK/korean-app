const DEFAULT_API_KEY = "AQ.Ab8RN6JqzbNtewAjJQwtNjRqzqlXBQrRP15UiThSjuROd5TUFg";
const STORAGE_KEY = "KoreanApp_Ecosystem_State_V4";

function getLocalToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

let appState = {
    apiKey: DEFAULT_API_KEY,
    ghToken: "",
    ghUser: "",
    ghRepo: "",
    dailyLimit: 5,
    words: [],
    flashcards: [],
    library: [],
    sessionStats: { date: "", again: [], hard: [], good: [], easy: [] }
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
    
    const today = getLocalToday();
    if (!appState.sessionStats || appState.sessionStats.date !== today) {
        appState.sessionStats = { date: today, again: [], hard: [], good: [], easy: [] };
        saveState();
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
    });
});

function updateSettingsUI() {
    document.getElementById('api-key').value = appState.apiKey;
    document.getElementById('gh-token').value = appState.ghToken || "";
    document.getElementById('gh-user').value = appState.ghUser || "";
    document.getElementById('gh-repo').value = appState.ghRepo || "";
    document.getElementById('daily-limit').value = appState.dailyLimit;
}

function saveSettings() {
    appState.apiKey = document.getElementById('api-key').value.trim();
    appState.ghToken = document.getElementById('gh-token').value.trim();
    appState.ghUser = document.getElementById('gh-user').value.trim();
    appState.ghRepo = document.getElementById('gh-repo').value.trim();
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
    alert("Przywrócono domyślny klucz API AI.");
}

// --- GITHUB CLOUD SYNC ---
function encodeBase64Unicode(str) {
    return btoa(unescape(encodeURIComponent(str)));
}
function decodeBase64Unicode(str) {
    return decodeURIComponent(escape(atob(str)));
}

async function syncToGitHub() {
    if (!appState.ghToken || !appState.ghUser || !appState.ghRepo) {
        return alert("Wypełnij najpierw dane GitHub w ustawieniach!");
    }
    const msg = document.getElementById('sync-msg');
    const loader = document.getElementById('sync-loader');
    loader.style.display = 'block'; msg.textContent = "Wysyłanie..."; msg.style.color = 'var(--text-dark)';

    const url = `https://api.github.com/repos/${appState.ghUser}/${appState.ghRepo}/contents/database.json`;
    let sha = "";

    try {
        // 1. Pobierz aktualne SHA pliku (jeśli istnieje)
        const getRes = await fetch(url, { headers: { "Authorization": `token ${appState.ghToken}` } });
        if (getRes.ok) {
            const getData = await getRes.json();
            sha = getData.sha;
        }

        // 2. Wyślij zaktualizowany plik
        const body = {
            message: `Automatyczny zapis postępów z aplikacji (${getLocalToday()})`,
            content: encodeBase64Unicode(JSON.stringify(appState, null, 2))
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
    if (!appState.ghToken || !appState.ghUser || !appState.ghRepo) {
        return alert("Wypełnij najpierw dane GitHub w ustawieniach!");
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
            appState = imported;
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
        const s = appState.library.find(x => x.id === currentStoryId);
        if(s) s.title = title;
    } else {
        currentStoryId = Date.now().toString();
        appState.library.push({ id: currentStoryId, title: title, text: currentStoryText });
    }
    saveState();
    alert("Zapisano w bibliotece!");
}

function loadStoryFromLibrary(id) {
    const story = appState.library.find(x => x.id === id);
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
        appState.library = appState.library.filter(x => x.id !== id);
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
            const isFiszka = appState.flashcards.some(f => f.front === cleanWord);
            
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
    
    // Zmiana zaznaczonych na zielone (bo będą dodane)
    selected.forEach(s => {
        s.classList.remove('selected');
        // s.classList.add('known-word'); // Można dodać to, gdy użytkownik zrobi fiszkę, na razie tylko odznaczamy
    });
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
        
        const w = appState.words.find(item => item.id === id);
        if (w) { 
            w.autoPl = tr; 
            saveState(); 
            renderWordsTable(); 
        }
    } catch (e) {
        const w = appState.words.find(item => item.id === id);
        if (w) { w.autoPl = "Błąd pobierania"; saveState(); renderWordsTable(); }
    }
}

function renderWordsTable() {
    const tbody = document.getElementById('words-tbody');
    tbody.innerHTML = "";
    appState.words.forEach(w => {
        const isAdded = appState.flashcards.some(f => f.front === w.ko);
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
        appState.words = appState.words.filter(w => w.id !== id);
        saveState();
        renderWordsTable();
    }
}

function updateCustomTranslation(id, val) {
    const w = appState.words.find(item => item.id === id);
    if (w) { w.custom = val; saveState(); }
}

function addWordToSRS(id) {
    const w = appState.words.find(item => item.id === id);
    if (!w) return;
    createFlashcardData(w.ko, w.custom.trim() !== "" ? w.custom : w.autoPl, 0, 0, 2.5);
    renderWordsTable();
    // Odśwież czytelnię jeśli jest otwarta, żeby zaktualizować kolory słów
    if(!document.getElementById('reader-view').classList.contains('hidden')) {
        setupReaderContent(currentStoryText);
    }
}

// --- ZARZĄDZANIE FISZKAMI I SRS ---
function createFlashcardData(front, back, rep, interval, ef, nextReviewStr = null) {
    if(!front || !back || appState.flashcards.some(f => f.front === front)) return false;
    appState.flashcards.push({
        id: Date.now() + Math.random(),
        front: front.trim(),
        back: back.trim(),
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
    if (!front || !back) return alert("Uzupełnij pola.");
    if (createFlashcardData(front, back, 0, 0, 2.5)) {
        saveState(); renderDeckTable(); refreshStudySession();
        document.getElementById('manual-front').value = ""; document.getElementById('manual-back').value = "";
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
            <td><button class="btn btn-danger btn-sm" onclick="deleteCard('${f.id}')">Usuń</button></td>
        `;
        tbody.appendChild(tr);
    });
}

function updateCardField(id, field, val) {
    const c = appState.flashcards.find(item => item.id === id);
    if (c) { c[field] = val; saveState(); }
}

function deleteCard(id) {
    if (confirm("Usunąć fiszkę?")) {
        appState.flashcards = appState.flashcards.filter(item => item.id !== id);
        saveState(); renderDeckTable(); refreshStudySession(); renderWordsTable();
    }
}

let studyQueue = [];
let currentCard = null;

function updateStudyCounter() {
    document.getElementById('study-stats').textContent = `Do powtórki: ${studyQueue.length}`;
}

function refreshStudySession() {
    const now = new Date().toISOString();
    let newAdded = 0;
    
    studyQueue = appState.flashcards.filter(c => {
        if (!c.nextReview || c.nextReview <= now) {
            if (c.rep === 0) {
                if (newAdded >= appState.dailyLimit) return false;
                newAdded++;
            }
            return true;
        }
        return false;
    });

    studyQueue.sort((a, b) => (a.rep > 0 && b.rep === 0 ? -1 : (a.rep === 0 && b.rep > 0 ? 1 : 0)));

    updateSessionProgressUI();
    updateStudyCounter();

    if (studyQueue.length > 0) {
        document.getElementById('study-empty').classList.add('hidden');
        document.getElementById('study-active').classList.remove('hidden');
        nextStudyCard();
    } else {
        document.getElementById('study-empty').classList.remove('hidden');
        document.getElementById('study-active').classList.add('hidden');
    }
}

function nextStudyCard() {
    if (studyQueue.length === 0) { refreshStudySession(); return; }
    currentCard = studyQueue[0];
    document.getElementById('study-front').textContent = currentCard.front;
    document.getElementById('study-back').textContent = currentCard.back;
    document.getElementById('study-front').classList.remove('hidden');
    document.getElementById('study-back').classList.add('hidden');
    document.getElementById('btn-show-answer').classList.remove('hidden');
    document.getElementById('srs-actions').classList.add('hidden');
    
    document.getElementById('time-hard').textContent = previewSM2(currentCard, 3);
    document.getElementById('time-good').textContent = previewSM2(currentCard, 4);
    document.getElementById('time-easy').textContent = previewSM2(currentCard, 5);
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
    const today = getLocalToday();
    if (!appState.sessionStats || appState.sessionStats.date !== today) {
        appState.sessionStats = { date: today, again: [], hard: [], good: [], easy: [] };
    }

    let cat = quality < 3 ? 'again' : (quality === 3 ? 'hard' : (quality === 4 ? 'good' : 'easy'));
    appState.sessionStats[cat].push({ ...currentCard });

    applySM2(currentCard, quality);
    studyQueue.shift(); 
    saveState(); 
    renderDeckTable(); 
    
    updateStudyCounter();
    updateSessionProgressUI();
    nextStudyCard();
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
    let next = new Date(); next.setDate(next.getDate() + card.interval); card.nextReview = next.toISOString();
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

function openQuickEdit() {
    if (!currentCard) return;
    document.getElementById('qe-front').value = currentCard.front;
    document.getElementById('qe-back').value = currentCard.back;
    document.getElementById('modal-quick-edit').classList.remove('hidden');
}

function saveQuickEdit() {
    if (!currentCard) return;
    const f = document.getElementById('qe-front').value.trim();
    const b = document.getElementById('qe-back').value.trim();
    if(!f || !b) return alert("Wypełnij oba pola!");
    
    currentCard.front = f;
    currentCard.back = b;
    
    const idx = appState.flashcards.findIndex(x => x.id === currentCard.id);
    if(idx !== -1) appState.flashcards[idx] = currentCard;

    saveState();
    renderDeckTable(); 
    
    document.getElementById('study-front').textContent = currentCard.front;
    document.getElementById('study-back').textContent = currentCard.back; 
    
    closeModal('modal-quick-edit');
}

function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
}

function exportCSV() {
    if (appState.flashcards.length === 0) return alert("Brak fiszek!");
    let content = "Awers;Rewers;Interwal\n";
    appState.flashcards.forEach(f => {
        content += `${f.front.replace(/;/g, ",")};${f.back.replace(/;/g, ",")};${f.interval}\n`;
    });
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = "korean_export.csv"; a.click();
}

function stripHTML(html) {
    if(typeof html !== 'string') return String(html || '');
    let tmp = document.createElement("DIV");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
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
                        let next = new Date();
                        next.setDate(next.getDate() + interval);
                        nextReview = next.toISOString();
                    }
                }
            }

            if (createFlashcardData(front, back, rep, interval, ef, nextReview)) {
                count++;
            }
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
            } else {
                alert("Nie odnaleziono fiszek. Sprawdź format CSV.");
            }
        } catch(err) {
            alert("Błąd odczytu pliku: " + err.message);
        }
        event.target.value = '';
    };
    reader.readAsText(file, "UTF-8");
}

window.addEventListener('DOMContentLoaded', loadState);
