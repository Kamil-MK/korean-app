const DEFAULT_API_KEY = "";
const STORAGE_KEY = "KoreanApp_Ecosystem_V6";
const GEMINI_MODEL = "gemini-3.8-flash";

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
    grammarFlashcards: [], 
    library: [],
    grammarTree: [], 
    sessionStats: { date: "", again: [], hard: [], good: [], easy: [] },
    history: {}
};

let currentStoryId = null;
let currentStoryText = "";
let editingCardId = null;

let currentDeckType = 'vocab'; // 'vocab' | 'grammar'

let activeGrammarCatIndex = null;
let activeGrammarItemIndex = null;

// Zmienna lokalna śledząca próby w Hard Mode dla bieżącej fiszki
let currentAttempts = 0;
// Flagi blokujące podwójne kliknięcia przy zapytaniach do AI
let isGeneratingGrammar = false;
let isGeneratingStory = false;

function loadState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try { appState = { ...appState, ...JSON.parse(saved) }; } catch (e) {}
    }
    
    if (!appState.apiKey) appState.apiKey = DEFAULT_API_KEY;
    if (!appState.library) appState.library = [];
    if (!appState.history) appState.history = {};
    if (!appState.settings) appState.settings = { hardMode: false };
    if (!appState.grammarFlashcards) appState.grammarFlashcards = [];
    
    if (!appState.grammarTree || appState.grammarTree.length === 0) {
        fetch('./grammar.json')
            .then(res => res.json())
            .then(data => {
                appState.grammarTree = data;
                saveState();
                renderGrammarTab();
            })
            .catch(err => console.error("Error loading grammar:", err));
    }
    
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
    updateGrammarWidget();
    if(appState.grammarTree && appState.grammarTree.length > 0) renderGrammarTab();
    
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
        
        if (targetId === 'tab-fiszki') {
            if(currentDeckType !== 'vocab') startSession('vocab');
            else refreshStudySession();
        }
        if (targetId === 'tab-czytelnia') renderWordsTable();
        if (targetId === 'tab-aktywnosc') updateActivityStats();
        if (targetId === 'tab-gramatyka') {
            updateGrammarWidget();
            renderGrammarTab();
        }
    });
});

// --- CLOUD SYNC ---
function encodeBase64Unicode(str) { return btoa(unescape(encodeURIComponent(str))); }
function decodeBase64Unicode(str) { return decodeURIComponent(escape(atob(str))); }

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
            words: appState.words || [], 
            flashcards: appState.flashcards || [],
            grammarFlashcards: appState.grammarFlashcards || [],
            library: appState.library || [], 
            grammarTree: appState.grammarTree || [],
            history: appState.history || {}, 
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
            grammarFlashcards: appState.grammarFlashcards || [],
            library: appState.library || [],
            grammarTree: appState.grammarTree || [],
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
    } finally { loader.style.display = 'none'; }
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
            if(!appState.grammarTree) appState.grammarTree = [];
            if(!appState.grammarFlashcards) appState.grammarFlashcards = [];

            saveState();
            msg.textContent = "✅ Postępy pobrane i wczytane!";
            msg.style.color = "var(--success)";
            setTimeout(() => location.reload(), 1500);
        } else { throw new Error("Pobrany plik ma zły format."); }
    } catch (e) {
        msg.textContent = `❌ Błąd: ${e.message}`;
        msg.style.color = "var(--danger)";
    } finally { loader.style.display = 'none'; }
}

setInterval(() => { if (document.visibilityState === 'visible') silentSyncToGitHub(); }, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') silentSyncToGitHub(); });

function exportData() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState, null, 2));
    const dl = document.createElement('a'); dl.setAttribute("href", dataStr); dl.setAttribute("download", `korean_fiszki_backup_${getLocalToday()}.json`); dl.click();
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
                alert(`Pomyślnie wgrano postępy!`);
                location.reload();
            } else { alert("Nieprawidłowy format pliku z postępami."); }
        } catch (err) { alert("Błąd odczytu pliku JSON."); }
        event.target.value = '';
    };
    reader.readAsText(file);
}

// Eksport i import CSV dla słówek
window.exportCSV = function() {
    if (!appState.flashcards || appState.flashcards.length === 0) return alert("Brak fiszek do eksportu.");
    const escapeCsv = (str) => `"${String(str || '').replace(/"/g, '""')}"`;
    const rows = [["Front_PL", "Back_KO", "Example", "Interval", "Rep", "EF", "NextReview"]];
    appState.flashcards.forEach(f => {
        rows.push([
            escapeCsv(f.front),
            escapeCsv(f.back),
            escapeCsv(f.exampleSentence || ""),
            f.interval || 0,
            f.rep || 0,
            f.ef || 2.5,
            escapeCsv(f.nextReview || "")
        ]);
    });
    const csvContent = "data:text/csv;charset=utf-8,\uFEFF" + encodeURIComponent(rows.map(r => r.join(",")).join("\n"));
    const dl = document.createElement('a');
    dl.setAttribute("href", csvContent);
    dl.setAttribute("download", `korean_vocab_${getLocalToday()}.csv`);
    dl.click();
};

window.importCSV = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const lines = e.target.result.split(/\r?\n/).filter(l => l.trim() !== "");
            let added = 0;
            lines.forEach((line, idx) => {
                if (idx === 0 && line.toLowerCase().includes("front")) return;
                const cols = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g);
                if (!cols || cols.length < 2) return;
                const clean = s => s ? s.trim().replace(/^"|"$/g, '').replace(/""/g, '"') : "";
                const front = clean(cols[0]);
                const back = clean(cols[1]);
                const example = cols[2] ? clean(cols[2]) : "";
                const interval = cols[3] ? parseInt(clean(cols[3])) || 0 : 0;
                const rep = cols[4] ? parseInt(clean(cols[4])) || 0 : 0;
                const ef = cols[5] ? parseFloat(clean(cols[5])) || 2.5 : 2.5;
                const nextRev = cols[6] ? clean(cols[6]) : null;
                if (createFlashcardData(front, back, rep, interval, ef, nextRev, example, appState.flashcards)) {
                    added++;
                }
            });
            saveState();
            renderDeckTable();
            refreshStudySession();
            alert(`Zaimportowano nowych fiszek: ${added}`);
        } catch (err) {
            alert("Błąd podczas importu pliku CSV.");
        }
        event.target.value = '';
    };
    reader.readAsText(file);
};

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
    updateSettingsUI(); saveState(); alert("Klucz API usunięty z pamięci.");
}

