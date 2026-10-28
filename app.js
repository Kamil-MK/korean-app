const DEFAULT_API_KEY = "";
const STORAGE_KEY = "KoreanApp_Ecosystem_V6";
const CLOZE_REGEX = /\{\{([^|}]+)\|([^:}]+)(?:::([^}]+))?\}\}/g;

function getLocalToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
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
let editorMode = 'standard'; // 'standard' | 'cloze'
let currentDeckFilter = 'all'; // 'all' | 'standard' | 'cloze' | 'learning'
let pendingInboxWordId = null; // ID słówka ze skrzynki przy tworzeniu karty Cloze

let currentDeckType = 'vocab'; // 'vocab' | 'grammar'
let isIntraDayForcedSession = false;

let activeGrammarCatIndex = null;
let activeGrammarItemIndex = null;

// Zmienna lokalna śledząca próby (1-4) dla bieżącej fiszki
let currentAttempts = 0;
let isGeneratingGrammar = false;

// ==========================================
// PARSER SKŁADNI CLOZE: {{target|hint::dictForm}}
// ==========================================
function parseClozeMatches(rawSentence) {
    if (!rawSentence) return [];
    const matches = [];
    const regex = new RegExp(CLOZE_REGEX.source, 'g');
    let m;
    let idx = 0;
    while ((m = regex.exec(rawSentence)) !== null) {
        matches.push({
            index: idx++,
            fullMatch: m[0],
            target: (m[1] || "").trim(),
            hint: (m[2] || "").trim(),
            dictForm: m[3] ? m[3].trim() : ""
        });
    }
    return matches;
}

function getCompleteKoreanSentence(rawSentence) {
    if (!rawSentence) return "";
    return rawSentence.replace(CLOZE_REGEX, (match, target) => target.trim());
}

function getActiveClozeData(card) {
    const matches = parseClozeMatches(card.rawSentence);
    const activeIdx = typeof card.clozeIndex === 'number' ? card.clozeIndex : 0;
    return matches[activeIdx] || matches[0] || {
        target: card.clozeAnswer || card.back || "",
        hint: card.front || "uzupełnij",
        dictForm: ""
    };
}

// Kompatybilność wsteczna i migracja danych w locie
function migrateAndHealCards() {
    const normalizeDeck = (deck, defaultIsGrammar = false) => {
        if (!Array.isArray(deck)) return;
        deck.forEach(card => {
            if (!card.id) card.id = Date.now() + Math.random();
            
            // Konwersja dawnych fiszek gramatycznych z ___ na nowy format {{target|hint}}
            if ((defaultIsGrammar || card.clozeSentence) && !card.rawSentence) {
                card.type = 'cloze';
                const ans = (card.clozeAnswer || card.back || "").trim();
                const hintTxt = (card.front || "uzupełnij").trim();
                if (card.clozeSentence && card.clozeSentence.includes('_')) {
                    card.rawSentence = card.clozeSentence.replace(/_+/g, `{{${ans}|${hintTxt}}}`);
                } else {
                    card.rawSentence = `{{${ans}|${hintTxt}}}`;
                }
                card.fullTranslation = card.front || "";
                card.clozeIndex = 0;
                card.parentId = card.parentId || `p_${card.id}`;
            }

            if (!card.type) {
                card.type = card.rawSentence ? 'cloze' : 'standard';
            }

            if (card.type === 'cloze') {
                if (typeof card.clozeIndex !== 'number') card.clozeIndex = 0;
                if (!card.parentId) card.parentId = `p_${card.id}`;
                if (card.fullTranslation === undefined) card.fullTranslation = card.front || "";
                if (card.note === undefined) card.note = "";
                const active = getActiveClozeData(card);
                card.front = card.fullTranslation || active.hint;
                card.back = active.target;
            }

            if (typeof card.learningStep !== 'number') {
                card.learningStep = (card.interval && card.interval > 0) ? 2 : 0;
            }
            if (card.intraDayDue === undefined) {
                card.intraDayDue = null;
            }
        });
    };

    normalizeDeck(appState.flashcards, false);
    normalizeDeck(appState.grammarFlashcards, true);

    if (Array.isArray(appState.words)) {
        appState.words.forEach(w => {
            if (w.dictForm === undefined) w.dictForm = w.ko || "";
            if (w.contextSentence === undefined) w.contextSentence = "";
            if (w.autoPl === "Błąd pobierania" || w.autoPl === "Brak tłumaczenia" || w.autoPl === "Ładowanie...") {
                w.autoPl = "";
            }
        });
    }
}

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
    if (!appState.words) appState.words = [];
    
    migrateAndHealCards();

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

            migrateAndHealCards();
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
                migrateAndHealCards();
                saveState();
                alert(`Pomyślnie wgrano postępy!`);
                location.reload();
            } else { alert("Nieprawidłowy format pliku z postępami."); }
        } catch (err) { alert("Błąd odczytu pliku JSON."); }
        event.target.value = '';
    };
    reader.readAsText(file);
}

function exportCSV() {
    let csv = "Type,Front,Back,ExampleOrRawSentence,FullTranslation,Note,Interval\n";
    appState.flashcards.forEach(c => {
        const row = [
            c.type || 'standard',
            `"${(c.front || '').replace(/"/g, '""')}"`,
            `"${(c.back || '').replace(/"/g, '""')}"`,
            `"${((c.type === 'cloze' ? c.rawSentence : c.exampleSentence) || '').replace(/"/g, '""')}"`,
            `"${(c.fullTranslation || '').replace(/"/g, '""')}"`,
            `"${(c.note || '').replace(/"/g, '""')}"`,
            c.interval || 0
        ];
        csv += row.join(",") + "\n";
    });
    const dataStr = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    const dl = document.createElement('a');
    dl.setAttribute("href", dataStr);
    dl.setAttribute("download", `fiszki_export_${getLocalToday()}.csv`);
    dl.click();
}