// ==========================================
// ZOPTYMALIZOWANY KLIENT GEMINI 3.8 FLASH
// ==========================================
async function callGeminiAPI(prompt, expectJson = false) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${appState.apiKey.trim()}`;
    
    async function sendRequest(useThinkingZero) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s bezpieczny timeout

        const generationConfig = {
            temperature: expectJson ? 0.4 : 0.7,
            maxOutputTokens: expectJson ? 1200 : 2048
        };

        if (expectJson) {
            generationConfig.responseMimeType = "application/json";
        }

        // Wyłączenie ukrytych tokenów myślowych ("thinking") oszczędza limit tokenów i skraca czas odpowiedzi z 30s do ~2s
        if (useThinkingZero) {
            generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const data = await response.json();
            return { response, data };
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                throw new Error("Serwer Gemini nie odpowiedział w ciągu 30 sekund. Spróbuj ponownie za chwilę.");
            }
            throw err;
        }
    }

    // Pierwsza próba: szybka (bez marnowania tokenów na thinking)
    let { response, data } = await sendRequest(true);

    // Jeśli endpoint modelu 3.8 odrzuci parametr thinkingConfig (status 400), ponów raz bez niego
    if (response.status === 400 && data?.error?.message?.toLowerCase().includes('thinking')) {
        ({ response, data } = await sendRequest(false));
    }

    if (!response.ok) {
        if (response.status === 429) {
            throw new Error("Przekroczono darmowy limit zapytań/tokenów na minutę (429). Odczekaj ok. 60 sekund i kliknij ponownie.");
        }
        throw new Error(data.error ? data.error.message : `Błąd HTTP ${response.status}`);
    }

    // Wyciągnięcie właściwego tekstu (pomija ewentualne części thought: true)
    const parts = data.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => typeof p.text === 'string' && !p.thought) || parts[0];

    if (!textPart || !textPart.text) {
        throw new Error("Model zwrócił pustą odpowiedź.");
    }

    return textPart.text;
}

// --- CZYTELNIA I PODZAKŁADKI ---
window.switchCzytelniaTab = function(tab) {
    if (tab === 'reader') {
        document.getElementById('czytelnia-reader-container').classList.remove('hidden');
        document.getElementById('czytelnia-words-container').classList.add('hidden');
        document.getElementById('sub-tab-reader').classList.add('active');
        document.getElementById('sub-tab-words').classList.remove('active');
    } else {
        document.getElementById('czytelnia-reader-container').classList.add('hidden');
        document.getElementById('czytelnia-words-container').classList.remove('hidden');
        document.getElementById('sub-tab-reader').classList.remove('active');
        document.getElementById('sub-tab-words').classList.add('active');
        renderWordsTable();
    }
}

async function generateAIStory() {
    if (isGeneratingStory) return;
    if (!appState.apiKey || appState.apiKey.trim() === "") return alert("Podaj swój klucz Gemini API w Ustawieniach.");
    
    const loader = document.getElementById('ai-loader');
    const errorP = document.getElementById('ai-error');
    isGeneratingStory = true;
    loader.style.display = 'block'; 
    errorP.style.display = 'none';

    function shuffleArray(array) {
        let curId = array.length;
        while (0 !== curId) {
            let randId = Math.floor(Math.random() * curId);
            curId -= 1; let tmp = array[curId]; array[curId] = array[randId]; array[randId] = tmp;
        }
        return array;
    }

    const knownPool = appState.flashcards.filter(f => f.interval > 10).map(f => f.back);
    const learningPool = appState.flashcards.filter(f => f.interval <= 10).map(f => f.back);
    const sampledKnown = shuffleArray([...knownPool]).slice(0, 20);
    const sampledLearning = shuffleArray([...learningPool]).slice(0, 8);
    const knownStr = sampledKnown.join(', ');
    const learningStr = sampledLearning.join(', ');

    let forcedGrammar = [];
    if(appState.grammarTree) {
        appState.grammarTree.forEach((cat) => {
            cat.items.forEach((item) => {
                if(item.forceInStory) forcedGrammar.push(item.title);
            });
        });
    }

    let prompt = `Napisz po koreańsku wciągające opowiadanie (ok. 150-200 słów). Tematyka powinna oscylować wokół pracy w e-commerce, nowinek technologicznych, podróży lub wyzwań i rytuałów codzienności.