function importCSV(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const lines = e.target.result.split(/\r?\n/).filter(l => l.trim().length > 0);
        let added = 0;
        lines.forEach((line, idx) => {
            if (idx === 0 && line.toLowerCase().includes('front')) return;
            const parts = line.split(',');
            if (parts.length >= 2) {
                const f = parts[0].replace(/^"|"$/g, '').trim();
                const b = parts[1].replace(/^"|"$/g, '').trim();
                const ex = parts[2] ? parts[2].replace(/^"|"$/g, '').trim() : "";
                if (createFlashcardData(f, b, 0, 0, 2.5, null, ex, appState.flashcards)) added++;
            }
        });
        saveState();
        renderDeckList();
        refreshStudySession();
        alert(`Zaimportowano ${added} fiszek.`);
        event.target.value = '';
    };
    reader.readAsText(file);
}

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
// ZOPTYMALIZOWANY KLIENT GEMINI API (gemini-3.8-flash)
// ==========================================
async function callGeminiAPI(prompt, expectJson = false, customSchema = null) {
    const model = 'gemini-3.8-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${appState.apiKey.trim()}`;

    const baseGenerationConfig = {
        temperature: 0.7,
        maxOutputTokens: 2048
    };

    if (expectJson) {
        baseGenerationConfig.responseMimeType = "application/json";
        if (customSchema) {
            baseGenerationConfig.responseSchema = customSchema;
        }
    }

    const configsToTry = [
        { ...baseGenerationConfig, thinkingConfig: { thinkingBudget: 0 } },
        baseGenerationConfig
    ];

    let lastError = null;

    for (let i = 0; i < configsToTry.length; i++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        try {
            const payload = {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: configsToTry[i]
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            const data = await response.json();

            if (response.ok && data.candidates && data.candidates[0]?.content?.parts) {
                const parts = data.candidates[0].content.parts;
                const textPart = parts.find(p => p.text && !p.thought) || parts[0];
                if (textPart && textPart.text) {
                    return textPart.text;
                }
            }

            const errMsg = data.error ? data.error.message : `Kod błędu HTTP: ${response.status}`;
            if (response.status === 400 && i === 0) {
                continue;
            }
            throw new Error(errMsg);
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                lastError = new Error("Przekroczono czas oczekiwania (25s). Spróbuj ponownie za chwilę.");
                break;
            }
            lastError = err;
            if (i === 0 && err.message && err.message.includes('thinkingConfig')) {
                continue;
            }
            break;
        }
    }

    throw lastError || new Error("Nie udało się wygenerować odpowiedzi z Gemini API.");
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
    if (!appState.apiKey || appState.apiKey.trim() === "") return alert("Podaj swój klucz Gemini API w Ustawieniach.");
    const loader = document.getElementById('ai-loader');
    const errorP = document.getElementById('ai-error');
    loader.style.display = 'block'; errorP.style.display = 'none';

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
    const knownStr = sampledKnown.length > 0 ? sampledKnown.join(', ') : "brak";
    const learningStr = sampledLearning.length > 0 ? sampledLearning.join(', ') : "brak";

    let forcedGrammar = [];
    if(appState.grammarTree) {
        appState.grammarTree.forEach((cat) => {
            cat.items.forEach((item) => {
                if(item.forceInStory) forcedGrammar.push(item.title);
            });
        });
    }
    const grammarStr = forcedGrammar.length > 0 ? forcedGrammar.join(', ') : "brak (użyj naturalnych struktur średniozaawansowanych)";

    const prompt = `Jesteś native speakerem języka koreańskiego i profesjonalnym autorem tekstów edukacyjnych (poziom TOPIK II). Napisz spójne, wciągające opowiadanie po koreańsku (ok. 150-200 słów).

Lista słów do wykorzystania:
- Słowa dobrze znane: [${knownStr}]
- Słowa w trakcie nauki: [${learningStr}]
- Wymuszone struktury gramatyczne: [${grammarStr}]

KRYTYCZNE ZASADY GRAMATYCZNE I FORMATOWANIA (BEZWZGLĘDNIE PRZESTRZEGAJ):
1. Naturalna koniugacja (Odmiana): NIGDY nie zostawiaj czasowników ani przymiotników w formie słownikowej (z końcówką -다), jeśli gramatyka zdania wymaga ich odmiany! Zawsze poprawnie odrzucaj -다 i stosuj odpowiednie modyfikatory (np. dla 전달하다 określającego rzeczownik napisz 전달하는 업무, NIGDY 전달하다는 업무; dla 저렴하다 napisz 저렴한, a przy czasownikach nieregularnych stosuj poprawną wymianę rdzenia, np. 줍다 -> 주워서).
2. Bezbłędne odstępy (띄어쓰기): Przestrzegaj oficjalnych zasad koreańskiej pisowni (맞춤법). Partykuły (조사: -이/가, -을/를, -에서 itd.) oraz łącznik 이다 (-이었다/였다) ZAWSZE zapisuj łącznie z poprzedzającym rzeczownikiem, bez żadnej spacji (np. 취업 준비생이었다, 지원서를). Dwa osobne czasowniki łączone przez -아/어 zapisuj ze spacją, jeśli nie tworzą jednego wyrazu słownikowego (np. 사 입을 생각에, a nie 사입을).
3. Zakaz nawiasów: NIGDY nie powtarzaj formy podstawowej słowa w nawiasie (absolutny zakaz konstrukcji typu 창업(창업)한 czy 제안(제안)했다).
4. Inteligentne tagowanie HTML (Zamiast surowego tekstu):
- Gdy używasz słowa z listy 'dobrze znanych', owiń całą odmienioną formę wyrazu (lub rzeczownik, ale bez odrywania go spacją od partykuły) w tag: <span class="known-word" data-base="FORMA_SŁOWNIKOWA">ODMIENIONE_SŁOWO</span>.
- Przykład dla czasownika: <span class="known-word" data-base="선택하다">선택하다가</span> lub <span class="known-word" data-base="전달하다">전달하는</span>. Nie rozdzielaj czasownika od jego końcówki gramatycznej!
- Przykład dla rzeczownika z partykułą: <span class="known-word" data-base="지원서">지원서</span>를 (UWAGA: między </span> a partykułą 를 NIE MOŻE być spacji w kodzie HTML!) lub owiń całość razem z partykułą: <span class="known-word" data-base="지원서">지원서를</span>.
- Gdy używasz słowa z listy 'w trakcie nauki', użyj analogicznie klasy learning-word: <span class="learning-word" data-base="FORMA_SŁOWNIKOWA">ODMIENIONE_SŁOWO</span>.
- Wymuszone struktury gramatyczne pogrub za pomocą <b>...</b>.

Zwróć wyłącznie czysty kod HTML opowiadania (akapity w tagach <p>), bez znaczników markdown (\`\`\`html).`;

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
        errorP.textContent = "Błąd: " + err.message; errorP.style.display = 'block';
    } finally { loader.style.display = 'none'; }
}

window.generateStory = generateAIStory;

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
            const tokens = node.nodeValue.split(/(\s+)/);
            tokens.forEach(token => {
                if (/^\s+$/.test(token)) {
                    currentContainer.appendChild(document.createTextNode(token));
                } else if (token.length > 0) {
                    const span = document.createElement('span');
                    span.className = 'word-span';
                    if (isBold) {
                        span.style.fontWeight = 'bold';
                        span.style.color = 'var(--primary)';
                    }
                    span.textContent = token;
                    span.onclick = () => handleReaderWordClick(span);
                    currentContainer.appendChild(span);
                }
            });
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'SPAN' && (node.classList.contains('known-word') || node.classList.contains('learning-word'))) {
                const span = document.createElement('span');
                const isKnown = node.classList.contains('known-word');
                span.className = isKnown ? 'known-word' : 'learning-word';
                
                const baseAttr = node.getAttribute('data-base');
                if (baseAttr) {
                    span.setAttribute('data-base', baseAttr.trim());
                }
                if (isBold) {
                    span.style.fontWeight = 'bold';
                }
                span.textContent = node.textContent;
                span.onclick = () => handleReaderWordClick(span);
                currentContainer.appendChild(span);
                return;
            }

            let newContainer = currentContainer;
            let nextIsBold = isBold || node.tagName === 'B' || node.tagName === 'STRONG';
            if (node.tagName === 'P') {
                const p = document.createElement('p');
                p.style.marginBottom = '12px';
                currentContainer.appendChild(p);
                newContainer = p;
            } else if (node.tagName === 'BR') {
                currentContainer.appendChild(document.createElement('br'));
            }
            node.childNodes.forEach(child => {
                processNode(child, newContainer, nextIsBold);
            });
        }
    }

    tempDiv.childNodes.forEach(child => {
        processNode(child, container, false);
    });
}

function handleReaderWordClick(spanEl) {
    if (spanEl.classList.contains('known-word')) return;
    spanEl.classList.toggle('selected');
}