Użyj tych znanych słów jako bazy: [${knownStr}].
Wpleć te słowa, których uczeń aktualnie się uczy: [${learningStr}].
Wprowadź 2 ZUPEŁNIE NOWE słowa (poziom TOPIK II), których nie ma na listach i pogrub je (<b>).`;

    if (forcedGrammar.length > 0) {
        prompt += `\nKRYTYCZNE: Użyj naturalnie tych struktur gramatycznych: [${forcedGrammar.join(', ')}]. Pogrub je używając tagu <b>.`;
    }
    prompt += `\nZwróć sam tekst opowiadania w formacie HTML (paragrafy w <p>), bez żadnych komentarzy.`;

    try {
        const rawText = await callGeminiAPI(prompt, false);
        let aiText = rawText.replace(/```html/gi, '').replace(/```/g, '').trim();
        document.getElementById('custom-text').value = aiText;
        currentStoryId = null; currentStoryText = aiText;
        document.getElementById('story-title').value = "Historia " + getLocalToday();
        
        if(appState.grammarTree) {
            appState.grammarTree.forEach(cat => cat.items.forEach(item => item.forceInStory = false));
            saveState();
        }
        setupReaderContent(aiText);
    } catch (err) {
        errorP.textContent = "Błąd: " + err.message; 
        errorP.style.display = 'block';
    } finally { 
        isGeneratingStory = false;
        loader.style.display = 'none'; 
    }
}

function setupReaderContent(text) {
    document.getElementById('reader-setup').classList.add('hidden');
    document.getElementById('reader-view').classList.remove('hidden');
    document.getElementById('sumup-result').textContent = "";
    const container = document.getElementById('reader-content');
    container.innerHTML = "";
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = text;

    function processNode(node, currentContainer, isBold) {
        if (node.nodeType === Node.TEXT_NODE) {
            const words = node.nodeValue.split(/([\s]+)/);
            words.forEach(token => {
                if (/\s+/.test(token)) {
                    currentContainer.appendChild(document.createTextNode(token));
                } else if (token.length > 0) {
                    const cleanWord = token.replace(/[.,!?()\[\]"'“”]/g, '').trim();
                    const isFiszka = appState.flashcards.some(f => f.back === cleanWord || f.front === cleanWord);
                    const span = document.createElement('span');
                    span.className = 'word-span';
                    if (isFiszka) span.classList.add('known-word');
                    if (isBold) {
                        span.style.fontWeight = 'bold';
                        if (!isFiszka) span.style.color = 'var(--primary)'; 
                    }
                    span.textContent = token;
                    span.onclick = () => { if (!isFiszka) span.classList.toggle('selected'); };
                    currentContainer.appendChild(span);
                }
            });
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            let newContainer = currentContainer;
            let nextIsBold = isBold || node.tagName === 'B' || node.tagName === 'STRONG';
            if (node.tagName === 'P') {
                const p = document.createElement('p'); p.style.marginBottom = '12px';
                currentContainer.appendChild(p); newContainer = p;
            } else if (node.tagName === 'BR') { currentContainer.appendChild(document.createElement('br')); }
            node.childNodes.forEach(child => { processNode(child, newContainer, nextIsBold); });
        }
    }
    tempDiv.childNodes.forEach(child => { processNode(child, container, false); });
}

function closeReader() {
    document.getElementById('reader-view').classList.add('hidden');
    document.getElementById('reader-setup').classList.remove('hidden');
}

function startReadingCustom() {
    const text = document.getElementById('custom-text').value.trim();
    if (!text) return alert("Wklej tekst!");
    currentStoryId = null; currentStoryText = text;
    document.getElementById('story-title').value = "";
    setupReaderContent(text);
}

function sumUpWords() {
    const selected = document.querySelectorAll('.word-span.selected');
    if (selected.length === 0) return alert("Zaznacz słowa.");
    let count = 0;
    selected.forEach(span => {
        let clean = span.textContent.replace(/[.,!?()\[\]"'“”]/g, '').trim();
        if (clean && !appState.words.find(w => w.ko === clean)) {
            const wObj = { id: Date.now() + Math.random(), ko: clean, autoPl: "Ładowanie...", custom: "" };
            appState.words.push(wObj); fetchTranslation(clean, wObj.id); count++;
        }
    });
    saveState();
    document.getElementById('sumup-result').textContent = `Wyodrębniono ${count} słów!`;
    selected.forEach(s => s.classList.remove('selected'));
}

async function fetchTranslation(word, id) {
    try {
        const targetUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=pl&dt=t&q=${encodeURIComponent(word)}`;
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error("Błąd proxy");
        const proxyData = await res.json();
        const data = JSON.parse(proxyData.contents);
        let tr = data[0][0][0];
        if (!tr || tr === word) tr = "Brak tłumaczenia";
        const w = appState.words.find(item => item.id == id);
        if (w) { w.autoPl = tr; saveState(); renderWordsTable(); }
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
            <td><div style="display: flex; gap: 5px;"><button class="btn btn-primary btn-sm" style="flex: 1;" ${isAdded ? 'disabled' : ''} onclick="addWordToSRS('${w.id}')">${isAdded ? 'Dodane' : 'Fiszka'}</button><button class="btn btn-danger btn-sm" onclick="deleteWord('${w.id}')">Usuń</button></div></td>
        `;
        tbody.appendChild(tr);
    });
}
function deleteWord(id) {
    if (confirm("Usunąć to słówko z listy?")) {
        appState.words = appState.words.filter(w => w.id != id); saveState(); renderWordsTable();
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
    if (createFlashcardData(frontTranslation, w.ko, 0, 0, 2.5, null, "", appState.flashcards)) {
        saveState(); renderDeckTable(); refreshStudySession();
    }
    renderWordsTable();
    if(!document.getElementById('reader-view').classList.contains('hidden')) setupReaderContent(currentStoryText);
}

function toggleLibrary() {
    const libView = document.getElementById('library-view'); const setupView = document.getElementById('reader-setup'); const readerView = document.getElementById('reader-view');
    if (libView.classList.contains('hidden')) { readerView.classList.add('hidden'); setupView.classList.add('hidden'); libView.classList.remove('hidden'); renderLibrary(); } 
    else { libView.classList.add('hidden'); setupView.classList.remove('hidden'); }
}
function renderLibrary() {
    const list = document.getElementById('library-list'); list.innerHTML = "";
    if (!appState.library || appState.library.length === 0) { list.innerHTML = '<p class="hint text-center">Brak zapisanych historii. Wygeneruj lub wklej nową!</p>'; return; }
    appState.library.forEach(story => {
        const div = document.createElement('div'); div.className = 'library-item'; div.onclick = () => loadStoryFromLibrary(story.id);
        div.innerHTML = `<div class="flex-between"><h4>${story.title || "Bez tytułu"}</h4><button class="btn btn-danger btn-sm" onclick="deleteStory(event, '${story.id}')">Usuń</button></div><p>${story.text.substring(0, 80)}...</p>`;
        list.appendChild(div);
    });
}
function saveStoryToLibrary() {
    const title = document.getElementById('story-title').value.trim() || "Moja historia " + getLocalToday();
    if (!currentStoryText) return;
    if (currentStoryId) { const s = appState.library.find(x => x.id == currentStoryId); if(s) s.title = title; } 
    else { currentStoryId = Date.now().toString(); appState.library.push({ id: currentStoryId, title: title, text: currentStoryText }); }
    saveState(); alert("Zapisano w bibliotece!");
}
function loadStoryFromLibrary(id) {
    const story = appState.library.find(x => x.id == id); if (!story) return;
    document.getElementById('library-view').classList.add('hidden');
    currentStoryId = story.id; currentStoryText = story.text; document.getElementById('story-title').value = story.title;
    setupReaderContent(story.text);
}
function deleteStory(event, id) {
    event.stopPropagation();
    if(confirm("Usunąć tę historię z biblioteki?")) { appState.library = appState.library.filter(x => x.id != id); saveState(); renderLibrary(); }
}

// --- LOGIKA GRAMATYKI ---
function isDue(c) {
    if (!c.nextReview) return true;
    const reviewDate = new Date(c.nextReview); reviewDate.setHours(0, 0, 0, 0);
    const todayObj = new Date(); todayObj.setHours(0, 0, 0, 0);
    return reviewDate.getTime() <= todayObj.getTime();
}

window.updateGrammarWidget = function() {
    if(!appState.grammarFlashcards) return;
    const total = appState.grammarFlashcards.length;
    const mastered = appState.grammarFlashcards.filter(c => c.interval > 10).length;
    const due = appState.grammarFlashcards.filter(c => isDue(c)).length;
    
    document.getElementById('grammar-mastered-count').textContent = `${mastered} / ${total}`;
    document.getElementById('grammar-due-count').textContent = due;
    const pct = total === 0 ? 0 : (mastered / total) * 100;
    document.getElementById('grammar-progress-bar').style.width = `${pct}%`;
}

function renderGrammarTab() {
    const container = document.getElementById('grammar-list-container');
    container.innerHTML = "";
    if(!appState.grammarTree || appState.grammarTree.length === 0) return;

    const s0 = document.getElementById('filter-g0').checked;
    const s1 = document.getElementById('filter-g1').checked;
    const s2 = document.getElementById('filter-g2').checked;

    appState.grammarTree.forEach((cat, catIndex) => {
        const filteredItems = cat.items.filter(item => {
            if (item.status === 0 && s0) return true;
            if (item.status === 1 && s1) return true;
            if (item.status === 2 && s2) return true;
            return false;
        });

        if (filteredItems.length === 0) return;

        const learnedCount = cat.items.filter(i => i.status === 2).length;
        const totalCount = cat.items.length;

        const accordion = document.createElement('div');
        accordion.className = 'accordion';

        const header = document.createElement('div');
        header.className = 'accordion-header';
        header.innerHTML = `<span>${cat.category}</span> <span style="font-size: 13px; color: var(--text-light); font-weight: normal;">${learnedCount}/${totalCount}</span>`;
        
        const content = document.createElement('div');
        content.className = 'accordion-content';

        filteredItems.forEach(item => {
            const itemIndex = cat.items.findIndex(i => i.id === item.id);
            const div = document.createElement('div');
            div.className = 'grammar-item';
            div.onclick = () => openGrammarModal(catIndex, itemIndex);
            div.innerHTML = `<span class="grammar-title">${item.title} ${item.forceInStory ? '🎯' : ''}</span><span class="status-dot status-${item.status}"></span>`;
            content.appendChild(div);
        });

        header.onclick = () => content.classList.toggle('open');
        accordion.appendChild(header); accordion.appendChild(content); container.appendChild(accordion);
    });
}

function openGrammarModal(catIndex, itemIndex) {
    activeGrammarCatIndex = catIndex; activeGrammarItemIndex = itemIndex;
    const item = appState.grammarTree[catIndex].items[itemIndex];
    document.getElementById('grammar-modal-title').textContent = item.title;
    
    document.querySelectorAll('.grammar-status-buttons button').forEach(b => b.classList.remove('active'));
    document.getElementById(`g-stat-${item.status}`).classList.add('active');

    const forceBtn = document.getElementById('g-force-btn');
    if(item.forceInStory) {
        forceBtn.classList.remove('btn-outline'); forceBtn.classList.add('btn-primary'); forceBtn.textContent = "🎯 Wymuszono";
    } else {
        forceBtn.classList.remove('btn-primary'); forceBtn.classList.add('btn-outline'); forceBtn.textContent = "🎯 Wymuś w historii";
    }

    renderGrammarModalBody(item);
    document.getElementById('modal-grammar').classList.remove('hidden');
}

function renderGrammarModalBody(item) {
    const body = document.getElementById('grammar-modal-body');
    if (!item.meaning && !item.rule && (!item.examples || item.examples.length === 0)) {
        body.innerHTML = '<p class="hint text-center mt-3">Brak danych. Kliknij "Wyjaśnij z Gemini", aby pobrać lekcję.</p>';
        return;
    }
    let html = `<div class="mb-3"><b>Znaczenie:</b> ${item.meaning}</div><div class="mb-3"><b>Reguła:</b> ${item.rule}</div>`;
    if (item.examples && item.examples.length > 0) {
        html += `<h4>Przykłady:</h4>`;
        item.examples.forEach((ex, idx) => {
            html += `<div class="grammar-example-box">
                        <button class="btn btn-primary btn-add-cloze" onclick="addGrammarFlashcard(${idx})">+</button>
                        <div class="grammar-example-ko">${ex.ko}</div><div class="grammar-example-pl">${ex.pl}</div>
                     </div>`;
        });
    }
    body.innerHTML = html;
}

function setGrammarStatus(status) {
    if(activeGrammarCatIndex === null || activeGrammarItemIndex === null) return;
    appState.grammarTree[activeGrammarCatIndex].items[activeGrammarItemIndex].status = status;
    saveState();
    document.querySelectorAll('.grammar-status-buttons button').forEach(b => b.classList.remove('active'));
    document.getElementById(`g-stat-${status}`).classList.add('active');
    renderGrammarTab(); 
}

function toggleForceGrammar() {
    if(activeGrammarCatIndex === null || activeGrammarItemIndex === null) return;
    const item = appState.grammarTree[activeGrammarCatIndex].items[activeGrammarItemIndex];
    item.forceInStory = !item.forceInStory;
    saveState();
    const forceBtn = document.getElementById('g-force-btn');
    if(item.forceInStory) {
        forceBtn.classList.remove('btn-outline'); forceBtn.classList.add('btn-primary'); forceBtn.textContent = "🎯 Wymuszono";
    } else {
        forceBtn.classList.remove('btn-primary'); forceBtn.classList.add('btn-outline'); forceBtn.textContent = "🎯 Wymuś w historii";
    }
    renderGrammarTab();
}

async function explainGrammarWithGemini() {
    if (isGeneratingGrammar) return;
    if (!appState.apiKey || appState.apiKey.trim() === "") return alert("Podaj klucz Gemini API w Ustawieniach!");
    if (activeGrammarCatIndex === null || activeGrammarItemIndex === null) return;
    
    const item = appState.grammarTree[activeGrammarCatIndex].items[activeGrammarItemIndex];
    const loader = document.getElementById('grammar-ai-loader');
    const explainBtn = document.querySelector('#modal-grammar .btn-ai');
    
    isGeneratingGrammar = true;
    loader.style.display = 'block';
    if (explainBtn) {
        explainBtn.disabled = true;
        explainBtn.textContent = "⏳ Generowanie...";
    }

    const prompt = `Wytłumacz krótko po polsku gramatykę koreańską "${item.title}".
Zwróć wyłącznie czysty obiekt JSON w formacie:
{
  "meaning": "znaczenie po polsku",
  "rule": "krótka reguła tworzenia i łączenia (max 2-3 zdania)",
  "examples": [
    {
      "ko": "pełne zdanie koreańskie z użyciem struktury",
      "pl": "polskie tłumaczenie",
      "cloze_sentence": "zdanie koreańskie z luką ___ dokładnie zamiast odmienionego słowa ze strukturą",
      "cloze_answer": "dokładny fragment tekstu usunięty w luce"
    }
  ]
}
Podaj dokładnie 3 przykłady.`;

    try {
        const rawResponse = await callGeminiAPI(prompt, true);
        
        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
        const cleanJsonStr = jsonMatch ? jsonMatch[0] : rawResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanJsonStr);
        
        item.meaning = parsed.meaning || "";
        item.rule = parsed.rule || "";
        item.examples = Array.isArray(parsed.examples) ? parsed.examples : [];
        
        saveState();
        renderGrammarModalBody(item);
    } catch (err) {
        alert("Błąd Gemini: " + err.message);
    } finally {
        isGeneratingGrammar = false;
        loader.style.display = 'none';
        if (explainBtn) {
            explainBtn.disabled = false;
            explainBtn.textContent = "✨ Wyjaśnij z Gemini";
        }
    }
}

function addGrammarFlashcard(exIndex) {
    if (activeGrammarCatIndex === null || activeGrammarItemIndex === null) return;
    const item = appState.grammarTree[activeGrammarCatIndex].items[activeGrammarItemIndex];
    const ex = item.examples[exIndex];
    
    if (!appState.grammarFlashcards) appState.grammarFlashcards = [];
    
    if (createFlashcardData(ex.pl, ex.ko, 0, 0, 2.5, null, "", appState.grammarFlashcards, ex.cloze_sentence, ex.cloze_answer)) {
        saveState();
        updateGrammarWidget();
        alert("Utworzono fiszkę gramatyczną (Cloze)!");
    } else { alert("Taka fiszka już istnieje."); }
}

// --- UNIWERSALNE ZARZĄDZANIE FISZKAMI I SRS ---
function createFlashcardData(front, back, rep, interval, ef, nextReviewStr = null, exampleSentence = "", targetDeck = appState.flashcards, clozeSentence = "", clozeAnswer = "") {
    if(!front || !back || targetDeck.some(f => f.front === front && f.back === back)) return false;
    targetDeck.push({
        id: Date.now() + Math.random(),
        front: front.trim(),
        back: back.trim(),
        exampleSentence: exampleSentence.trim(),
        clozeSentence: (clozeSentence || "").trim(),
        clozeAnswer: (clozeAnswer || "").trim(),
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
    
    if (createFlashcardData(front, back, 0, 0, 2.5, null, example, appState.flashcards)) {
        saveState(); renderDeckTable(); refreshStudySession();
        document.getElementById('manual-front').value = ""; document.getElementById('manual-back').value = ""; document.getElementById('manual-example').value = "";
    } else { alert("Taka fiszka już istnieje w słówkach!"); }
}

function getActiveDeck() {
    return currentDeckType === 'grammar' ? appState.grammarFlashcards : appState.flashcards;
}

window.startSession = function(type) {
    currentDeckType = type;
    const mgmt = document.getElementById('deck-management-section');
    const title = document.getElementById('srs-session-title');
    
    if(type === 'grammar') {
        title.textContent = "Trening Gramatyki";
        if(mgmt) mgmt.classList.add('hidden');
    } else {
        title.textContent = "Sesja SRS (Słówka)";
        if(mgmt) mgmt.classList.remove('hidden');
    }
    
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    
    if(type === 'grammar') document.querySelector('.nav-btn[data-target="tab-gramatyka"]').classList.add('active');
    else document.querySelector('.nav-btn[data-target="tab-fiszki"]').classList.add('active');
    
    document.getElementById('tab-fiszki').classList.add('active');
    refreshStudySession();
}

function toggleDeckList() { document.getElementById('deck-list-container').classList.toggle('hidden'); }

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
            <td><div style="display: flex; gap: 5px;"><button class="btn btn-outline btn-sm" style="flex: 1; padding: 4px;" onclick="openQuickEdit('${f.id}')">✏️ Edytuj</button><button class="btn btn-danger btn-sm" style="flex: 1; padding: 4px;" onclick="deleteCard('${f.id}')">Usuń</button></div></td>
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

function updateStudyCounter() { document.getElementById('study-stats').textContent = `Do powtórki: ${studyQueue.length}`; }

function refreshStudySession() {
    const todayStr = getLocalToday();
    const hist = appState.history[todayStr] || { again: 0, hard: 0, good: 0, easy: 0, completedAll: false, newCardsDone: 0, practicedMistakes: [] };
    if (!appState.history[todayStr]) appState.history[todayStr] = hist;
    if (!hist.practicedMistakes) hist.practicedMistakes = [];

    const limitKey = currentDeckType === 'grammar' ? 'newGrammarDone' : 'newCardsDone';
    let newCardsDone = hist[limitKey] || 0;
    let newCardsInQueue = 0;
    
    const todayObj = new Date(); todayObj.setHours(0, 0, 0, 0); 
    const deckToStudy = getActiveDeck();
    
    studyQueue = deckToStudy.filter(c => {
        let isDue = false;
        if (!c.nextReview) { isDue = true; } else {
            const reviewDate = new Date(c.nextReview); reviewDate.setHours(0, 0, 0, 0); 
            if (reviewDate.getTime() <= todayObj.getTime()) { isDue = true; }
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
        if(currentDeckType === 'vocab') appState.history[todayStr].completedAll = true; 
        saveState();
        document.getElementById('study-empty').classList.remove('hidden');
        document.getElementById('study-active').classList.add('hidden');
        updateActivityStats();
        
        const practiceBtn = document.getElementById('btn-practice-mistakes');
        if (currentDeckType === 'vocab' && appState.sessionStats && appState.sessionStats.date === todayStr && appState.sessionStats.again && appState.sessionStats.again.length > 0) {
            const practiced = hist.practicedMistakes;
            const uniqueMistakes = Array.from(new Map(appState.sessionStats.again.map(item => [item.id, item])).values()).filter(item => !practiced.includes(item.id));
            if (uniqueMistakes.length > 0) { practiceBtn.textContent = `Przećwicz dzisiejsze błędy (${uniqueMistakes.length})`; practiceBtn.classList.remove('hidden'); } 
            else { practiceBtn.classList.add('hidden'); }
        } else { if(practiceBtn) practiceBtn.classList.add('hidden'); }
    } else {
        if(currentDeckType === 'vocab') appState.history[todayStr].completedAll = false;
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
    
    // Reset licznika prób dla nowej fiszki
    currentAttempts = 0;
    
    document.getElementById('srs-actions').classList.add('hidden');
    
    if (currentDeckType === 'grammar' && currentCard.clozeSentence) {
        // --- TRYB CLOZE (GRAMATYKA) ---
        document.getElementById('study-vocab-container').classList.add('hidden');
        document.getElementById('study-cloze-container').classList.remove('hidden');
        
        document.getElementById('cloze-hint').textContent = currentCard.front;
        
        const sentenceHtml = currentCard.clozeSentence.replace(/_+/g, '<input type="text" id="cloze-input" class="cloze-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">');
        document.getElementById('cloze-content').innerHTML = sentenceHtml;
        
        const btnCheck = document.getElementById('btn-check-cloze');
        btnCheck.textContent = "Sprawdź";
        btnCheck.className = "btn btn-primary w-100";
        btnCheck.onclick = checkCloze;
        document.getElementById('btn-give-up-cloze').classList.remove('hidden');
        
        const clozeInput = document.getElementById('cloze-input');
        if (clozeInput) {
            clozeInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') checkCloze();
            });
            setTimeout(() => clozeInput.focus(), 150);
        }
    } else {
        // --- TRYB STANDARDOWY & HARD MODE (SŁÓWKA) ---
        document.getElementById('study-cloze-container').classList.add('hidden');
        document.getElementById('study-vocab-container').classList.remove('hidden');
        
        document.getElementById('study-front').textContent = currentCard.front;
        
        let backHtml = `<div class="study-back-content"><div>${currentCard.back}</div>`;
        if (currentCard.exampleSentence) { backHtml += `<div class="example-sentence">${currentCard.exampleSentence}</div>`; }
        backHtml += `</div>`;
        document.getElementById('study-back').innerHTML = backHtml;
        
        document.getElementById('study-front').classList.remove('hidden');
        document.getElementById('study-back').classList.add('hidden');
        
        const isHardMode = appState.settings && appState.settings.hardMode;
        if (isHardMode) {
            document.getElementById('btn-show-answer').classList.add('hidden');
            document.getElementById('hard-mode-container').classList.remove('hidden');
            
            const attemptCounterEl = document.getElementById('attemptCounter');
            if (attemptCounterEl) attemptCounterEl.textContent = "Próba: 1 / 4";
            
            const hmInput = document.getElementById('hardModeInput');
            if (hmInput) {
                hmInput.value = '';
                hmInput.style.color = "";
                hmInput.classList.remove('error', 'success-input');
                hmInput.disabled = false;
            }
            
            const btnCheck = document.getElementById('btnCheckHardMode');
            if (btnCheck) {
                btnCheck.textContent = "Sprawdź";
                btnCheck.className = "btn btn-primary w-100";
                btnCheck.classList.remove('hidden');
            }
            
            const btnGiveUp = document.getElementById('btnGiveUp');
            if (btnGiveUp) btnGiveUp.classList.remove('hidden');
            
            const btnNext = document.getElementById('btnNextCard');
            if (btnNext) btnNext.classList.add('hidden');
            
            setTimeout(() => { if (hmInput) hmInput.focus(); }, 150);
        } else {
            document.getElementById('btn-show-answer').classList.remove('hidden');
            document.getElementById('hard-mode-container').classList.add('hidden');
        }
    }

    document.getElementById('time-hard').textContent = previewSM2(currentCard, 3);
    document.getElementById('time-good').textContent = previewSM2(currentCard, 4);
    document.getElementById('time-easy').textContent = previewSM2(currentCard, 5);
}

// Walidacja Cloze (Gramatyka)
window.checkCloze = function() {
    const inputEl = document.getElementById('cloze-input');
    if (!inputEl) return;
    const answerRaw = inputEl.value;
    const targetRaw = currentCard.clozeAnswer;
    
    if (!answerRaw.trim()) return;

    const normalize = str => str.replace(/\s+/g, '').toLowerCase();
    
    if (normalize(answerRaw) === normalize(targetRaw)) {
        inputEl.classList.add('success-input');
        inputEl.disabled = true;
        
        if ('vibrate' in navigator) navigator.vibrate(50);
        
        const btnCheck = document.getElementById('btn-check-cloze');
        btnCheck.textContent = "Dalej ➔";
        btnCheck.className = "btn btn-success w-100";
        btnCheck.onclick = () => processAnswer(4, true, true);
        
        document.getElementById('btn-give-up-cloze').classList.add('hidden');
        
        setTimeout(() => { processAnswer(4, true, true); }, 1000);
    } else {
        inputEl.classList.add('error');
        setTimeout(() => {
            inputEl.classList.remove('error');
            inputEl.focus();
        }, 400);
    }
}

window.giveUpCloze = function() {
    const inputEl = document.getElementById('cloze-input');
    if (!inputEl) return;
    
    inputEl.value = currentCard.clozeAnswer;
    inputEl.disabled = true;
    inputEl.style.color = "var(--danger)";
    inputEl.style.borderBottomColor = "var(--danger)";
    
    const btnCheck = document.getElementById('btn-check-cloze');
    btnCheck.textContent = "Dalej (Ucz się) ➔";
    btnCheck.className = "btn btn-danger w-100";
    btnCheck.onclick = () => processAnswer(0, true, true);
    
    document.getElementById('btn-give-up-cloze').classList.add('hidden');
    
    setTimeout(() => { processAnswer(0, true, true); }, 2000); 
}

// ==========================================
// LOGIKA HARD MODE (Maszyna Stanów i Próby)
// ==========================================
function checkHardMode() {
    const inputEl = document.getElementById('hardModeInput');
    if (!inputEl || inputEl.disabled) return;
    
    const userVal = inputEl.value.trim();
    // Ignoruj puste kliknięcia (nie nabijaj licznika prób)
    if (!userVal) return;

    currentAttempts++;
    const targetVal = currentCard.back.trim();

    if (userVal === targetVal) {
        // SCENARIUSZ A: Odpowiedź POPRAWNA
        inputEl.classList.remove('error');
        inputEl.classList.add('success-input');
        inputEl.disabled = true;
        document.getElementById('study-back').classList.remove('hidden');

        let rating = 5;
        if (currentAttempts <= 2) {
            rating = 5; // Bardzo dobrze (Easy)
            if ('vibrate' in navigator) navigator.vibrate([30, 50, 30]);
        } else if (currentAttempts === 3) {
            rating = 4; // Dobrze (Good)
            if ('vibrate' in navigator) navigator.vibrate(50);
        } else {
            rating = 3; // Słabo (Hard) - BRAK WIBRACJI
        }

        // Zapisz wynik w SM-2 w tle (bez natychmiastowego przeładowania widoku i bez duplikowania wibracji)
        processAnswer(rating, false, true);

        // Po krótkim opóźnieniu (500 ms) załaduj kolejną fiszkę
        setTimeout(() => {
            advanceStudyView();
        }, 500);
    } else {
        // SCENARIUSZ B: Odpowiedź BŁĘDNA (Brak wibracji)
        if (currentAttempts < 4) {
            // Próby 1, 2, 3
            inputEl.classList.remove('error');
            void inputEl.offsetWidth; // Reflow dla ponownego uruchomienia animacji shake
            inputEl.classList.add('error');

            const attemptCounterEl = document.getElementById('attemptCounter');
            if (attemptCounterEl) {
                attemptCounterEl.textContent = `Próba: ${currentAttempts + 1} / 4`;
            }

            setTimeout(() => {
                inputEl.classList.remove('error');
                inputEl.focus();
                inputEl.select();
            }, 400);
        } else {
            // Spalona 4. próba
            handleHardModeFailure();
        }
    }
}

function giveUpHardMode() {
    const inputEl = document.getElementById('hardModeInput');
    if (!inputEl || inputEl.disabled) return;
    handleHardModeFailure();
}

function handleHardModeFailure() {
    const inputEl = document.getElementById('hardModeInput');
    if (inputEl) {
        inputEl.disabled = true;
        inputEl.classList.remove('error');
    }

    // Automatycznie zapisz w SM-2 ocenę Nie znam (Again = 0), ale NIE ładuj jeszcze kolejnej fiszki
    processAnswer(0, false, true);

    // Wyświetl poprawną odpowiedź oraz zdanie przykładowe (znajdujące się w #study-back)
    document.getElementById('study-back').classList.remove('hidden');

    // Ukryj przyciski "Sprawdź" oraz "Poddaję się", odkryj przycisk "Dalej" (#btnNextCard)
    document.getElementById('btnCheckHardMode').classList.add('hidden');
    document.getElementById('btnGiveUp').classList.add('hidden');
    
    const btnNext = document.getElementById('btnNextCard');
    btnNext.classList.remove('hidden');
    setTimeout(() => btnNext.focus(), 100);
}

function showAnswer() {
    document.getElementById('study-back').classList.remove('hidden');
    document.getElementById('btn-show-answer').classList.add('hidden');
    document.getElementById('srs-actions').classList.remove('hidden');
}

function previewSM2(card, quality) { let temp = { ...card }; applySM2(temp, quality); return `${temp.interval}d`; }

// Rozdzielona aktualizacja danych w SM-2 od przeładowania widoku karty
function processAnswer(quality, advanceView = true, suppressVibrate = false) {
    if (!suppressVibrate && 'vibrate' in navigator) {
        if (quality === 4) { navigator.vibrate(50); }
        else if (quality === 5) { navigator.vibrate([30, 50, 30]); }
    }

    const today = getLocalToday();
    if (!appState.sessionStats || appState.sessionStats.date !== today) { appState.sessionStats = { date: today, again: [], hard: [], good: [], easy: [] }; }
    if (!appState.history) appState.history = {};
    if (!appState.history[today]) { appState.history[today] = { again: 0, hard: 0, good: 0, easy: 0, completedAll: false, newCardsDone: 0, practicedMistakes: [] }; } 
    else if (!appState.history[today].practicedMistakes) { appState.history[today].practicedMistakes = []; }

    let cat = quality < 3 ? 'again' : (quality === 3 ? 'hard' : (quality === 4 ? 'good' : 'easy'));
    
    if(currentDeckType === 'vocab') {
        appState.sessionStats[cat].push({ ...currentCard });
        appState.history[today][cat]++; 
    }

    if (currentCard.interval === 0) {
        const limitKey = currentDeckType === 'grammar' ? 'newGrammarDone' : 'newCardsDone';
        appState.history[today][limitKey] = (appState.history[today][limitKey] || 0) + 1;
    }

    applySM2(currentCard, quality);
    studyQueue.shift(); 
    saveState(); 
    
    if(currentDeckType === 'vocab') renderDeckTable(); 
    updateGrammarWidget();
    updateStudyCounter(); 
    updateSessionProgressUI();

    if (advanceView) {
        advanceStudyView();
    }
}

function advanceStudyView() {
    const today = getLocalToday();
    if (studyQueue.length === 0) {
        if(currentDeckType === 'vocab') appState.history[today].completedAll = true;
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
    if (quality < 3) { card.rep = 0; card.interval = 1; } else {
        if (card.rep === 0) {
            if (quality === 3) card.interval = 1; else if (quality === 4) card.interval = 3; else if (quality === 5) card.interval = 5;
        } else if (card.rep === 1) {
            if (quality === 3) card.interval = 2; else if (quality === 4) card.interval = 6; else if (quality === 5) card.interval = 8;
        } else {
            card.interval = Math.round(card.interval * card.ef);
            if (quality === 3) card.interval = Math.max(1, Math.round(card.interval * 0.8)); else if (quality === 5) card.interval = Math.round(card.interval * 1.2);
        }
        card.rep++;
    }
    card.ef = Math.max(1.3, card.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    let next = new Date(); next.setDate(next.getDate() + card.interval); next.setHours(0, 0, 0, 0); card.nextReview = next.toISOString();
}

function updateSessionProgressUI() {
    if (!appState.sessionStats) return;
    const total = appState.sessionStats.again.length + appState.sessionStats.hard.length + appState.sessionStats.good.length + appState.sessionStats.easy.length;
    if (total === 0) {
        document.getElementById('prog-again').style.width = '0%'; document.getElementById('prog-hard').style.width = '0%';
        document.getElementById('prog-good').style.width = '0%'; document.getElementById('prog-easy').style.width = '0%';
        document.getElementById('prog-percent').textContent = '0'; return;
    }
    const pAgain = (appState.sessionStats.again.length / total) * 100; const pHard = (appState.sessionStats.hard.length / total) * 100;
    const pGood = (appState.sessionStats.good.length / total) * 100; const pEasy = (appState.sessionStats.easy.length / total) * 100;
    document.getElementById('prog-again').style.width = pAgain + '%'; document.getElementById('prog-hard').style.width = pHard + '%';
    document.getElementById('prog-good').style.width = pGood + '%'; document.getElementById('prog-easy').style.width = pEasy + '%';
    const successRate = ((appState.sessionStats.good.length + appState.sessionStats.easy.length) / total * 100).toFixed(0);
    document.getElementById('prog-percent').textContent = successRate;
}

function openStatsModal() {
    if (!appState.sessionStats) return;
    const container = document.getElementById('stats-details-container'); container.innerHTML = '';
    const cats = [
        { id: 'again', name: 'Złe (Nie znam)', color: 'var(--danger)', data: appState.sessionStats.again },
        { id: 'hard', name: 'Średnie (Słabo)', color: 'var(--warning)', data: appState.sessionStats.hard },
        { id: 'good', name: 'Dobre', color: '#3B82F6', data: appState.sessionStats.good },
        { id: 'easy', name: 'Bardzo Dobre', color: 'var(--success)', data: appState.sessionStats.easy }
    ];
    let html = '';
    cats.forEach(c => {
        if(c.data.length > 0) {
            html += `<h4 style="color: ${c.color}; margin-top: 10px;">${c.name} (${c.data.length})</h4><ul class="stats-list">`;
            c.data.forEach(card => { html += `<li><b>${card.front}</b> - ${card.back}</li>`; }); html += `</ul>`;
        }
    });
    if(html === '') html = '<p class="text-center hint">Brak danych w dzisiejszej sesji.</p>';
    container.innerHTML = html; document.getElementById('modal-stats').classList.remove('hidden');
}

function openQuickEdit(id = null) {
    const deck = getActiveDeck();
    let cardToEdit;
    if (id) { cardToEdit = deck.find(c => c.id == id); } else { cardToEdit = currentCard; }
    if (!cardToEdit) return;
    
    editingCardId = cardToEdit.id;
    document.getElementById('qe-front').value = cardToEdit.front;
    document.getElementById('qe-back').value = cardToEdit.back;
    
    if (currentDeckType === 'grammar') {
        document.getElementById('qe-cloze-sentence').value = cardToEdit.clozeSentence || "";
        document.getElementById('qe-cloze-answer').value = cardToEdit.clozeAnswer || "";
        document.getElementById('qe-cloze-sentence').classList.remove('hidden');
        document.getElementById('qe-cloze-answer').classList.remove('hidden');
        document.getElementById('qe-example').classList.add('hidden');
    } else {
        document.getElementById('qe-example').value = cardToEdit.exampleSentence || "";
        document.getElementById('qe-cloze-sentence').classList.add('hidden');
        document.getElementById('qe-cloze-answer').classList.add('hidden');
        document.getElementById('qe-example').classList.remove('hidden');
    }

    document.getElementById('modal-quick-edit').classList.remove('hidden');
}

function saveQuickEdit() {
    if (!editingCardId) return;
    const f = document.getElementById('qe-front').value.trim();
    const b = document.getElementById('qe-back').value.trim();
    if(!f || !b) return alert("Wypełnij oba główne pola (Awers i Rewers)!");
    
    const deck = getActiveDeck();
    const idx = deck.findIndex(x => x.id == editingCardId);
    if(idx !== -1) {
        deck[idx].front = f; 
        deck[idx].back = b; 
        if (currentDeckType === 'grammar') {
            deck[idx].clozeSentence = document.getElementById('qe-cloze-sentence').value.trim();
            deck[idx].clozeAnswer = document.getElementById('qe-cloze-answer').value.trim();
        } else {
            deck[idx].exampleSentence = document.getElementById('qe-example').value.trim();
        }
    }
    saveState(); 
    if(currentDeckType === 'vocab') renderDeckTable(); 
    
    if (currentCard && currentCard.id == editingCardId) {
        currentCard.front = f; currentCard.back = b; 
        if (currentDeckType === 'grammar') {
            currentCard.clozeSentence = document.getElementById('qe-cloze-sentence').value.trim();
            currentCard.clozeAnswer = document.getElementById('qe-cloze-answer').value.trim();
        } else {
            currentCard.exampleSentence = document.getElementById('qe-example').value.trim();
        }
        if (studyQueue[0] && studyQueue[0].id == editingCardId) {
            nextStudyCard();
        } else {
            document.getElementById('study-front').textContent = currentCard.front;
            let backHtml = `<div class="study-back-content"><div>${currentCard.back}</div>`;
            if (currentCard.exampleSentence) { backHtml += `<div class="example-sentence">${currentCard.exampleSentence}</div>`; }
            backHtml += `</div>`;
            document.getElementById('study-back').innerHTML = backHtml;
        }
    }
    closeModal('modal-quick-edit'); editingCardId = null;
}

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// --- LOGIKA AKTYWNOŚCI ---
function updateActivityStats() {
    if (!appState.history) return;
    const today = getLocalToday();
    const dates = Object.keys(appState.history).sort();
    const completedDates = dates.filter(d => appState.history[d].completedAll);
    let currentStreak = 0; let maxStreak = 0; let totalDays = completedDates.length;
    let tempStreak = 0; let prevDate = null;
    
    for (let i = 0; i < completedDates.length; i++) {
        const d = completedDates[i];
        if (!prevDate) { tempStreak = 1; } else {
            const diffTime = Math.abs(new Date(d) - new Date(prevDate));
            const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
            if (diffDays === 1) { tempStreak++; } else { tempStreak = 1; }
        }
        if (tempStreak > maxStreak) maxStreak = tempStreak; prevDate = d;
        if (i === completedDates.length - 1) {
            const diffToday = Math.round(Math.abs(new Date(today) - new Date(d)) / (1000 * 60 * 60 * 24));
            if (diffToday === 0 || diffToday === 1) { currentStreak = tempStreak; }
        }
    }
    document.getElementById('streak-current').textContent = currentStreak;
    document.getElementById('streak-max').textContent = maxStreak;
    document.getElementById('streak-total').textContent = totalDays;
    render7DayChart(); renderCalendar();
}

function render7DayChart() {
    const container = document.getElementById('chart-7days'); container.innerHTML = "";
    const todayObj = new Date(getLocalToday());
    let daysData = []; let maxWords = 0;
    for (let i = 6; i >= 0; i--) {
        let d = new Date(todayObj); d.setDate(d.getDate() - i);
        let ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        let stats = appState.history[ds] || { again: 0, hard: 0, good: 0, easy: 0 };
        let total = stats.again + stats.hard + stats.good + stats.easy;
        if (total > maxWords) maxWords = total;
        daysData.push({ date: ds, short: d.toLocaleDateString('pl-PL', {weekday: 'short'}), stats, total });
    }
    daysData.forEach(day => {
        const col = document.createElement('div'); col.className = 'chart-col'; let html = '';
        if (day.total > 0) {
            const pAgain = (day.stats.again / day.total) * 100; const pHard = (day.stats.hard / day.total) * 100;
            const pGood = (day.stats.good / day.total) * 100; const pEasy = (day.stats.easy / day.total) * 100;
            const heightPct = Math.max(15, (day.total / maxWords) * 100);
            html = `<div class="chart-total">${day.total}<br><span style="font-size:8px;font-weight:normal;">słów</span></div>`;
            html += `<div class="bar-wrapper" style="height: ${heightPct}%;">`;
            if(pEasy > 0) html += `<div class="bar-segment bar-easy" style="height: ${pEasy}%"></div>`;
            if(pGood > 0) html += `<div class="bar-segment bar-good" style="height: ${pGood}%"></div>`;
            if(pHard > 0) html += `<div class="bar-segment bar-hard" style="height: ${pHard}%"></div>`;
            if(pAgain > 0) html += `<div class="bar-segment bar-again" style="height: ${pAgain}%"></div>`;
            html += `</div>`;
        } else { html += `<div class="chart-total" style="color:transparent;">0</div><div class="bar-wrapper" style="height: 0%;"></div>`; }
        html += `<div class="chart-label">${day.short}</div>`; col.innerHTML = html; container.appendChild(col);
    });
}

let currentCalDate = new Date(getLocalToday());
function changeMonth(offset) { currentCalDate.setMonth(currentCalDate.getMonth() + offset); renderCalendar(); }
function renderCalendar() {
    const grid = document.getElementById('calendar-grid'); grid.innerHTML = "";
    const year = currentCalDate.getFullYear(); const month = currentCalDate.getMonth();
    const monthNames = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
    document.getElementById('calendar-month-label').textContent = `${monthNames[month]} ${year}`;
    const daysOfWeek = ["pon", "wt", "śr", "czw", "pt", "sob", "nd"];
    daysOfWeek.forEach(d => { const el = document.createElement('div'); el.className = "cal-day-header"; el.textContent = d; grid.appendChild(el); });
    const firstDay = new Date(year, month, 1); const lastDay = new Date(year, month + 1, 0);
    let startDayIndex = firstDay.getDay() - 1; if (startDayIndex === -1) startDayIndex = 6;
    for (let i = 0; i < startDayIndex; i++) { const el = document.createElement('div'); el.className = "cal-day empty"; grid.appendChild(el); }
    for (let i = 1; i <= lastDay.getDate(); i++) {
        const el = document.createElement('div'); el.className = "cal-day"; el.textContent = i;
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(i).padStart(2,'0')}`;
        if (appState.history && appState.history[dateStr] && appState.history[dateStr].completedAll) el.classList.add('completed');
        grid.appendChild(el);
    }
}

// ==========================================
// TAP-TO-MATCH GAME LOGIC (Rozsypanki)
// ==========================================
let matchingChunks = []; let currentMatchRound = 0; let matchSelKo = null; let matchSelPl = null; let matchedInRound = 0;
function shuffleMatchArray(array) {
    let curId = array.length;
    while (0 !== curId) { let randId = Math.floor(Math.random() * curId); curId -= 1; let tmp = array[curId]; array[curId] = array[randId]; array[randId] = tmp; }
    return array;
}

function startMatchingGame() {
    const todayStr = getLocalToday();
    if (!appState.sessionStats || appState.sessionStats.date !== todayStr || !appState.sessionStats.again) return;
    const hist = appState.history[todayStr] || {}; const practiced = hist.practicedMistakes || [];
    const uniqueMistakes = Array.from(new Map(appState.sessionStats.again.map(item => [item.id, item])).values()).filter(item => !practiced.includes(item.id));
    if (uniqueMistakes.length === 0) { alert("Nie ma już błędów do przećwiczenia na dzisiaj!"); return; }
    matchingChunks = [];
    for (let i = 0; i < uniqueMistakes.length; i += 10) matchingChunks.push(uniqueMistakes.slice(i, i + 10));
    currentMatchRound = 0; document.getElementById('matching-game-view').classList.remove('hidden'); renderMatchingRound();
}