// Wycinanie pełnego zdania (od kropki do kropki) wokół klikniętego słowa w Czytelni
function extractContextSentenceFromDOM(spanEl) {
    const blockParent = spanEl.closest('p') || document.getElementById('reader-content');
    if (!blockParent) return spanEl.textContent.trim();

    const fullBlockText = blockParent.textContent.replace(/\s+/g, ' ').trim();
    const targetWord = spanEl.textContent.replace(/[.,!?()\[\]"'“”]/g, '').trim();
    
    // Podział akapitu na zdania po znakach końca zdania (. ! ? 。)
    const sentences = fullBlockText.match(/[^.!?。\n]+[.!?。]?/g) || [fullBlockText];
    for (const s of sentences) {
        if (s.includes(targetWord)) {
            return s.trim();
        }
    }
    return fullBlockText;
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
    const selected = document.querySelectorAll('#reader-content .selected');
    if (selected.length === 0) return alert("Zaznacz słowa w tekście.");
    let count = 0;
    selected.forEach(span => {
        const surfaceClean = span.textContent.replace(/[.,!?()\[\]"'“”]/g, '').trim();
        const baseAttr = span.getAttribute('data-base');
        const dictFormClean = (baseAttr ? baseAttr : surfaceClean).replace(/[.,!?()\[\]"'“”]/g, '').trim();
        const contextSentence = extractContextSentenceFromDOM(span);

        if (surfaceClean && !appState.words.find(w => w.ko === surfaceClean && w.contextSentence === contextSentence)) {
            const wObj = {
                id: Date.now() + Math.random(),
                ko: surfaceClean,
                dictForm: dictFormClean,
                contextSentence: contextSentence,
                autoPl: "",
                custom: ""
            };
            appState.words.unshift(wObj);
            fetchTranslation(dictFormClean, wObj.id);
            count++;
        }
    });
    saveState();
    document.getElementById('sumup-result').textContent = `Wyodrębniono ${count} słów wraz ze zdaniami kontekstowymi!`;
    selected.forEach(s => s.classList.remove('selected'));
    renderWordsTable();
}

async function fetchTranslation(word, id) {
    try {
        const targetUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=pl&dt=t&q=${encodeURIComponent(word)}`;
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error("Proxy error");
        const proxyData = await res.json();
        const data = JSON.parse(proxyData.contents);
        let tr = data?.[0]?.[0]?.[0] || "";
        // Jeśli proxy zwróciło to samo słowo po koreańsku lub błąd, zostawiamy czyste pole z placeholderem
        if (!tr || tr.trim() === word.trim()) tr = "";
        const w = appState.words.find(item => item.id == id);
        if (w) {
            w.autoPl = tr;
            if (!w.custom && tr) w.custom = tr;
            saveState();
            renderWordsTable();
        }
    } catch (e) {
        // Zgodnie ze specyfikacją: NIE wstawiamy "Błąd pobierania", zostawiamy czyste pole z placeholderem
        const w = appState.words.find(item => item.id == id);
        if (w) {
            w.autoPl = "";
            saveState();
            renderWordsTable();
        }
    }
}

// Wsparcie AI (przycisk ✨) w Wyłapanych Słówkach: tłumaczy słowo w kontekście zdania i ustala formę słownikową
window.translateInboxWordWithAI = async function(id, btnEl) {
    if (!appState.apiKey || appState.apiKey.trim() === "") {
        return alert("Podaj klucz Gemini API w Ustawieniach!");
    }
    const w = appState.words.find(item => item.id == id);
    if (!w) return;

    if (btnEl) btnEl.disabled = true;

    const schema = {
        type: "OBJECT",
        properties: {
            dictForm: { type: "STRING" },
            polishMeaning: { type: "STRING" }
        },
        required: ["dictForm", "polishMeaning"]
    };

    const prompt = `Przeanalizuj koreańskie słowo "${w.ko}" użyte w zdaniu: "${w.contextSentence || w.ko}".
Zwróć obiekt JSON zawierający:
- "dictForm": podstawowa forma słownikowa tego słowa po koreańsku (np. dla czasownika/przymiotnika z końcówką -다, dla rzeczownika bez partykuł),
- "polishMeaning": zwięzłe, trafne polskie znaczenie pasujące dokładnie do tego kontekstu.`;

    try {
        const raw = await callGeminiAPI(prompt, true, schema);
        const match = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(match ? match[0] : raw);
        if (parsed.dictForm) w.dictForm = parsed.dictForm.trim();
        if (parsed.polishMeaning) {
            w.custom = parsed.polishMeaning.trim();
            w.autoPl = parsed.polishMeaning.trim();
        }
        saveState();
        renderWordsTable();
    } catch (err) {
        alert("Błąd Gemini: " + err.message);
    } finally {
        if (btnEl) btnEl.disabled = false;
    }
};

// ==========================================
// CZĘŚĆ 4: PRZEPROJEKTOWANE „WYŁAPANE SŁÓWKA” (Karty .word-inbox-card bez tabeli)
// ==========================================
function renderWordsTable() {
    const listContainer = document.getElementById('words-inbox-list');
    const countBadge = document.getElementById('words-inbox-count');
    if (!listContainer) return;

    listContainer.innerHTML = "";
    if (countBadge) countBadge.textContent = appState.words.length;

    if (appState.words.length === 0) {
        listContainer.innerHTML = `<p class="hint text-center mt-2">Brak wyłapanych słówek. Kliknij nieznane słowa podczas czytania tekstu w Czytelni!</p>`;
        return;
    }

    appState.words.forEach(w => {
        const card = document.createElement('div');
        card.className = 'word-inbox-card';

        const dictVal = w.dictForm || w.ko || "";
        const plVal = (w.custom && w.custom.trim() !== "") ? w.custom : (w.autoPl || "");

        // Wyróżnienie wyłapanego słowa znacznikiem <mark> w zdaniu kontekstowym
        let highlightedContext = escapeHtml(w.contextSentence || w.ko);
        if (w.ko) {
            const safeKo = escapeHtml(w.ko).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            highlightedContext = highlightedContext.replace(new RegExp(safeKo, 'g'), `<mark>${escapeHtml(w.ko)}</mark>`);
        }

        card.innerHTML = `
            <div class="inbox-row-1">
                <span class="inbox-captured-word">${escapeHtml(w.ko)}</span>
                <input type="text" class="inbox-dict-input" value="${escapeHtml(dictVal)}" placeholder="Forma słownikowa..." onchange="updateInboxWordField('${w.id}', 'dictForm', this.value)">
                <button class="btn-icon danger" title="Usuń słówko" onclick="deleteWord('${w.id}')">🗑️</button>
            </div>
            <div class="inbox-row-2">
                <input type="text" class="inbox-pl-input" value="${escapeHtml(plVal)}" placeholder="Wpisz polskie znaczenie..." onchange="updateInboxWordField('${w.id}', 'custom', this.value)">
                <button class="btn-ai-sparkle" title="Przetłumacz w kontekście z Gemini AI" onclick="translateInboxWordWithAI('${w.id}', this)">✨</button>
            </div>
            <div class="inbox-context-box">${highlightedContext}</div>
            <div class="inbox-row-4">
                <button class="btn-inbox-action btn-inbox-std" onclick="createStandardFromInbox('${w.id}')">+ Zwykła fiszka</button>
                <button class="btn-inbox-action btn-inbox-cloze" onclick="openClozeModalFromInbox('${w.id}')">+ Fiszka Cloze</button>
            </div>
        `;
        listContainer.appendChild(card);
    });
}

window.updateInboxWordField = function(id, field, val) {
    const w = appState.words.find(item => item.id == id);
    if (w) {
        w[field] = val.trim();
        saveState();
    }
};

function deleteWord(id) {
    if (confirm("Usunąć to słówko ze skrzynki?")) {
        appState.words = appState.words.filter(w => w.id != id);
        saveState();
        renderWordsTable();
    }
}

window.createStandardFromInbox = function(id) {
    const w = appState.words.find(item => item.id == id);
    if (!w) return;
    const plMeaning = (w.custom && w.custom.trim() !== "") ? w.custom.trim() : (w.autoPl || "").trim();
    if (!plMeaning) {
        return alert("Wpisz najpierw polskie znaczenie (lub kliknij ✨, aby wygenerować je z Gemini)!");
    }
    const targetBack = (w.dictForm && w.dictForm.trim() !== "") ? w.dictForm.trim() : w.ko.trim();

    if (createFlashcardData(plMeaning, targetBack, 0, 0, 2.5, null, w.contextSentence || "", appState.flashcards)) {
        appState.words = appState.words.filter(item => item.id != id);
        saveState();
        renderWordsTable();
        renderDeckTable();
        refreshStudySession();
    } else {
        alert("Taka fiszka już istnieje w Twojej talii!");
    }
};

window.openClozeModalFromInbox = function(id) {
    const w = appState.words.find(item => item.id == id);
    if (!w) return;
    const plMeaning = (w.custom && w.custom.trim() !== "") ? w.custom.trim() : ((w.autoPl || "").trim() || "wpisz_znaczenie");
    const dictForm = (w.dictForm && w.dictForm.trim() !== "") ? w.dictForm.trim() : w.ko.trim();
    const tag = `{{${w.ko}|${plMeaning}::${dictForm}}}`;

    let rawSentence = w.contextSentence || w.ko;
    if (rawSentence.includes(w.ko)) {
        rawSentence = rawSentence.replace(w.ko, tag);
    } else {
        rawSentence = `${rawSentence} ${tag}`.trim();
    }

    pendingInboxWordId = w.id;
    openCardModal(null, 'cloze', {
        rawSentence: rawSentence,
        fullTranslation: "",
        note: ""
    });
};

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
        const plainPreview = story.text.replace(/<[^>]*>?/gm, '');
        div.innerHTML = `<div class="flex-between"><h4>${escapeHtml(story.title || "Bez tytułu")}</h4><button class="btn btn-danger btn-sm" onclick="deleteStory(event, '${story.id}')">Usuń</button></div><p>${escapeHtml(plainPreview.substring(0, 80))}...</p>`;
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

    const grammarSchema = {
        type: "OBJECT",
        properties: {
            meaning: { type: "STRING" },
            rule: { type: "STRING" },
            examples: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        ko: { type: "STRING" },
                        pl: { type: "STRING" },
                        cloze_sentence: { type: "STRING" },
                        cloze_answer: { type: "STRING" },
                        base_verb: { type: "STRING" }
                    },
                    required: ["ko", "pl", "cloze_sentence", "cloze_answer"]
                }
            }
        },
        required: ["meaning", "rule", "examples"]
    };

    const prompt = `Wytłumacz krótko po polsku gramatykę koreańską "${item.title}".
Podaj znaczenie (meaning), krótką regułę łączenia (rule) oraz dokładnie 3 przykłady (examples), gdzie:
- "ko": pełne zdanie po koreańsku,
- "pl": tłumaczenie na polski,
- "cloze_sentence": zdanie koreańskie z luką ___ w miejscu odmienionej konstrukcji gramatycznej,
- "cloze_answer": dokładne słowo/forma wycięta w miejsce ___,
- "base_verb": forma słownikowa wyciętego czasownika/przymiotnika (np. 가다).`;

    try {
        const rawResponse = await callGeminiAPI(prompt, true, grammarSchema);
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
    
    const hintText = `${item.title}${item.meaning ? ' - ' + item.meaning : ''}`;
    const dictPart = ex.base_verb ? `::${ex.base_verb}` : '';
    const rawSentence = ex.cloze_sentence.replace(/_+/g, `{{${ex.cloze_answer}|${hintText}${dictPart}}}`);

    const addedCount = createClozeFlashcardsFromRaw(rawSentence, ex.pl, `Struktura: ${item.title}. ${item.rule || ''}`, appState.grammarFlashcards);
    if (addedCount > 0) {
        saveState();
        updateGrammarWidget();
        alert("Utworzono fiszkę gramatyczną (Cloze)!");
    } else {
        alert("Taka fiszka już istnieje.");
    }
}

// ==========================================
// CZĘŚĆ 1 & 3: TWORZENIE FISZEK (STANDARD & MULTI-CLOZE) ORAZ MODAL
// ==========================================
function createFlashcardData(front, back, rep, interval, ef, nextReviewStr = null, exampleSentence = "", targetDeck = appState.flashcards) {
    if(!front || !back || targetDeck.some(f => f.type !== 'cloze' && f.front === front.trim() && f.back === back.trim())) return false;
    targetDeck.push({
        id: Date.now() + Math.random(),
        type: 'standard',
        front: front.trim(),
        back: back.trim(),
        exampleSentence: (exampleSentence || "").trim(),
        rep: rep > 0 ? rep : (interval > 0 ? 1 : 0),
        interval: interval > 0 ? interval : 0,
        ef: ef >= 1.3 ? ef : 2.5,
        learningStep: interval > 0 ? 2 : 0,
        intraDayDue: null,
        nextReview: nextReviewStr || (interval > 0 ? new Date(Date.now() + interval * 86400000).toISOString() : new Date().toISOString())
    });
    return true;
}

// Tworzy N osobnych fiszek Cloze ze wspólnym parentId dla zdania posiadającego N znaczników {{...}}
function createClozeFlashcardsFromRaw(rawSentence, fullTranslation, note = "", targetDeck = appState.flashcards) {
    const matches = parseClozeMatches(rawSentence);
    if (matches.length === 0) return 0;

    const parentId = `cloze_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let createdCount = 0;

    matches.forEach(m => {
        const exists = targetDeck.some(f => f.type === 'cloze' && f.rawSentence === rawSentence.trim() && f.clozeIndex === m.index);
        if (!exists) {
            targetDeck.push({
                id: Date.now() + Math.random() + m.index,
                type: 'cloze',
                parentId: parentId,
                clozeIndex: m.index,
                rawSentence: rawSentence.trim(),
                fullTranslation: (fullTranslation || "").trim(),
                note: (note || "").trim(),
                front: (fullTranslation || m.hint).trim(),
                back: m.target,
                rep: 0,
                interval: 0,
                ef: 2.5,
                learningStep: 0,
                intraDayDue: null,
                nextReview: new Date().toISOString()
            });
            createdCount++;
        }
    });

    return createdCount;
}

// Obsługa Modala Tworzenia / Edycji Fiszki
window.openCardModal = function(cardId = null, forcedMode = null, prefillData = null) {
    editingCardId = cardId;
    const modal = document.getElementById('modal-card-editor');
    const titleEl = document.getElementById('modal-editor-title');

    if (cardId !== null && cardId !== undefined) {
        const deck = getActiveDeck();
        const card = deck.find(c => c.id == cardId) || appState.flashcards.find(c => c.id == cardId);
        if (!card) return;

        titleEl.textContent = "Edytuj fiszkę";
        const mode = card.type === 'cloze' ? 'cloze' : 'standard';
        switchEditorMode(mode);

        if (mode === 'cloze') {
            document.getElementById('edit-cloze-raw').value = card.rawSentence || "";
            document.getElementById('edit-cloze-translation').value = card.fullTranslation || card.front || "";
            document.getElementById('edit-cloze-note').value = card.note || "";
            updateClozeLivePreview();
        } else {
            document.getElementById('edit-std-front').value = card.front || "";
            document.getElementById('edit-std-back').value = card.back || "";
            document.getElementById('edit-std-example').value = card.exampleSentence || "";
        }
    } else {
        titleEl.textContent = "Dodaj nową fiszkę";
        const mode = forcedMode || 'standard';
        switchEditorMode(mode);

        document.getElementById('edit-std-front').value = prefillData?.front || "";
        document.getElementById('edit-std-back').value = prefillData?.back || "";
        document.getElementById('edit-std-example').value = prefillData?.exampleSentence || "";

        document.getElementById('edit-cloze-raw').value = prefillData?.rawSentence || "";
        document.getElementById('edit-cloze-translation').value = prefillData?.fullTranslation || "";
        document.getElementById('edit-cloze-note').value = prefillData?.note || "";
        updateClozeLivePreview();
    }

    modal.classList.remove('hidden');
};

window.openQuickEdit = function(id = null) {
    openCardModal(id || (currentCard ? currentCard.id : null));
};

window.switchEditorMode = function(mode) {
    editorMode = mode;
    const btnStd = document.getElementById('seg-btn-standard');
    const btnCloze = document.getElementById('seg-btn-cloze');
    const viewStd = document.getElementById('editor-view-standard');
    const viewCloze = document.getElementById('editor-view-cloze');

    if (mode === 'cloze') {
        btnStd.classList.remove('active');
        btnCloze.classList.add('active');
        viewStd.classList.add('hidden');
        viewCloze.classList.remove('hidden');
        updateClozeLivePreview();
    } else {
        btnCloze.classList.remove('active');
        btnStd.classList.add('active');
        viewCloze.classList.add('hidden');
        viewStd.classList.remove('hidden');
    }
};

// Przycisk narzędziowy "{ } Zrób lukę z zaznaczenia"
window.wrapSelectionInCloze = function() {
    const textarea = document.getElementById('edit-cloze-raw');
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const selectedText = text.substring(start, end).trim() || "słowo";

    const placeholderHint = "wpisz_podpowiedź";
    const replacement = `{{${selectedText}|${placeholderHint}::${selectedText}}}`;

    textarea.value = text.substring(0, start) + replacement + text.substring(end);
    textarea.focus();

    // Zaznaczenie tekstu "wpisz_podpowiedź" do natychmiastowego nadpisania
    const hintStart = start + 2 + selectedText.length + 1;
    const hintEnd = hintStart + placeholderHint.length;
    textarea.setSelectionRange(hintStart, hintEnd);

    updateClozeLivePreview();
};

window.updateClozeLivePreview = function() {
    const raw = document.getElementById('edit-cloze-raw').value;
    const previewEl = document.getElementById('cloze-live-preview-content');
    const badgeEl = document.getElementById('cloze-count-badge');
    if (!previewEl || !badgeEl) return;

    const matches = parseClozeMatches(raw);
    badgeEl.textContent = `Wykryte luki: ${matches.length}`;

    if (!raw.trim()) {
        previewEl.innerHTML = `<span class="hint">Wpisz zdanie ze znacznikiem {{odpowiedź|podpowiedź::forma_słownikowa}}...</span>`;
        return;
    }

    const formatted = escapeHtml(raw).replace(CLOZE_REGEX, (m, target, hint, dictForm) => {
        return `<span class="cloze-pill">[ ${escapeHtml(hint.trim())} 💡 ]</span>`;
    });
    previewEl.innerHTML = formatted;
};

window.saveCardFromModal = function() {
    const targetDeck = (editingCardId && currentDeckType === 'grammar') ? appState.grammarFlashcards : appState.flashcards;

    if (editorMode === 'standard') {
        const f = document.getElementById('edit-std-front').value.trim();
        const b = document.getElementById('edit-std-back').value.trim();
        const ex = document.getElementById('edit-std-example').value.trim();

        if (!f || !b) return alert("Uzupełnij oba główne pola: Awers i Rewers!");

        if (editingCardId !== null && editingCardId !== undefined) {
            const card = appState.flashcards.find(c => c.id == editingCardId) || appState.grammarFlashcards.find(c => c.id == editingCardId);
            if (card) {
                card.type = 'standard';
                card.front = f;
                card.back = b;
                card.exampleSentence = ex;
            }
        } else {
            if (!createFlashcardData(f, b, 0, 0, 2.5, null, ex, appState.flashcards)) {
                return alert("Taka fiszka już istnieje w bazie!");
            }
        }
    } else {
        // Zapis karty / kart Cloze
        const raw = document.getElementById('edit-cloze-raw').value.trim();
        const trans = document.getElementById('edit-cloze-translation').value.trim();
        const note = document.getElementById('edit-cloze-note').value.trim();

        const matches = parseClozeMatches(raw);
        if (matches.length === 0) {
            return alert("Zdanie Cloze musi zawierać przynajmniej jeden znacznik w formacie:\n{{odpowiedź|podpowiedź::forma_słownikowa}}");
        }
        if (!trans) {
            return alert("Podaj tłumaczenie całego zdania na język polski!");
        }

        if (editingCardId !== null && editingCardId !== undefined) {
            const card = appState.flashcards.find(c => c.id == editingCardId) || appState.grammarFlashcards.find(c => c.id == editingCardId);
            if (card) {
                card.type = 'cloze';
                card.rawSentence = raw;
                card.fullTranslation = trans;
                card.note = note;
                if (card.clozeIndex >= matches.length) card.clozeIndex = 0;
                const active = getActiveClozeData(card);
                card.front = trans;
                card.back = active.target;

                // Jeśli podczas edycji użytkownik dodał nowe luki w tym samym zdaniu, utwórz brakujące karty braterskie
                if (matches.length > 1) {
                    const pid = card.parentId || `p_${card.id}`;
                    card.parentId = pid;
                    const deckRef = appState.flashcards.includes(card) ? appState.flashcards : appState.grammarFlashcards;
                    matches.forEach(m => {
                        const siblingExists = deckRef.some(s => s.parentId === pid && s.clozeIndex === m.index);
                        if (!siblingExists) {
                            deckRef.push({
                                id: Date.now() + Math.random() + m.index,
                                type: 'cloze',
                                parentId: pid,
                                clozeIndex: m.index,
                                rawSentence: raw,
                                fullTranslation: trans,
                                note: note,
                                front: trans,
                                back: m.target,
                                rep: 0,
                                interval: 0,
                                ef: 2.5,
                                learningStep: 0,
                                intraDayDue: null,
                                nextReview: new Date().toISOString()
                            });
                        } else {
                            const sib = deckRef.find(s => s.parentId === pid && s.clozeIndex === m.index);
                            if (sib) {
                                sib.rawSentence = raw;
                                sib.fullTranslation = trans;
                                sib.note = note;
                                sib.front = trans;
                                sib.back = m.target;
                            }
                        }
                    });
                }
            }
        } else {
            const count = createClozeFlashcardsFromRaw(raw, trans, note, targetDeck);
            if (count === 0) return alert("Taka karta Cloze już istnieje!");
            if (pendingInboxWordId !== null) {
                appState.words = appState.words.filter(w => w.id != pendingInboxWordId);
                pendingInboxWordId = null;
                renderWordsTable();
            }
        }
    }

    saveState();
    renderDeckList();
    updateGrammarWidget();

    if (currentCard && editingCardId && currentCard.id == editingCardId) {
        nextStudyCard();
    } else {
        refreshStudySession();
    }

    closeModal('modal-card-editor');
    editingCardId = null;
};

// ==========================================
// CZĘŚĆ 3: NOWA BAZA FISZEK (Karty .deck-card-item, Wyszukiwarka, Filtry)
// ==========================================
window.setDeckFilter = function(filter) {
    currentDeckFilter = filter;
    document.querySelectorAll('.filter-pill').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-filter') === filter);
    });
    renderDeckList();
};

function renderDeckList() {
    const listEl = document.getElementById('deck-cards-list');
    const countSpan = document.getElementById('total-cards-count');
    const searchInput = document.getElementById('searchFlashcards');
    if (!listEl) return;

    if (countSpan) countSpan.textContent = appState.flashcards.length;
    const query = (searchInput ? searchInput.value : "").trim().toLowerCase();

    const filtered = appState.flashcards.filter(card => {
        const cType = card.type || 'standard';
        if (currentDeckFilter === 'standard' && cType !== 'standard') return false;
        if (currentDeckFilter === 'cloze' && cType !== 'cloze') return false;
        if (currentDeckFilter === 'learning' && (card.interval > 10 && card.learningStep === 2)) return false;

        if (!query) return true;
        const hay = [
            card.front || "",
            card.back || "",
            card.rawSentence || "",
            card.fullTranslation || "",
            card.exampleSentence || "",
            card.note || ""
        ].join(" ").toLowerCase();
        return hay.includes(query);
    });

    listEl.innerHTML = "";

    if (filtered.length === 0) {
        listEl.innerHTML = `<p class="hint text-center mt-3">Brak fiszek spełniających kryteria wyszukiwania.</p>`;
        return;
    }

    filtered.forEach(card => {
        const item = document.createElement('div');
        item.className = 'deck-card-item';

        const isCloze = card.type === 'cloze';
        const typeLabel = isCloze ? `[CLOZE #${(card.clozeIndex || 0) + 1}]` : `[KLASYCZNA]`;
        const typeClass = isCloze ? 'tag-cloze' : 'tag-standard';
        const stepBadge = (isCloze && card.learningStep === 1) ? `<span class="interval-pill" style="background:#FEF3C7;color:#B45309;">🌙 Przed snem</span>` : '';

        let koDisplay = "";
        let plDisplay = "";

        if (isCloze) {
            const matches = parseClozeMatches(card.rawSentence);
            const activeIdx = card.clozeIndex || 0;
            let cur = 0;
            koDisplay = escapeHtml(card.rawSentence || "").replace(CLOZE_REGEX, (m, target, hint) => {
                const isThisActive = (cur === activeIdx);
                cur++;
                if (isThisActive) {
                    return `<span class="cloze-highlight">[${escapeHtml(target.trim())} | ${escapeHtml(hint.trim())}]</span>`;
                }
                return escapeHtml(target.trim());
            });
            plDisplay = escapeHtml(card.fullTranslation || card.front || "");
        } else {
            koDisplay = escapeHtml(card.back || "");
            plDisplay = escapeHtml(card.front || "");
            if (card.exampleSentence) {
                plDisplay += `<br><small style="color:var(--text-light);font-style:italic;">${escapeHtml(card.exampleSentence)}</small>`;
            }
        }

        item.innerHTML = `
            <div class="deck-card-main">
                <div class="deck-card-tags">
                    <span class="card-type-tag ${typeClass}">${typeLabel}</span>
                    <span class="interval-pill">⏱️ ${card.interval || 0}d</span>
                    ${stepBadge}
                </div>
                <div class="deck-card-ko">${koDisplay}</div>
                <div class="deck-card-pl">${plDisplay}</div>
            </div>
            <div class="deck-card-actions">
                <button class="btn-icon" title="Edytuj fiszkę" onclick="openCardModal('${card.id}')">✏️</button>
                <button class="btn-icon danger" title="Usuń fiszkę" onclick="deleteCard('${card.id}')">🗑️</button>
            </div>
        `;
        listEl.appendChild(item);
    });
}

// Alias zachowujący kompatybilność z wywołaniami w innych funkcjach
function renderDeckTable() {
    renderDeckList();
}

function toggleDeckList() {
    document.getElementById('deck-list-container').classList.toggle('hidden');
}

function deleteCard(id) {
    if (confirm("Usunąć tę fiszkę na stałe?")) {
        appState.flashcards = appState.flashcards.filter(item => item.id != id);
        appState.grammarFlashcards = appState.grammarFlashcards.filter(item => item.id != id);
        saveState();
        renderDeckList();
        refreshStudySession();
        renderWordsTable();
    }
}

function getActiveDeck() {
    return currentDeckType === 'grammar' ? appState.grammarFlashcards : appState.flashcards;
}

window.startSession = function(type) {
    currentDeckType = type;
    isIntraDayForcedSession = false;
    const mgmt = document.getElementById('deck-management-section');
    const title = document.getElementById('srs-session-title');
    
    if(type === 'grammar') {
        title.textContent = "Trening Gramatyki (Cloze)";
        if(mgmt) mgmt.classList.add('hidden');
    } else {
        title.textContent = "Sesja SRS (Słówka & Cloze)";
        if(mgmt) mgmt.classList.remove('hidden');
    }
    
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    
    if(type === 'grammar') document.querySelector('.nav-btn[data-target="tab-gramatyka"]').classList.add('active');
    else document.querySelector('.nav-btn[data-target="tab-fiszki"]').classList.add('active');
    
    document.getElementById('tab-fiszki').classList.add('active');
    refreshStudySession();
};

// ==========================================
// SIBLING BURYING & INTRA-DAY LEARNING STEP QUEUE
// ==========================================
let studyQueue = [];
let currentCard = null;

function applySiblingBurying(queue) {
    if (queue.length <= 2) return queue;
    const result = [...queue];
    for (let i = 1; i < result.length; i++) {
        const prev = result[i - 1];
        const curr = result[i];
        if (prev.parentId && curr.parentId && prev.parentId === curr.parentId) {
            // Znajdź następną kartę z innym parentId i zamień miejscami
            let swapIdx = -1;
            for (let j = i + 1; j < result.length; j++) {
                if (!result[j].parentId || result[j].parentId !== prev.parentId) {
                    swapIdx = j;
                    break;
                }
            }
            if (swapIdx !== -1) {
                const temp = result[i];
                result[i] = result[swapIdx];
                result[swapIdx] = temp;
            }
        }
    }
    return result;
}

function updateIntraDayButtons() {
    const deck = getActiveDeck();
    const intraDayCards = deck.filter(c => c.type === 'cloze' && c.learningStep === 1);
    const count = intraDayCards.length;

    const btnHeader = document.getElementById('btn-intraday-review');
    const btnEmpty = document.getElementById('btn-intraday-empty');

    if (count > 0) {
        const label = `🌙 Dzisiejsze nowe – powtórka przed snem (${count})`;
        if (btnHeader) { btnHeader.textContent = label; btnHeader.classList.remove('hidden'); }
        if (btnEmpty) { btnEmpty.textContent = label; btnEmpty.classList.remove('hidden'); }
    } else {
        if (btnHeader) btnHeader.classList.add('hidden');
        if (btnEmpty) btnEmpty.classList.add('hidden');
    }
}

window.startIntraDaySession = function() {
    isIntraDayForcedSession = true;
    refreshStudySession();
};

function updateStudyCounter() {
    document.getElementById('study-stats').textContent = `Do powtórki: ${studyQueue.length}`;
}

function refreshStudySession() {
    const todayStr = getLocalToday();
    const hist = appState.history[todayStr] || { again: 0, hard: 0, good: 0, easy: 0, completedAll: false, newCardsDone: 0, practicedMistakes: [] };
    if (!appState.history[todayStr]) appState.history[todayStr] = hist;
    if (!hist.practicedMistakes) hist.practicedMistakes = [];

    const limitKey = currentDeckType === 'grammar' ? 'newGrammarDone' : 'newCardsDone';
    let newCardsDone = hist[limitKey] || 0;
    let newCardsInQueue = 0;
    
    const nowMs = Date.now();
    const todayObj = new Date(); todayObj.setHours(0, 0, 0, 0); 
    const deckToStudy = getActiveDeck();

    if (isIntraDayForcedSession) {
        studyQueue = deckToStudy.filter(c => c.type === 'cloze' && c.learningStep === 1);
        if (studyQueue.length === 0) {
            isIntraDayForcedSession = false;
        }
    }

    if (!isIntraDayForcedSession) {
        studyQueue = deckToStudy.filter(c => {
            // Jeśli karta jest w kroku wewnątrz-dziennym (learningStep === 1), wchodzi do zwykłej kolejki dopiero gdy minie intraDayDue (3h)
            if (c.type === 'cloze' && c.learningStep === 1) {
                return c.intraDayDue && nowMs >= c.intraDayDue;
            }

            let cardDue = false;
            if (!c.nextReview) {
                cardDue = true;
            } else {
                const reviewDate = new Date(c.nextReview);
                reviewDate.setHours(0, 0, 0, 0);
                if (reviewDate.getTime() <= todayObj.getTime()) {
                    cardDue = true;
                }
            }

            if (cardDue) {
                if (c.interval === 0 && (c.learningStep === 0 || c.learningStep === undefined)) {
                    if (newCardsDone + newCardsInQueue >= appState.dailyLimit) return false;
                    newCardsInQueue++;
                }
                return true;
            }
            return false;
        });
    }

    studyQueue.sort((a, b) => (a.interval > 0 && b.interval === 0 ? -1 : (a.interval === 0 && b.interval > 0 ? 1 : 0)));
    studyQueue = applySiblingBurying(studyQueue);

    updateSessionProgressUI();
    updateStudyCounter();
    updateIntraDayButtons();

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

// ==========================================
// CZĘŚĆ 2: SESJA SRS DLA KART CLOZE (STANY A, B, C) ORAZ KART STANDARDOWYCH
// ==========================================
function nextStudyCard() {
    if (studyQueue.length === 0) {
        isIntraDayForcedSession = false;
        refreshStudySession();
        return;
    }
    currentCard = studyQueue[0];
    currentAttempts = 0;

    document.getElementById('srs-actions').classList.add('hidden');
    const badgeEl = document.getElementById('active-card-badge');

    if (currentCard.type === 'cloze' || currentDeckType === 'grammar') {
        // --- STAN A: WIDOK PYTANIA CLOZE (PRZED ROZWIĄZANIEM) ---
        if (badgeEl) {
            badgeEl.textContent = currentCard.learningStep === 1 ? "CLOZE • POWTÓRKA PRZED SNEM" : "ZDANIE CLOZE";
            badgeEl.className = "card-type-tag tag-cloze";
        }

        document.getElementById('study-vocab-container').classList.add('hidden');
        document.getElementById('study-cloze-container').classList.remove('hidden');

        renderClozeQuestionState(currentCard);
    } else {
        // --- TRYB KLASYCZNY & HARD MODE (SŁÓWKA) ---
        if (badgeEl) {
            badgeEl.textContent = "FISZKA KLASYCZNA";
            badgeEl.className = "card-type-tag tag-standard";
        }

        document.getElementById('study-cloze-container').classList.add('hidden');
        document.getElementById('study-vocab-container').classList.remove('hidden');
        
        document.getElementById('study-front').textContent = currentCard.front;
        
        let backHtml = `<div class="study-back-content"><div>${escapeHtml(currentCard.back)}</div>`;
        if (currentCard.exampleSentence) { backHtml += `<div class="example-sentence">${escapeHtml(currentCard.exampleSentence)}</div>`; }
        backHtml += `</div>`;
        document.getElementById('study-back').innerHTML = backHtml;
        
        document.getElementById('study-front').classList.remove('hidden');
        document.getElementById('study-back').classList.add('hidden');
        
        const isHardMode = appState.settings && appState.settings.hardMode;
        if (isHardMode) {
            document.getElementById('btn-show-answer').classList.add('hidden');
            document.getElementById('hard-mode-container').classList.remove('hidden');
            
            const attemptCounterEl = document.getElementById('attemptCounterStandard');
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
            
            const btnNext = document.getElementById('btnNextCardStandard');
            if (btnNext) btnNext.classList.add('hidden');
            
            setTimeout(() => { if (hmInput) hmInput.focus(); }, 120);
        } else {
            document.getElementById('btn-show-answer').classList.remove('hidden');
            document.getElementById('hard-mode-container').classList.add('hidden');
        }

        document.getElementById('time-hard').textContent = previewSM2(currentCard, 3);
        document.getElementById('time-good').textContent = previewSM2(currentCard, 4);
        document.getElementById('time-easy').textContent = previewSM2(currentCard, 5);
    }
}

// Renderowanie Stanu A dla karty Cloze (Multi-Cloze obsługuje tylko aktywny clozeIndex jako lukę)
function renderClozeQuestionState(card) {
    const activeIdx = typeof card.clozeIndex === 'number' ? card.clozeIndex : 0;
    let matchCounter = 0;

    const raw = card.rawSentence || `{{${card.back}|${card.front}}}`;
    const sentenceHtml = escapeHtml(raw).replace(CLOZE_REGEX, (full, target, hint, dictForm) => {
        const isCurrentHole = (matchCounter === activeIdx);
        matchCounter++;
        if (isCurrentHole) {
            return `<span class="cloze-pill">[ ${escapeHtml(hint.trim())} <button type="button" class="btn-cloze-hint" title="Podpowiedź" onclick="showClozeHintPopup(event)">💡</button> ]</span>`;
        }
        // Pozostałe znaczniki w tym samym zdaniu wyświetlają się jako normalny tekst koreański (kontekst)
        return escapeHtml(target.trim());
    });

    document.getElementById('cloze-sentence-display').innerHTML = sentenceHtml;

    const hintPopup = document.getElementById('cloze-hint-popup');
    hintPopup.classList.add('hidden');
    hintPopup.textContent = "";

    const transEl = document.getElementById('cloze-full-translation');
    transEl.textContent = `"${card.fullTranslation || card.front || ''}"`;

    const noteEl = document.getElementById('cloze-note-container');
    noteEl.classList.add('hidden');
    noteEl.innerHTML = "";

    const inputSection = document.getElementById('cloze-input-section');
    inputSection.classList.remove('hidden');

    const clozeInput = document.getElementById('clozeInput');
    clozeInput.value = "";
    clozeInput.disabled = false;
    clozeInput.classList.remove('error', 'success-input');

    const attemptCounter = document.getElementById('attemptCounter');
    if (attemptCounter) attemptCounter.textContent = "Próba: 1 / 4";

    const btnNext = document.getElementById('btnNextCard');
    btnNext.classList.add('hidden');

    setTimeout(() => clozeInput.focus(), 120);
}

// Kliknięcie ikony 💡 wewnątrz .cloze-pill
window.showClozeHintPopup = function(event) {
    if (event) event.stopPropagation();
    if (!currentCard) return;
    const active = getActiveClozeData(currentCard);
    const firstSyllable = active.target ? (active.target.trim().charAt(0) + '...') : '';
    const dictPart = active.dictForm ? `Forma słownikowa: ${active.dictForm} | ` : '';
    
    const popup = document.getElementById('cloze-hint-popup');
    popup.textContent = `💡 ${dictPart}Początek: "${firstSyllable}"`;
    popup.classList.remove('hidden');
    
    const clozeInput = document.getElementById('clozeInput');
    if (clozeInput && !clozeInput.disabled) clozeInput.focus();
};

// Stan B: Walidacja odpowiedzi Cloze, Automatyczny SM-2 i Haptic Feedback
window.checkCloze = function() {
    const inputEl = document.getElementById('clozeInput');
    if (!inputEl || inputEl.disabled || !currentCard) return;

    const userInput = inputEl.value.trim();
    if (!userInput) return; // Ignoruj pusty input

    currentAttempts++;
    const active = getActiveClozeData(currentCard);
    const target = active.target.trim();

    if (userInput === target) {
        // SCENARIUSZ 1: Wpisano POPRAWNIE
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

        const evaluatedCard = currentCard;
        processAnswer(rating, false, true);
        enterClozeRevealedState(evaluatedCard, false);
    } else {
        // SCENARIUSZ 2: Wpisano BŁĘDNIE (Brak wibracji)
        if (currentAttempts < 4) {
            // Próby 1, 2, 3
            inputEl.classList.remove('error');
            void inputEl.offsetWidth;
            inputEl.classList.add('error');

            const counterEl = document.getElementById('attemptCounter');
            if (counterEl) counterEl.textContent = `Próba: ${currentAttempts + 1} / 4`;

            setTimeout(() => {
                inputEl.classList.remove('error');
                inputEl.focus();
                inputEl.select();
            }, 400);
        } else {
            // Spalona 4. szansa
            const evaluatedCard = currentCard;
            processAnswer(0, false, true);
            enterClozeRevealedState(evaluatedCard, true);
        }
    }
};

window.giveUpCloze = function() {
    if (!currentCard) return;
    const evaluatedCard = currentCard;
    processAnswer(0, false, true);
    enterClozeRevealedState(evaluatedCard, true);
};

// Stan C: Widok odpowiedzi (Back – po odgadnięciu lub po porażce)
function enterClozeRevealedState(card, isFailed) {
    const activeIdx = typeof card.clozeIndex === 'number' ? card.clozeIndex : 0;
    let matchCounter = 0;

    const raw = card.rawSentence || `{{${card.back}|${card.front}}}`;
    const fullKoreanSentence = getCompleteKoreanSentence(raw);
    const safeFullSentForAttr = escapeHtml(fullKoreanSentence).replace(/'/g, "\\'");

    const sentenceHtml = escapeHtml(raw).replace(CLOZE_REGEX, (full, target, hint, dictForm) => {
        const isCurrentHole = (matchCounter === activeIdx);
        matchCounter++;
        if (isCurrentHole) {
            const dictText = dictForm ? ` (${escapeHtml(dictForm.trim())})` : '';
            const statusClass = isFailed ? 'cloze-revealed cloze-failed' : 'cloze-revealed';
            return `<span class="${statusClass}">${escapeHtml(target.trim())}${dictText} <button type="button" class="btn-tts" title="Odsłuchaj zdanie" onclick="speakKorean('${safeFullSentForAttr}')">🔊</button></span>`;
        }
        return escapeHtml(target.trim());
    });

    document.getElementById('cloze-sentence-display').innerHTML = sentenceHtml;
    document.getElementById('cloze-hint-popup').classList.add('hidden');

    // Wyświetlenie notatki jeśli istnieje
    const noteEl = document.getElementById('cloze-note-container');
    if (card.note && card.note.trim() !== "") {
        noteEl.innerHTML = `📌 <strong>Notatka:</strong> ${escapeHtml(card.note)}`;
        noteEl.classList.remove('hidden');
    } else {
        noteEl.classList.add('hidden');
    }

    // Ukryj pole input, przycisk Sprawdź, Poddaję się oraz licznik prób
    document.getElementById('cloze-input-section').classList.add('hidden');

    // Pokaż jeden duży przycisk "Dalej ➔"
    const btnNext = document.getElementById('btnNextCard');
    btnNext.classList.remove('hidden');
    setTimeout(() => btnNext.focus(), 100);

    // Auto-TTS: automatycznie odczytaj na głos całe kompletne zdanie koreańskie (rate = 0.95)
    speakKorean(fullKoreanSentence, 0.95);
}

// ==========================================
// LOGIKA HARD MODE DLA KART KLASYCZNYCH (Słówka)
// ==========================================
function checkHardMode() {
    const inputEl = document.getElementById('hardModeInput');
    if (!inputEl || inputEl.disabled) return;
    
    const userVal = inputEl.value.trim();
    if (!userVal) return;

    currentAttempts++;
    const targetVal = currentCard.back.trim();

    if (userVal === targetVal) {
        inputEl.classList.remove('error');
        inputEl.classList.add('success-input');
        inputEl.disabled = true;
        document.getElementById('study-back').classList.remove('hidden');

        let rating = 5;
        if (currentAttempts <= 2) {
            rating = 5;
            if ('vibrate' in navigator) navigator.vibrate([30, 50, 30]);
        } else if (currentAttempts === 3) {
            rating = 4;
            if ('vibrate' in navigator) navigator.vibrate(50);
        } else {
            rating = 3;
        }

        processAnswer(rating, false, true);

        setTimeout(() => {
            advanceStudyView();
        }, 500);
    } else {
        if (currentAttempts < 4) {
            inputEl.classList.remove('error');
            void inputEl.offsetWidth;
            inputEl.classList.add('error');

            const attemptCounterEl = document.getElementById('attemptCounterStandard');
            if (attemptCounterEl) {
                attemptCounterEl.textContent = `Próba: ${currentAttempts + 1} / 4`;
            }

            setTimeout(() => {
                inputEl.classList.remove('error');
                inputEl.focus();
                inputEl.select();
            }, 400);
        } else {
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

    processAnswer(0, false, true);

    document.getElementById('study-back').classList.remove('hidden');

    document.getElementById('btnCheckHardMode').classList.add('hidden');
    document.getElementById('btnGiveUp').classList.add('hidden');
    
    const btnNext = document.getElementById('btnNextCardStandard');
    btnNext.classList.remove('hidden');
    setTimeout(() => btnNext.focus(), 100);
}

function showAnswer() {
    document.getElementById('study-back').classList.remove('hidden');
    document.getElementById('btn-show-answer').classList.add('hidden');
    document.getElementById('srs-actions').classList.remove('hidden');
}

function previewSM2(card, quality) {
    let temp = { ...card };
    applySM2(temp, quality);
    return `${temp.interval}d`;
}

// ==========================================
// ALGORYTM SM-2 + INTRA-DAY LEARNING STEP
// ==========================================
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

    if (currentCard.interval === 0 && (currentCard.learningStep === 0 || currentCard.learningStep === undefined)) {
        const limitKey = currentDeckType === 'grammar' ? 'newGrammarDone' : 'newCardsDone';
        appState.history[today][limitKey] = (appState.history[today][limitKey] || 0) + 1;
    }

    applySM2(currentCard, quality);
    studyQueue.shift(); 
    saveState(); 
    
    if(currentDeckType === 'vocab') renderDeckList(); 
    updateGrammarWidget();
    updateStudyCounter(); 
    updateSessionProgressUI();
    updateIntraDayButtons();

    if (advanceView) {
        advanceStudyView();
    }
}

function advanceStudyView() {
    const today = getLocalToday();
    if (studyQueue.length === 0) {
        isIntraDayForcedSession = false;
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
    // Specjalna ścieżka Intra-day Learning Step dla kart Cloze
    if (card.type === 'cloze') {
        const step = typeof card.learningStep === 'number' ? card.learningStep : (card.interval > 0 ? 2 : 0);

        if (step === 0) {
            if (quality >= 4) {
                // Pierwsze zaliczenie pozytywne (Good lub Easy) nowej karty Cloze: wraca dzisiaj po 3h
                card.learningStep = 1;
                card.intraDayDue = Date.now() + (3 * 60 * 60 * 1000);
                card.interval = 0;
                const todayMidnight = new Date();
                todayMidnight.setHours(0, 0, 0, 0);
                card.nextReview = todayMidnight.toISOString();
                return;
            } else if (quality === 3) {
                // Słabo (4. próba): pozostaje do powtórki dzisiaj w kroku wewnątrz-dziennym
                card.learningStep = 1;
                card.intraDayDue = Date.now() + (60 * 60 * 1000);
                card.interval = 0;
                const todayMidnight = new Date();
                todayMidnight.setHours(0, 0, 0, 0);
                card.nextReview = todayMidnight.toISOString();
                return;
            } else {
                // Again (0): reset
                card.learningStep = 0;
                card.intraDayDue = null;
                card.rep = 0;
                card.interval = 1;
                let next = new Date();
                next.setHours(0, 0, 0, 0);
                card.nextReview = next.toISOString();
                return;
            }
        } else if (step === 1) {
            if (quality >= 3) {
                // Drugie zaliczenie tego samego dnia: karta przechodzi do cyklu wielodniowego SM-2 z interwałem 1d na jutro
                card.learningStep = 2;
                card.intraDayDue = null;
                card.rep = 1;
                card.interval = 1;
                let next = new Date();
                next.setDate(next.getDate() + 1);
                next.setHours(0, 0, 0, 0);
                card.nextReview = next.toISOString();
                return;
            } else {
                // Porażka na powtórce przed snem: zostaje w learningStep 1
                card.learningStep = 1;
                card.intraDayDue = Date.now() + (30 * 60 * 1000);
                return;
            }
        }
    }

    // Standardowy cykl wielodniowy SM-2
    if (quality < 3) {
        card.rep = 0;
        card.interval = 1;
    } else {
        if (card.rep === 0) {
            if (quality === 3) card.interval = 1;
            else if (quality === 4) card.interval = 3;
            else if (quality === 5) card.interval = 5;
        } else if (card.rep === 1) {
            if (quality === 3) card.interval = 2;
            else if (quality === 4) card.interval = 6;
            else if (quality === 5) card.interval = 8;
        } else {
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
            c.data.forEach(card => { html += `<li><b>${escapeHtml(card.front)}</b> - ${escapeHtml(card.back)}</li>`; }); html += `</ul>`;
        }
    });
    if(html === '') html = '<p class="text-center hint">Brak danych w dzisiejszej sesji.</p>';
    container.innerHTML = html; document.getElementById('modal-stats').classList.remove('hidden');
}

function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
    if (id === 'modal-card-editor') pendingInboxWordId = null;
}

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

window.speakKorean = function(text, rate = 0.95) {
    if ('speechSynthesis' in window && text) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ko-KR';
        u.rate = rate;
        window.speechSynthesis.speak(u);
    }
};

function closeMatchingGame() {
    document.getElementById('matching-game-view').classList.add('hidden');
    matchSelKo = null; matchSelPl = null; refreshStudySession(); 
}

window.addEventListener('DOMContentLoaded', () => {
    loadState();
    
    // Obsługa zatwierdzania klawiszem Enter w Hard Mode (Standard)
    const hmInput = document.getElementById('hardModeInput');
    if (hmInput) {
        hmInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                checkHardMode();
            }
        });
    }

    // Obsługa zatwierdzania klawiszem Enter w polu Cloze
    const clInput = document.getElementById('clozeInput');
    if (clInput) {
        clInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                checkCloze();
            }
        });
    }
});