function renderMatchingRound() {
    matchSelKo = null; matchSelPl = null; matchedInRound = 0;
    const chunk = matchingChunks[currentMatchRound];
    document.getElementById('matching-progress').textContent = `Runda ${currentMatchRound + 1} z ${matchingChunks.length}`;
    const koCol = document.getElementById('match-col-ko'); const plCol = document.getElementById('match-col-pl');
    koCol.innerHTML = ''; plCol.innerHTML = '';
    let koArr = shuffleMatchArray([...chunk]); let plArr = shuffleMatchArray([...chunk]);

    koArr.forEach(item => {
        const div = document.createElement('div'); div.className = 'match-card'; div.textContent = item.back; 
        div.onclick = () => handleMatchClick('ko', item.id, item.back, div); koCol.appendChild(div);
    });
    plArr.forEach(item => {
        const div = document.createElement('div'); div.className = 'match-card'; div.textContent = item.front; 
        div.onclick = () => handleMatchClick('pl', item.id, item.front, div); plCol.appendChild(div);
    });
}

function handleMatchClick(type, id, text, el) {
    if (el.classList.contains('matched')) return;
    if (type === 'ko') {
        if (matchSelKo) matchSelKo.el.classList.remove('selected');
        matchSelKo = { id, el }; el.classList.add('selected'); speakKorean(text);
    } else {
        if (matchSelPl) matchSelPl.el.classList.remove('selected');
        matchSelPl = { id, el }; el.classList.add('selected');
    }

    if (matchSelKo && matchSelPl) {
        const koRef = matchSelKo; const plRef = matchSelPl;
        if (koRef.id === plRef.id) {
            if ('vibrate' in navigator) navigator.vibrate(50);
            koRef.el.classList.remove('selected'); plRef.el.classList.remove('selected');
            koRef.el.classList.add('matched'); plRef.el.classList.add('matched');
            matchedInRound++; matchSelKo = null; matchSelPl = null;
            if (matchedInRound === matchingChunks[currentMatchRound].length) {
                const todayStr = getLocalToday();
                if (!appState.history[todayStr].practicedMistakes) appState.history[todayStr].practicedMistakes = [];
                const chunkIds = matchingChunks[currentMatchRound].map(item => item.id);
                appState.history[todayStr].practicedMistakes.push(...chunkIds); saveState();
                setTimeout(() => {
                    currentMatchRound++;
                    if (currentMatchRound < matchingChunks.length) { renderMatchingRound(); } 
                    else { alert("Świetna robota! Przećwiczyłeś wszystkie dzisiejsze błędy."); closeMatchingGame(); }
                }, 600);
            }
        } else {
            if ('vibrate' in navigator) navigator.vibrate(200);
            koRef.el.classList.remove('selected'); plRef.el.classList.remove('selected');
            koRef.el.classList.add('error'); plRef.el.classList.add('error');
            matchSelKo = null; matchSelPl = null;
            setTimeout(() => { koRef.el.classList.remove('error'); plRef.el.classList.remove('error'); }, 400);
        }
    }
}

function speakKorean(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'ko-KR'; window.speechSynthesis.speak(u);
    }
}
function closeMatchingGame() {
    document.getElementById('matching-game-view').classList.add('hidden');
    matchSelKo = null; matchSelPl = null; refreshStudySession(); 
}

window.addEventListener('DOMContentLoaded', () => {
    loadState();
    
    // Obsługa zatwierdzania klawiszem Enter w Hard Mode
    const hmInput = document.getElementById('hardModeInput');
    if (hmInput) {
        hmInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                checkHardMode();
            }
        });
    }
});
