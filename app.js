/**
 * KOREAN SRS & AI READER (PWA) - COMPLETE APPLICATION ENGINE
 * LocalStorage Key: KoreanApp_Ecosystem_V6
 * Architecture: 100% Vanilla JS (ES6+), SM-2 + Intra-Day Cloze Engine
 */

const DEFAULT_API_KEY = "";
const STORAGE_KEY = "KoreanApp_Ecosystem_V6";
const CLOZE_REGEX = /\{\{([^|}]+)\|([^:}]+)(?:::([^}]+))?\}\}/g;

// ==========================================
// 1. NARZĘDZIA POMOCNICZE I DATY
// ==========================================
function getLocalToday() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function encodeBase64Unicode(str) {
    return btoa(unescape(encodeURIComponent(str)));
}

function decodeBase64Unicode(str) {
    return decodeURIComponent(escape(atob(str)));
}

// ==========================================
// 2. STAN GLOBALNY APLIKACJI (appState)
// ==========================================
let appState = {
    apiKey: DEFAULT_API_KEY,
    ghToken: "",
    ghUser: "",
    ghRepo: "",
    autoSync: false,
    dailyLimit: 5,
    settings: {
        hardMode: false
    },
    words: [],
    flashcards: [],
    grammarFlashcards: [],
    library: [],
    grammarTree: [],
    sessionStats: {
        date: "",
        again: [],
        hard: [],
        good: [],
        easy: []
    },
    history: {}
};

// Zmienne stanu widoków i sesji
let currentStoryId = null;
let currentStoryText = "";
let editingCardId = null;
let editorMode = 'standard'; // 'standard' | 'cloze'
let currentDeckFilter = 'all'; // 'all' | 'standard' | 'cloze' | 'learning'
let pendingInboxWordId = null;

let currentDeckType = 'vocab'; // 'vocab' | 'grammar'
let isIntraDayForcedSession = false;

let activeGrammarCatIndex = null;
let activeGrammarItemIndex = null;

let studyQueue = [];
let currentCard = null;
let currentAttempts = 0;
let isGeneratingGrammar = false;

// Zmienne gry Tap-to-Match (Rozsypanki)
let matchingChunks = [];
let currentMatchRound = 0;
let matchSelKo = null;
let matchSelPl = null;
let matchedInRound = 0;

// Zmienna kalendarza aktywności
let currentCalDate = new Date(getLocalToday());

// ==========================================
// 3. PARSER SKŁADNI CLOZE I MIGRACJA DANYCH
// ==========================================
function parseClozeMatches(rawSentence) {
    if (!rawSentence || typeof rawSentence !== 'string') return [];
    const matches = [];
    const regex = new RegExp(CLOZE_REGEX.source, 'g');
    let match;
    let index = 0;

    while ((match = regex.exec(rawSentence)) !== null) {
        matches.push({
            index: index++,
            fullMatch: match[0],
            target: (match[1] || "").trim(),
            hint: (match[2] || "").trim(),
            dictForm: match[3] ? match[3].trim() : ""
        });
    }
    return matches;
}

function getCompleteKoreanSentence(rawSentence) {
    if (!rawSentence) return "";
    return rawSentence.replace(CLOZE_REGEX, (fullMatch, target) => {
        return (target || "").trim();
    });
}

function getActiveClozeData(card) {
    if (!card) {
        return { target: "", hint: "uzupełnij", dictForm: "" };
    }
    const matches = parseClozeMatches(card.rawSentence);
    const activeIdx = typeof card.clozeIndex === 'number' ? card.clozeIndex : 0;

    if (matches[activeIdx]) {
        return matches[activeIdx];
    }
    if (matches.length > 0) {
        return matches[0];
    }
    return {
        target: (card.clozeAnswer || card.back || "").trim(),
        hint: (card.front || "uzupełnij").trim(),
        dictForm: ""
    };
}

function migrateAndHealCards() {
    const normalizeDeck = (deck, defaultIsGrammar = false) => {
        if (!Array.isArray(deck)) return;

        deck.forEach(card => {
            if (!card.id) {
                card.id = Date.now() + Math.random();
            }

            // Konwersja starszych kart gramatycznych z luką ___ na nową składnię {{odpowiedź|podpowiedź}}
            if ((defaultIsGrammar || card.clozeSentence) && !card.rawSentence) {
                card.type = 'cloze';
                const ans = (card.clozeAnswer || card.back || "").trim();
                const hintTxt = (card.front || "uzupełnij").trim();

                if (card.clozeSentence && card.clozeSentence.includes('_')) {
                    card.rawSentence = card.clozeSentence.replace(/_+/g, `{{${ans}|${hintTxt}}}`);
                } else if (card.back && card.back !== ans && card.back.includes(ans)) {
                    card.rawSentence = card.back.replace(ans, `{{${ans}|${hintTxt}}}`);
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
                if (typeof card.clozeIndex !== 'number') {
                    card.clozeIndex = 0;
                }
                if (!card.parentId) {
                    card.parentId = `p_${card.id}`;
                }
                if (card.fullTranslation === undefined) {
                    card.fullTranslation = card.front || "";
                }
                if (card.note === undefined) {
                    card.note = "";
                }
                const activeData = getActiveClozeData(card);
                card.front = card.fullTranslation || activeData.hint;
                card.back = activeData.target;
            } else {
                if (card.exampleSentence === undefined) {
                    card.exampleSentence = "";
                }
            }

            if (typeof card.interval !== 'number' || isNaN(card.interval)) {
                card.interval = 0;
            }
            if (typeof card.rep !== 'number' || isNaN(card.rep)) {
                card.rep = card.interval > 0 ? 1 : 0;
            }
            if (typeof card.ef !== 'number' || isNaN(card.ef) || card.ef < 1.3) {
                card.ef = 2.5;
            }

            // Nowe pola kroku wewnątrz-dziennego (Intra-day Learning Step)
            if (typeof card.learningStep !== 'number') {
                card.learningStep = card.interval > 0 ? 2 : 0;
            }
            if (card.intraDayDue === undefined) {
                card.intraDayDue = null;
            }
            if (!card.nextReview) {
                card.nextReview = new Date().toISOString();
            }
        });
    };

    normalizeDeck(appState.flashcards, false);
    normalizeDeck(appState.grammarFlashcards, true);

    // Czyszczenie i uzupełnianie pól w Wyłapanych Słówkach
    if (Array.isArray(appState.words)) {
        appState.words.forEach(w => {
            if (!w.id) w.id = Date.now() + Math.random();
            if (w.dictForm === undefined || w.dictForm === "") {
                w.dictForm = w.ko || "";
            }
            if (w.contextSentence === undefined) {
                w.contextSentence = "";
            }
            if (
                w.autoPl === "Błąd pobierania" ||
                w.autoPl === "Brak tłumaczenia" ||
                w.autoPl === "Ładowanie..."
            ) {
                w.autoPl = "";
            }
            if (w.custom === undefined) {
                w.custom = "";
            }
        });
    }
}

// ==========================================
// 4. INICJALIZACJA, ZAPIS STANU I NAWIGACJA
// ==========================================
function loadState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            appState = { ...appState, ...parsed };
        } catch (err) {
            console.error("Błąd parsowania stanu z localStorage:", err);
        }
    }

    if (!appState.apiKey) appState.apiKey = DEFAULT_API_KEY;
    if (!Array.isArray(appState.words)) appState.words = [];
    if (!Array.isArray(appState.flashcards)) appState.flashcards = [];
    if (!Array.isArray(appState.grammarFlashcards)) appState.grammarFlashcards = [];
    if (!Array.isArray(appState.library)) appState.library = [];
    if (!appState.history || typeof appState.history !== 'object') appState.history = {};
    if (!appState.settings || typeof appState.settings !== 'object') {
        appState.settings = { hardMode: false };
    }

    migrateAndHealCards();

    // Asynchroniczne ładowanie bazy gramatyki KGIU z grammar.json jeśli jest pusta
    if (!appState.grammarTree || appState.grammarTree.length === 0) {
        fetch('./grammar.json')
            .then(res => res.json())
            .then(data => {
                appState.grammarTree = data;
                saveState();
                renderGrammarTab();
            })
            .catch(err => console.error("Błąd ładowania pliku grammar.json:", err));
    }

    const today = getLocalToday();

    // Data Healing dla statystyk sesji i historii
    if (!appState.sessionStats || appState.sessionStats.date !== today) {
        appState.sessionStats = {
            date: today,
            again: [],
            hard: [],
            good: [],
            easy: []
        };
        saveState();
    } else {
        if (!appState.history[today]) {
            appState.history[today] = {
                again: 0,
                hard: 0,
                good: 0,
                easy: 0,
                completedAll: false,
                newCardsDone: 0,
                newGrammarDone: 0,
                practicedMistakes: []
            };
        } else if (!Array.isArray(appState.history[today].practicedMistakes)) {
            appState.history[today].practicedMistakes = [];
        }

        const hist = appState.history[today];
        const sess = appState.sessionStats;
        const totalHist = (hist.again || 0) + (hist.hard || 0) + (hist.good || 0) + (hist.easy || 0);
        const totalSess =
            (sess.again?.length || 0) +
            (sess.hard?.length || 0) +
            (sess.good?.length || 0) +
            (sess.easy?.length || 0);

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
    renderDeckList();
    updateGrammarWidget();
    if (appState.grammarTree && appState.grammarTree.length > 0) {
        renderGrammarTab();
    }
    refreshStudySession();
}

function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    } catch (err) {
        console.error("Błąd zapisu stanu do localStorage:", err);
    }
}

function setupNavigation() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

            btn.classList.add('active');
            const targetSection = document.getElementById(targetId);
            if (targetSection) {
                targetSection.classList.add('active');
            }

            if (targetId === 'tab-fiszki') {
                if (currentDeckType !== 'vocab') {
                    startSession('vocab');
                } else {
                    refreshStudySession();
                }
            } else if (targetId === 'tab-czytelnia') {
                renderWordsTable();
            } else if (targetId === 'tab-aktywnosc') {
                updateActivityStats();
            } else if (targetId === 'tab-gramatyka') {
                updateGrammarWidget();
                renderGrammarTab();
            }
        });
    });
}

// ==========================================
// 5. GITHUB CLOUD SYNC & LOKALNY BACKUP (JSON / CSV)
// ==========================================
function buildSafeStateForCloud() {
    return {
        dailyLimit: appState.dailyLimit,
        autoSync: appState.autoSync || false,
        settings: appState.settings || { hardMode: false },
        words: appState.words || [],
        flashcards: appState.flashcards || [],
        grammarFlashcards: appState.grammarFlashcards || [],
        library: appState.library || [],
        grammarTree: appState.grammarTree || [],
        history: appState.history || {},
        sessionStats: appState.sessionStats || {
            date: getLocalToday(),
            again: [],
            hard: [],
            good: [],
            easy: []
        }
    };
}

async function silentSyncToGitHub() {
    if (!appState.autoSync || !appState.ghToken || !appState.ghUser || !appState.ghRepo) {
        return;
    }

    const url = `https://api.github.com/repos/${appState.ghUser}/${appState.ghRepo}/contents/database.json`;
    try {
        let sha = "";
        const getRes = await fetch(url, {
            headers: { "Authorization": `token ${appState.ghToken}` }
        });

        if (getRes.ok) {
            const getData = await getRes.json();
            sha = getData.sha;
        }

        const safeState = buildSafeStateForCloud();
        const body = {
            message: `Auto-sync w tle (${getLocalToday()} ${new Date().toLocaleTimeString('pl-PL')})`,
            content: encodeBase64Unicode(JSON.stringify(safeState, null, 2))
        };
        if (sha) {
            body.sha = sha;
        }

        await fetch(url, {
            method: 'PUT',
            headers: {
                "Authorization": `token ${appState.ghToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body),
            keepalive: true
        });

        const msg = document.getElementById('sync-msg');
        if (msg) {
            msg.textContent = "⏱️ Ostatnia automatyczna kopia zapasowa: " + new Date().toLocaleTimeString('pl-PL');
            msg.style.color = "var(--text-light)";
        }
    } catch (err) {
        console.error("Auto-sync error:", err);
    }
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
    loader.style.display = 'block';
    msg.textContent = "Wysyłanie...";
    msg.style.color = 'var(--text-dark)';

    const url = `https://api.github.com/repos/${appState.ghUser}/${appState.ghRepo}/contents/database.json`;
    let sha = "";

    try {
        const getRes = await fetch(url, {
            headers: { "Authorization": `token ${appState.ghToken}` }
        });
        if (getRes.ok) {
            const getData = await getRes.json();
            sha = getData.sha;
        }

        const safeState = buildSafeStateForCloud();
        const body = {
            message: `Zapis postępów z aplikacji (${getLocalToday()})`,
            content: encodeBase64Unicode(JSON.stringify(safeState, null, 2))
        };
        if (sha) {
            body.sha = sha;
        }

        const putRes = await fetch(url, {
            method: 'PUT',
            headers: {
                "Authorization": `token ${appState.ghToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        if (putRes.ok) {
            msg.textContent = "✅ Postępy pomyślnie zapisane w repozytorium GitHub!";
            msg.style.color = "var(--success)";
        } else {
            const errData = await putRes.json();
            throw new Error(errData.message || "Błąd zapisu na GitHubie.");
        }
    } catch (err) {
        msg.textContent = `❌ Błąd: ${err.message}`;
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
    loader.style.display = 'block';
    msg.textContent = "Pobieranie...";
    msg.style.color = 'var(--text-dark)';

    const url = `https://api.github.com/repos/${appState.ghUser}/${appState.ghRepo}/contents/database.json`;

    try {
        const getRes = await fetch(url, {
            headers: { "Authorization": `token ${appState.ghToken}` }
        });
        if (!getRes.ok) {
            throw new Error("Nie znaleziono pliku database.json w tym repozytorium.");
        }

        const data = await getRes.json();
        const jsonStr = decodeBase64Unicode(data.content);
        const imported = JSON.parse(jsonStr);

        if (imported && Array.isArray(imported.flashcards)) {
            const currentApiKey = appState.apiKey;
            const currentGhToken = appState.ghToken;
            const currentGhUser = appState.ghUser;
            const currentGhRepo = appState.ghRepo;

            appState = {
                ...appState,
                ...imported,
                apiKey: currentApiKey,
                ghToken: currentGhToken,
                ghUser: currentGhUser,
                ghRepo: currentGhRepo
            };

            migrateAndHealCards();
            saveState();

            msg.textContent = "✅ Postępy pobrane i wczytane!";
            msg.style.color = "var(--success)";
            setTimeout(() => location.reload(), 1200);
        } else {
            throw new Error("Pobrany plik database.json ma nieprawidłowy format.");
        }
    } catch (err) {
        msg.textContent = `❌ Błąd: ${err.message}`;
        msg.style.color = "var(--danger)";
    } finally {
        loader.style.display = 'none';
    }
}

// Interwał cichej synchronizacji co 5 minut oraz przy minimalizacji karty
setInterval(() => {
    if (document.visibilityState === 'visible') {
        silentSyncToGitHub();
    }
}, 5 * 60 * 1000);

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        silentSyncToGitHub();
    }
});

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
                const preservedApiKey = appState.apiKey;
                const preservedGhToken = appState.ghToken;
                appState = { ...appState, ...imported };
                if (!appState.apiKey && preservedApiKey) appState.apiKey = preservedApiKey;
                if (!appState.ghToken && preservedGhToken) appState.ghToken = preservedGhToken;

                migrateAndHealCards();
                saveState();
                alert("Pomyślnie wgrano kopię zapasową JSON!");
                location.reload();
            } else {
                alert("Nieprawidłowy format pliku JSON z postępami.");
            }
        } catch (err) {
            alert("Błąd odczytu pliku JSON.");
        }
        event.target.value = '';
    };
    reader.readAsText(file);
}

// Pełny parser CSV obsługujący cudzysłowy i przecinki wewnątrz zdań
function parseCSVLine(line) {
    const result = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const nextCh = line[i + 1];

        if (ch === '"') {
            if (inQuotes && nextCh === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            result.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    result.push(current);
    return result;
}

function exportCSV() {
    let csv = "Type,Front,Back,RawOrExample,FullTranslation,Note,Interval\n";
    appState.flashcards.forEach(c => {
        const rawOrEx = c.type === 'cloze' ? (c.rawSentence || "") : (c.exampleSentence || "");
        const row = [
            c.type || 'standard',
            `"${(c.front || '').replace(/"/g, '""')}"`,
            `"${(c.back || '').replace(/"/g, '""')}"`,
            `"${rawOrEx.replace(/"/g, '""')}"`,
            `"${(c.fullTranslation || '').replace(/"/g, '""')}"`,
            `"${(c.note || '').replace(/"/g, '""')}"`,
            c.interval || 0
        ];
        csv += row.join(",") + "\n";
    });

    const dataStr = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    const dl = document.createElement('a');
    dl.setAttribute("href", dataStr);
    dl.setAttribute("download", `korean_fiszki_${getLocalToday()}.csv`);
    dl.click();
}

function importCSV(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const lines = e.target.result.split(/\r?\n/).filter(l => l.trim().length > 0);
        let addedCount = 0;

        lines.forEach((line, idx) => {
            const cols = parseCSVLine(line);
            if (idx === 0 && cols[0] && ['type', 'front', 'awers'].includes(cols[0].trim().toLowerCase())) {
                return;
            }

            if (cols[0] === 'cloze' && cols.length >= 4) {
                const rawSentence = (cols[3] || "").trim();
                const fullTrans = (cols[4] || cols[1] || "").trim();
                const note = (cols[5] || "").trim();
                addedCount += createClozeFlashcardsFromRaw(rawSentence, fullTrans, note, appState.flashcards);
            } else if (cols[0] === 'standard' && cols.length >= 3) {
                const front = (cols[1] || "").trim();
                const back = (cols[2] || "").trim();
                const example = (cols[3] || "").trim();
                const interval = parseInt(cols[6]) || 0;
                if (createFlashcardData(front, back, interval > 0 ? 1 : 0, interval, 2.5, null, example, appState.flashcards)) {
                    addedCount++;
                }
            } else if (cols.length >= 2) {
                // Klasyczny import 2 lub 3-kolumnowy: Front, Back, Example
                const front = (cols[0] || "").trim();
                const back = (cols[1] || "").trim();
                const example = (cols[2] || "").trim();
                if (createFlashcardData(front, back, 0, 0, 2.5, null, example, appState.flashcards)) {
                    addedCount++;
                }
            }
        });

        saveState();
        renderDeckList();
        refreshStudySession();
        alert(`Pomyślnie zaimportowano ${addedCount} nowych fiszek z pliku CSV!`);
        event.target.value = '';
    };
    reader.readAsText(file);
}

// ==========================================
// 6. USTAWIENIA APLIKACJI
// ==========================================
function updateSettingsUI() {
    const apiKeyInput = document.getElementById('api-key');
    const ghTokenInput = document.getElementById('gh-token');
    const ghUserInput = document.getElementById('gh-user');
    const ghRepoInput = document.getElementById('gh-repo');
    const autoSyncCheck = document.getElementById('auto-sync');
    const dailyLimitInput = document.getElementById('daily-limit');
    const hardModeToggle = document.getElementById('hard-mode-setting');

    if (apiKeyInput) apiKeyInput.value = appState.apiKey || "";
    if (ghTokenInput) ghTokenInput.value = appState.ghToken || "";
    if (ghUserInput) ghUserInput.value = appState.ghUser || "";
    if (ghRepoInput) ghRepoInput.value = appState.ghRepo || "";
    if (autoSyncCheck) autoSyncCheck.checked = Boolean(appState.autoSync);
    if (dailyLimitInput) dailyLimitInput.value = appState.dailyLimit || 5;
    if (hardModeToggle) hardModeToggle.checked = Boolean(appState.settings && appState.settings.hardMode);
}

function saveSettings() {
    appState.apiKey = document.getElementById('api-key').value.trim();
    appState.ghToken = document.getElementById('gh-token').value.trim();
    appState.ghUser = document.getElementById('gh-user').value.trim();
    appState.ghRepo = document.getElementById('gh-repo').value.trim();
    appState.autoSync = document.getElementById('auto-sync').checked;

    if (!appState.settings) appState.settings = {};
    const hardModeToggle = document.getElementById('hard-mode-setting');
    if (hardModeToggle) {
        appState.settings.hardMode = hardModeToggle.checked;
    }

    const lim = parseInt(document.getElementById('daily-limit').value, 10);
    if (lim > 0) {
        appState.dailyLimit = lim;
    }

    saveState();
    refreshStudySession();
    alert("Ustawienia zostały zapisane.");
}

function deleteApiKey() {
    appState.apiKey = DEFAULT_API_KEY;
    updateSettingsUI();
    saveState();
    alert("Klucz API został usunięty z pamięci lokalnej.");
}

// ==========================================
// 7. KLIENT GEMINI API (gemini-3.8-flash + thinkingBudget: 0)
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

    // Pierwsza konfiguracja wyłącza ukryte myślenie (thinkingBudget: 0), oszczędzając tokeny i przyspieszając odpowiedź do 1-2s
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
                lastError = new Error("Przekroczono czas oczekiwania na odpowiedź serwera Gemini (25s).");
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

// ==========================================
// 8. CZYTELNIA AI, PARSER DOM I WYŁAPANE SŁÓWKA (.word-inbox-card)
// ==========================================
window.switchCzytelniaTab = function(tab) {
    const readerCont = document.getElementById('czytelnia-reader-container');
    const wordsCont = document.getElementById('czytelnia-words-container');
    const btnReader = document.getElementById('sub-tab-reader');
    const btnWords = document.getElementById('sub-tab-words');

    if (tab === 'reader') {
        readerCont.classList.remove('hidden');
        wordsCont.classList.add('hidden');
        btnReader.classList.add('active');
        btnWords.classList.remove('active');
    } else {
        readerCont.classList.add('hidden');
        wordsCont.classList.remove('hidden');
        btnReader.classList.remove('active');
        btnWords.classList.add('active');
        renderWordsTable();
    }
};

function shuffleArrayFisherYates(array) {
    const arr = [...array];
    let curId = arr.length;
    while (curId !== 0) {
        const randId = Math.floor(Math.random() * curId);
        curId -= 1;
        const tmp = arr[curId];
        arr[curId] = arr[randId];
        arr[randId] = tmp;
    }
    return arr;
}

async function generateAIStory() {
    if (!appState.apiKey || appState.apiKey.trim() === "") {
        return alert("Podaj swój klucz Gemini API w zakładce Ustawienia.");
    }

    const loader = document.getElementById('ai-loader');
    const errorP = document.getElementById('ai-error');
    loader.style.display = 'block';
    errorP.style.display = 'none';

    const knownPool = appState.flashcards.filter(f => f.interval > 10).map(f => f.back);
    const learningPool = appState.flashcards.filter(f => f.interval <= 10).map(f => f.back);

    const sampledKnown = shuffleArrayFisherYates(knownPool).slice(0, 20);
    const sampledLearning = shuffleArrayFisherYates(learningPool).slice(0, 8);

    const knownStr = sampledKnown.length > 0 ? sampledKnown.join(', ') : "brak";
    const learningStr = sampledLearning.length > 0 ? sampledLearning.join(', ') : "brak";

    const forcedGrammar = [];
    if (Array.isArray(appState.grammarTree)) {
        appState.grammarTree.forEach(cat => {
            cat.items.forEach(item => {
                if (item.forceInStory) {
                    forcedGrammar.push(item.title);
                }
            });
        });
    }
    const grammarStr = forcedGrammar.length > 0
        ? forcedGrammar.join(', ')
        : "brak (użyj naturalnych struktur średniozaawansowanych TOPIK II)";

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
        const aiText = rawText.replace(/```html/gi, '').replace(/```/g, '').trim();

        document.getElementById('custom-text').value = aiText;
        currentStoryId = null;
        currentStoryText = aiText;
        document.getElementById('story-title').value = "Historia " + getLocalToday();

        if (Array.isArray(appState.grammarTree)) {
            appState.grammarTree.forEach(cat => {
                cat.items.forEach(item => {
                    item.forceInStory = false;
                });
            });
            saveState();
        }
        setupReaderContent(aiText);
    } catch (err) {
        errorP.textContent = "Błąd: " + err.message;
        errorP.style.display = 'block';
    } finally {
        loader.style.display = 'none';
    }
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
            if (
                node.tagName === 'SPAN' &&
                (node.classList.contains('known-word') || node.classList.contains('learning-word'))
            ) {
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
            const nextIsBold = isBold || node.tagName === 'B' || node.tagName === 'STRONG';

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

// Wycinanie pełnego zdania (od kropki do kropki) wokół wybranego słowa w Czytelni
function extractContextSentenceFromDOM(spanEl) {
    const blockParent = spanEl.closest('p') || document.getElementById('reader-content');
    if (!blockParent) return spanEl.textContent.trim();

    const fullBlockText = blockParent.textContent.replace(/\s+/g, ' ').trim();
    const targetWord = spanEl.textContent.replace(/[.,!?()\[\]"'“”]/g, '').trim();

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
    if (!text) return alert("Wklej najpierw tekst po koreańsku!");
    currentStoryId = null;
    currentStoryText = text;
    document.getElementById('story-title').value = "";
    setupReaderContent(text);
}

function sumUpWords() {
    const selected = document.querySelectorAll('#reader-content .selected');
    if (selected.length === 0) {
        return alert("Zaznacz najpierw nieznane słowa w tekście.");
    }

    let count = 0;
    selected.forEach(span => {
        const surfaceClean = span.textContent.replace(/[.,!?()\[\]"'“”]/g, '').trim();
        const baseAttr = span.getAttribute('data-base');
        const dictFormClean = (baseAttr ? baseAttr : surfaceClean).replace(/[.,!?()\[\]"'“”]/g, '').trim();
        const contextSentence = extractContextSentenceFromDOM(span);

        const alreadyInInbox = appState.words.some(
            w => w.ko === surfaceClean && w.contextSentence === contextSentence
        );

        if (surfaceClean && !alreadyInInbox) {
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
        if (!res.ok) throw new Error("Błąd proxy");

        const proxyData = await res.json();
        const data = JSON.parse(proxyData.contents);
        let tr = data?.[0]?.[0]?.[0] || "";

        if (!tr || tr.trim() === word.trim()) {
            tr = "";
        }

        const w = appState.words.find(item => item.id == id);
        if (w) {
            w.autoPl = tr;
            if (!w.custom && tr) {
                w.custom = tr;
            }
            saveState();
            renderWordsTable();
        }
    } catch (e) {
        // Zgodnie ze specyfikacją: brak tekstu "Błąd pobierania", zostaje czysty input z placeholderem
        const w = appState.words.find(item => item.id == id);
        if (w) {
            w.autoPl = "";
            saveState();
            renderWordsTable();
        }
    }
}

// Tłumaczenie kontekstowe słowa i wyznaczanie formy słownikowej przez Gemini (przycisk ✨)
window.translateInboxWordWithAI = async function(id, btnEl) {
    if (!appState.apiKey || appState.apiKey.trim() === "") {
        return alert("Podaj swój klucz Gemini API w zakładce Ustawienia!");
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

    const prompt = `Przeanalizuj koreańskie słowo "${w.ko}" użyte w zdaniu kontekstowym: "${w.contextSentence || w.ko}".
Zwróć obiekt JSON:
- "dictForm": podstawowa forma słownikowa tego wyrazu po koreańsku (czasowniki/przymiotniki z końcówką -다, rzeczowniki bez partykuł),
- "polishMeaning": trafne, zwięzłe polskie tłumaczenie pasujące do tego zdania.`;

    try {
        const raw = await callGeminiAPI(prompt, true, schema);
        const match = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(match ? match[0] : raw);

        if (parsed.dictForm) {
            w.dictForm = parsed.dictForm.trim();
        }
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

// Renderowanie Kart Roboczych (.word-inbox-card) w zakładce „Wyłapane Słówka” (Zero tabel)
function renderWordsTable() {
    const listContainer = document.getElementById('words-inbox-list');
    const countBadge = document.getElementById('words-inbox-count');
    if (!listContainer) return;

    listContainer.innerHTML = "";
    if (countBadge) {
        countBadge.textContent = appState.words.length;
    }

    if (appState.words.length === 0) {
        listContainer.innerHTML = `<p class="hint text-center mt-2">Brak wyłapanych słówek. Kliknij nieznane słowa podczas czytania tekstu w Czytelni!</p>`;
        return;
    }

    appState.words.forEach(w => {
        const card = document.createElement('div');
        card.className = 'word-inbox-card';

        const dictVal = w.dictForm || w.ko || "";
        const plVal = (w.custom && w.custom.trim() !== "") ? w.custom : (w.autoPl || "");

        let highlightedContext = escapeHtml(w.contextSentence || w.ko);
        if (w.ko) {
            const safeKo = escapeHtml(w.ko).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            highlightedContext = highlightedContext.replace(
                new RegExp(safeKo, 'g'),
                `<mark>${escapeHtml(w.ko)}</mark>`
            );
        }

        card.innerHTML = `
            <div class="inbox-row-1">
                <span class="inbox-captured-word">${escapeHtml(w.ko)}</span>
                <input type="text" class="inbox-dict-input" value="${escapeHtml(dictVal)}" placeholder="Forma słownikowa..." onchange="updateInboxWordField('${w.id}', 'dictForm', this.value)">
                <button type="button" class="btn-icon danger" title="Usuń słówko" onclick="deleteWord('${w.id}')">🗑️</button>
            </div>
            <div class="inbox-row-2">
                <input type="text" class="inbox-pl-input" value="${escapeHtml(plVal)}" placeholder="Wpisz polskie znaczenie..." onchange="updateInboxWordField('${w.id}', 'custom', this.value)">
                <button type="button" class="btn-ai-sparkle" title="Przetłumacz w kontekście z Gemini AI" onclick="translateInboxWordWithAI('${w.id}', this)">✨</button>
            </div>
            <div class="inbox-context-box">${highlightedContext}</div>
            <div class="inbox-row-4">
                <button type="button" class="btn-inbox-action btn-inbox-std" onclick="createStandardFromInbox('${w.id}')">+ Zwykła fiszka</button>
                <button type="button" class="btn-inbox-action btn-inbox-cloze" onclick="openClozeModalFromInbox('${w.id}')">+ Fiszka Cloze</button>
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
        return alert("Wpisz najpierw polskie znaczenie (lub kliknij ✨, aby wygenerować je przez Gemini)!");
    }

    const targetBack = (w.dictForm && w.dictForm.trim() !== "") ? w.dictForm.trim() : w.ko.trim();

    if (createFlashcardData(plMeaning, targetBack, 0, 0, 2.5, null, w.contextSentence || "", appState.flashcards)) {
        appState.words = appState.words.filter(item => item.id != id);
        saveState();
        renderWordsTable();
        renderDeckList();
        refreshStudySession();
    } else {
        alert("Taka fiszka klasyczna już istnieje w Twojej bazie!");
    }
};

window.openClozeModalFromInbox = function(id) {
    const w = appState.words.find(item => item.id == id);
    if (!w) return;

    const plMeaning = (w.custom && w.custom.trim() !== "")
        ? w.custom.trim()
        : ((w.autoPl || "").trim() || "wpisz_znaczenie");
    const dictForm = (w.dictForm && w.dictForm.trim() !== "") ? w.dictForm.trim() : w.ko.trim();
    const clozeTag = `{{${w.ko}|${plMeaning}::${dictForm}}}`;

    let rawSentence = w.contextSentence || w.ko;
    if (rawSentence.includes(w.ko)) {
        rawSentence = rawSentence.replace(w.ko, clozeTag);
    } else {
        rawSentence = `${rawSentence} ${clozeTag}`.trim();
    }

    pendingInboxWordId = w.id;
    openCardModal(null, 'cloze', {
        rawSentence: rawSentence,
        fullTranslation: "",
        note: ""
    });
};

// Biblioteka zapisanych tekstów w Czytelni
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
        const plainPreview = (story.text || "").replace(/<[^>]*>?/gm, '');
        div.innerHTML = `
            <div class="flex-between">
                <h4>${escapeHtml(story.title || "Bez tytułu")}</h4>
                <button class="btn btn-danger btn-sm" onclick="deleteStory(event, '${story.id}')">Usuń</button>
            </div>
            <p>${escapeHtml(plainPreview.substring(0, 85))}...</p>
        `;
        list.appendChild(div);
    });
}

function saveStoryToLibrary() {
    const title = document.getElementById('story-title').value.trim() || ("Moja historia " + getLocalToday());
    if (!currentStoryText) return;

    if (currentStoryId) {
        const existing = appState.library.find(x => x.id == currentStoryId);
        if (existing) {
            existing.title = title;
            existing.text = currentStoryText;
        }
    } else {
        currentStoryId = Date.now().toString();
        appState.library.push({
            id: currentStoryId,
            title: title,
            text: currentStoryText
        });
    }
    saveState();
    alert("Zapisano historię w bibliotece!");
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
    if (confirm("Usunąć tę historię z biblioteki?")) {
        appState.library = appState.library.filter(x => x.id != id);
        saveState();
        renderLibrary();
    }
}

// ==========================================
// 9. MODUŁ GRAMATYKI (KGIU)
// ==========================================
function isDue(c) {
    if (c.type === 'cloze' && c.learningStep === 1) {
        return Boolean(c.intraDayDue && Date.now() >= c.intraDayDue);
    }
    if (!c.nextReview) return true;
    const reviewDate = new Date(c.nextReview);
    reviewDate.setHours(0, 0, 0, 0);
    const todayObj = new Date();
    todayObj.setHours(0, 0, 0, 0);
    return reviewDate.getTime() <= todayObj.getTime();
}

window.updateGrammarWidget = function() {
    if (!appState.grammarFlashcards) return;
    const total = appState.grammarFlashcards.length;
    const mastered = appState.grammarFlashcards.filter(c => c.interval > 10).length;
    const due = appState.grammarFlashcards.filter(c => isDue(c)).length;

    const masteredEl = document.getElementById('grammar-mastered-count');
    const dueEl = document.getElementById('grammar-due-count');
    const barEl = document.getElementById('grammar-progress-bar');

    if (masteredEl) masteredEl.textContent = `${mastered} / ${total}`;
    if (dueEl) dueEl.textContent = due;
    if (barEl) {
        const pct = total === 0 ? 0 : (mastered / total) * 100;
        barEl.style.width = `${pct}%`;
    }
};

function renderGrammarTab() {
    const container = document.getElementById('grammar-list-container');
    if (!container) return;
    container.innerHTML = "";

    if (!appState.grammarTree || appState.grammarTree.length === 0) return;

    const s0 = document.getElementById('filter-g0')?.checked ?? true;
    const s1 = document.getElementById('filter-g1')?.checked ?? true;
    const s2 = document.getElementById('filter-g2')?.checked ?? true;

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
        header.innerHTML = `
            <span>${escapeHtml(cat.category)}</span>
            <span style="font-size: 13px; color: var(--text-light); font-weight: normal;">${learnedCount}/${totalCount}</span>
        `;

        const content = document.createElement('div');
        content.className = 'accordion-content';

        filteredItems.forEach(item => {
            const itemIndex = cat.items.findIndex(i => i.id === item.id);
            const div = document.createElement('div');
            div.className = 'grammar-item';
            div.onclick = () => openGrammarModal(catIndex, itemIndex);
            div.innerHTML = `
                <span class="grammar-title">${escapeHtml(item.title)} ${item.forceInStory ? '🎯' : ''}</span>
                <span class="status-dot status-${item.status}"></span>
            `;
            content.appendChild(div);
        });

        header.onclick = () => content.classList.toggle('open');
        accordion.appendChild(header);
        accordion.appendChild(content);
        container.appendChild(accordion);
    });
}

function openGrammarModal(catIndex, itemIndex) {
    activeGrammarCatIndex = catIndex;
    activeGrammarItemIndex = itemIndex;
    const item = appState.grammarTree[catIndex].items[itemIndex];

    document.getElementById('grammar-modal-title').textContent = item.title;

    document.querySelectorAll('.grammar-status-buttons button').forEach(b => b.classList.remove('active'));
    const activeStatBtn = document.getElementById(`g-stat-${item.status}`);
    if (activeStatBtn) activeStatBtn.classList.add('active');

    const forceBtn = document.getElementById('g-force-btn');
    if (item.forceInStory) {
        forceBtn.classList.remove('btn-outline');
        forceBtn.classList.add('btn-primary');
        forceBtn.textContent = "🎯 Wymuszono";
    } else {
        forceBtn.classList.remove('btn-primary');
        forceBtn.classList.add('btn-outline');
        forceBtn.textContent = "🎯 Wymuś w historii";
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

    let html = `
        <div class="mb-3"><b>Znaczenie:</b> ${escapeHtml(item.meaning)}</div>
        <div class="mb-3"><b>Reguła:</b> ${escapeHtml(item.rule)}</div>
    `;

    if (item.examples && item.examples.length > 0) {
        html += `<h4>Przykłady (Kliknij +, aby dodać fiszkę Cloze):</h4>`;
        item.examples.forEach((ex, idx) => {
            html += `
                <div class="grammar-example-box">
                    <button class="btn btn-primary btn-add-cloze" onclick="addGrammarFlashcard(${idx})">+</button>
                    <div class="grammar-example-ko">${escapeHtml(ex.ko)}</div>
                    <div class="grammar-example-pl">${escapeHtml(ex.pl)}</div>
                </div>
            `;
        });
    }
    body.innerHTML = html;
}

function setGrammarStatus(status) {
    if (activeGrammarCatIndex === null || activeGrammarItemIndex === null) return;
    appState.grammarTree[activeGrammarCatIndex].items[activeGrammarItemIndex].status = status;
    saveState();

    document.querySelectorAll('.grammar-status-buttons button').forEach(b => b.classList.remove('active'));
    document.getElementById(`g-stat-${status}`).classList.add('active');
    renderGrammarTab();
}

function toggleForceGrammar() {
    if (activeGrammarCatIndex === null || activeGrammarItemIndex === null) return;
    const item = appState.grammarTree[activeGrammarCatIndex].items[activeGrammarItemIndex];
    item.forceInStory = !item.forceInStory;
    saveState();

    const forceBtn = document.getElementById('g-force-btn');
    if (item.forceInStory) {
        forceBtn.classList.remove('btn-outline');
        forceBtn.classList.add('btn-primary');
        forceBtn.textContent = "🎯 Wymuszono";
    } else {
        forceBtn.classList.remove('btn-primary');
        forceBtn.classList.add('btn-outline');
        forceBtn.textContent = "🎯 Wymuś w historii";
    }
    renderGrammarTab();
}

async function explainGrammarWithGemini() {
    if (isGeneratingGrammar) return;
    if (!appState.apiKey || appState.apiKey.trim() === "") {
        return alert("Podaj klucz Gemini API w zakładce Ustawienia!");
    }
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
- "base_verb": podstawowa forma słownikowa wyciętego czasownika/przymiotnika (np. 가다, 먹다).`;

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
    if (!ex) return;

    if (!appState.grammarFlashcards) appState.grammarFlashcards = [];

    const hintText = `${item.title}${item.meaning ? ' - ' + item.meaning : ''}`;
    const dictPart = ex.base_verb ? `::${ex.base_verb}` : '';
    const rawSentence = ex.cloze_sentence.replace(/_+/g, `{{${ex.cloze_answer}|${hintText}${dictPart}}}`);
    const noteText = `Struktura: ${item.title}. ${item.rule || ''}`;

    const addedCount = createClozeFlashcardsFromRaw(rawSentence, ex.pl, noteText, appState.grammarFlashcards);
    if (addedCount > 0) {
        saveState();
        updateGrammarWidget();
        alert("Utworzono fiszkę gramatyczną (Cloze)!");
    } else {
        alert("Taka fiszka gramatyczna już istnieje.");
    }
}

// ==========================================
// 10. TWORZENIE FISZEK, BAZA FISZEK (.deck-card-item) I MODAL EDYCJI
// ==========================================
function createFlashcardData(front, back, rep, interval, ef, nextReviewStr = null, exampleSentence = "", targetDeck = appState.flashcards) {
    if (!front || !back) return false;
    const cleanFront = front.trim();
    const cleanBack = back.trim();

    const duplicate = targetDeck.some(
        f => f.type !== 'cloze' && f.front === cleanFront && f.back === cleanBack
    );
    if (duplicate) return false;

    targetDeck.push({
        id: Date.now() + Math.random(),
        type: 'standard',
        front: cleanFront,
        back: cleanBack,
        exampleSentence: (exampleSentence || "").trim(),
        rep: rep > 0 ? rep : (interval > 0 ? 1 : 0),
        interval: interval > 0 ? interval : 0,
        ef: ef >= 1.3 ? ef : 2.5,
        learningStep: interval > 0 ? 2 : 0,
        intraDayDue: null,
        nextReview: nextReviewStr || (interval > 0
            ? new Date(Date.now() + interval * 86400000).toISOString()
            : new Date().toISOString())
    });
    return true;
}

// Multi-Cloze: generuje N osobnych fiszek dla zdania z N znacznikami {{...}}
function createClozeFlashcardsFromRaw(rawSentence, fullTranslation, note = "", targetDeck = appState.flashcards) {
    const matches = parseClozeMatches(rawSentence);
    if (matches.length === 0) return 0;

    const cleanRaw = rawSentence.trim();
    const cleanTrans = (fullTranslation || "").trim();
    const cleanNote = (note || "").trim();
    const parentId = `cloze_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    let createdCount = 0;

    matches.forEach(m => {
        const exists = targetDeck.some(
            f => f.type === 'cloze' && f.rawSentence === cleanRaw && f.clozeIndex === m.index
        );
        if (!exists) {
            targetDeck.push({
                id: Date.now() + Math.random() + m.index,
                type: 'cloze',
                parentId: parentId,
                clozeIndex: m.index,
                rawSentence: cleanRaw,
                fullTranslation: cleanTrans,
                note: cleanNote,
                front: cleanTrans || m.hint,
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

window.openCardModal = function(cardId = null, forcedMode = null, prefillData = null) {
    editingCardId = cardId;
    const modal = document.getElementById('modal-card-editor');
    const titleEl = document.getElementById('modal-editor-title');

    if (cardId !== null && cardId !== undefined) {
        const card =
            appState.flashcards.find(c => c.id == cardId) ||
            appState.grammarFlashcards.find(c => c.id == cardId);
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

// Narzędzie "{ } Zrób lukę z zaznaczenia"
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

    const hintStart = start + 2 + selectedText.length + 1;
    const hintEnd = hintStart + placeholderHint.length;
    textarea.setSelectionRange(hintStart, hintEnd);

    updateClozeLivePreview();
};

window.updateClozeLivePreview = function() {
    const rawInput = document.getElementById('edit-cloze-raw');
    const previewEl = document.getElementById('cloze-live-preview-content');
    const badgeEl = document.getElementById('cloze-count-badge');
    if (!rawInput || !previewEl || !badgeEl) return;

    const raw = rawInput.value;
    const matches = parseClozeMatches(raw);
    badgeEl.textContent = `Wykryte luki: ${matches.length}`;

    if (!raw.trim()) {
        previewEl.innerHTML = `<span class="hint">Wpisz zdanie ze znacznikiem {{odpowiedź|podpowiedź::forma_słownikowa}}...</span>`;
        return;
    }

    const formatted = escapeHtml(raw).replace(CLOZE_REGEX, (m, target, hint) => {
        return `<span class="cloze-pill">[ ${escapeHtml(hint.trim())} 💡 ]</span>`;
    });
    previewEl.innerHTML = formatted;
};

window.saveCardFromModal = function() {
    const targetDeck = (editingCardId && currentDeckType === 'grammar')
        ? appState.grammarFlashcards
        : appState.flashcards;

    if (editorMode === 'standard') {
        const f = document.getElementById('edit-std-front').value.trim();
        const b = document.getElementById('edit-std-back').value.trim();
        const ex = document.getElementById('edit-std-example').value.trim();

        if (!f || !b) {
            return alert("Wypełnij oba główne pola: Awers (Polski) i Rewers (Koreański)!");
        }

        if (editingCardId !== null && editingCardId !== undefined) {
            const card =
                appState.flashcards.find(c => c.id == editingCardId) ||
                appState.grammarFlashcards.find(c => c.id == editingCardId);
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
            const card =
                appState.flashcards.find(c => c.id == editingCardId) ||
                appState.grammarFlashcards.find(c => c.id == editingCardId);
            if (card) {
                card.type = 'cloze';
                card.rawSentence = raw;
                card.fullTranslation = trans;
                card.note = note;
                if (card.clozeIndex >= matches.length) {
                    card.clozeIndex = 0;
                }
                const active = getActiveClozeData(card);
                card.front = trans;
                card.back = active.target;

                // Aktualizacja lub dogenerowanie kart braterskich (Multi-Cloze)
                if (matches.length > 1) {
                    const pid = card.parentId || `p_${card.id}`;
                    card.parentId = pid;
                    const deckRef = appState.flashcards.includes(card)
                        ? appState.flashcards
                        : appState.grammarFlashcards;

                    matches.forEach(m => {
                        const existingSibling = deckRef.find(
                            s => s.parentId === pid && s.clozeIndex === m.index
                        );
                        if (!existingSibling) {
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
                            existingSibling.rawSentence = raw;
                            existingSibling.fullTranslation = trans;
                            existingSibling.note = note;
                            existingSibling.front = trans;
                            existingSibling.back = m.target;
                        }
                    });
                }
            }
        } else {
            const created = createClozeFlashcardsFromRaw(raw, trans, note, targetDeck);
            if (created === 0) {
                return alert("Taka karta Cloze już istnieje w bazie!");
            }
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

// Filtrowanie i renderowanie listy kart w „Baza fiszek” (Zero tabel)
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

    if (countSpan) {
        countSpan.textContent = appState.flashcards.length;
    }

    const query = (searchInput ? searchInput.value : "").trim().toLowerCase();

    const filtered = appState.flashcards.filter(card => {
        const cType = card.type || 'standard';
        if (currentDeckFilter === 'standard' && cType !== 'standard') return false;
        if (currentDeckFilter === 'cloze' && cType !== 'cloze') return false;
        if (currentDeckFilter === 'learning' && (card.interval > 10 && card.learningStep === 2)) return false;

        if (!query) return true;

        const haystack = [
            card.front || "",
            card.back || "",
            card.rawSentence || "",
            card.fullTranslation || "",
            card.exampleSentence || "",
            card.note || ""
        ].join(" ").toLowerCase();

        return haystack.includes(query);
    });

    listEl.innerHTML = "";

    if (filtered.length === 0) {
        listEl.innerHTML = `<p class="hint text-center mt-3">Brak fiszek spełniających wybrane kryteria.</p>`;
        return;
    }

    filtered.forEach(card => {
        const item = document.createElement('div');
        item.className = 'deck-card-item';

        const isCloze = card.type === 'cloze';
        const typeLabel = isCloze ? `[CLOZE #${(card.clozeIndex || 0) + 1}]` : `[KLASYCZNA]`;
        const typeClass = isCloze ? 'tag-cloze' : 'tag-standard';
        const stepBadge = (isCloze && card.learningStep === 1)
            ? `<span class="interval-pill" style="background:#FEF3C7;color:#B45309;">🌙 Przed snem</span>`
            : '';

        let koDisplay = "";
        let plDisplay = "";

        if (isCloze) {
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
                <button type="button" class="btn-icon" title="Edytuj fiszkę" onclick="openCardModal('${card.id}')">✏️</button>
                <button type="button" class="btn-icon danger" title="Usuń fiszkę" onclick="deleteCard('${card.id}')">🗑️</button>
            </div>
        `;
        listEl.appendChild(item);
    });
}

function renderDeckTable() {
    renderDeckList();
}

function toggleDeckList() {
    const container = document.getElementById('deck-list-container');
    if (container) container.classList.toggle('hidden');
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

// ==========================================
// 11. SILNIK POWTÓREK SRS, SIBLING BURYING I INTRA-DAY LEARNING STEP
// ==========================================
function getActiveDeck() {
    return currentDeckType === 'grammar' ? appState.grammarFlashcards : appState.flashcards;
}

window.startSession = function(type) {
    currentDeckType = type;
    isIntraDayForcedSession = false;
    const mgmt = document.getElementById('deck-management-section');
    const title = document.getElementById('srs-session-title');

    if (type === 'grammar') {
        if (title) title.textContent = "Trening Gramatyki (Cloze)";
        if (mgmt) mgmt.classList.add('hidden');
    } else {
        if (title) title.textContent = "Sesja SRS (Słówka & Cloze)";
        if (mgmt) mgmt.classList.remove('hidden');
    }

    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    if (type === 'grammar') {
        document.querySelector('.nav-btn[data-target="tab-gramatyka"]')?.classList.add('active');
    } else {
        document.querySelector('.nav-btn[data-target="tab-fiszki"]')?.classList.add('active');
    }

    document.getElementById('tab-fiszki').classList.add('active');
    refreshStudySession();
};

// Sibling Burying: rozdziela karty z tym samym parentId, aby nie pojawiały się bezpośrednio po sobie
function applySiblingBurying(queue) {
    if (!Array.isArray(queue) || queue.length <= 2) return queue;
    const result = [...queue];

    for (let i = 1; i < result.length; i++) {
        const prev = result[i - 1];
        const curr = result[i];

        if (prev.parentId && curr.parentId && prev.parentId === curr.parentId) {
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
        if (btnHeader) {
            btnHeader.textContent = label;
            btnHeader.classList.remove('hidden');
        }
        if (btnEmpty) {
            btnEmpty.textContent = label;
            btnEmpty.classList.remove('hidden');
        }
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
    const statsEl = document.getElementById('study-stats');
    if (statsEl) {
        statsEl.textContent = `Do powtórki: ${studyQueue.length}`;
    }
}

function refreshStudySession() {
    const todayStr = getLocalToday();
    if (!appState.history[todayStr]) {
        appState.history[todayStr] = {
            again: 0,
            hard: 0,
            good: 0,
            easy: 0,
            completedAll: false,
            newCardsDone: 0,
            newGrammarDone: 0,
            practicedMistakes: []
        };
    }
    const hist = appState.history[todayStr];
    if (!Array.isArray(hist.practicedMistakes)) {
        hist.practicedMistakes = [];
    }

    const limitKey = currentDeckType === 'grammar' ? 'newGrammarDone' : 'newCardsDone';
    const newCardsDone = hist[limitKey] || 0;
    let newCardsInQueue = 0;

    const nowMs = Date.now();
    const todayObj = new Date();
    todayObj.setHours(0, 0, 0, 0);
    const deckToStudy = getActiveDeck();

    if (isIntraDayForcedSession) {
        studyQueue = deckToStudy.filter(c => c.type === 'cloze' && c.learningStep === 1);
        if (studyQueue.length === 0) {
            isIntraDayForcedSession = false;
        }
    }

    if (!isIntraDayForcedSession) {
        studyQueue = deckToStudy.filter(c => {
            // Karta Cloze na kroku wewnątrz-dziennym (learningStep === 1) wraca automatycznie po upływie intraDayDue (3h)
            if (c.type === 'cloze' && c.learningStep === 1) {
                return Boolean(c.intraDayDue && nowMs >= c.intraDayDue);
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
                    if (newCardsDone + newCardsInQueue >= appState.dailyLimit) {
                        return false;
                    }
                    newCardsInQueue++;
                }
                return true;
            }
            return false;
        });
    }

    studyQueue.sort((a, b) => {
        if (a.interval > 0 && b.interval === 0) return -1;
        if (a.interval === 0 && b.interval > 0) return 1;
        return 0;
    });

    studyQueue = applySiblingBurying(studyQueue);

    updateSessionProgressUI();
    updateStudyCounter();
    updateIntraDayButtons();

    if (studyQueue.length === 0) {
        if (currentDeckType === 'vocab') {
            appState.history[todayStr].completedAll = true;
        }
        saveState();

        document.getElementById('study-empty').classList.remove('hidden');
        document.getElementById('study-active').classList.add('hidden');
        updateActivityStats();

        const practiceBtn = document.getElementById('btn-practice-mistakes');
        if (
            currentDeckType === 'vocab' &&
            appState.sessionStats &&
            appState.sessionStats.date === todayStr &&
            Array.isArray(appState.sessionStats.again) &&
            appState.sessionStats.again.length > 0
        ) {
            const practiced = hist.practicedMistakes;
            const uniqueMistakes = Array.from(
                new Map(appState.sessionStats.again.map(item => [item.id, item])).values()
            ).filter(item => !practiced.includes(item.id));

            if (uniqueMistakes.length > 0) {
                practiceBtn.textContent = `Przećwicz dzisiejsze błędy (${uniqueMistakes.length})`;
                practiceBtn.classList.remove('hidden');
            } else {
                practiceBtn.classList.add('hidden');
            }
        } else if (practiceBtn) {
            practiceBtn.classList.add('hidden');
        }
    } else {
        if (currentDeckType === 'vocab') {
            appState.history[todayStr].completedAll = false;
        }
        saveState();

        document.getElementById('study-empty').classList.add('hidden');
        document.getElementById('study-active').classList.remove('hidden');

        const practiceBtn = document.getElementById('btn-practice-mistakes');
        if (practiceBtn) practiceBtn.classList.add('hidden');

        nextStudyCard();
    }
}

// ==========================================
// 12. OBSŁUGA WIDOKU KARTY (CLOZE STANY A/B/C ORAZ KLASYCZNE)
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
        if (badgeEl) {
            badgeEl.textContent = currentCard.learningStep === 1
                ? "CLOZE • POWTÓRKA PRZED SNEM"
                : "ZDANIE CLOZE";
            badgeEl.className = "card-type-tag tag-cloze";
        }

        document.getElementById('study-vocab-container').classList.add('hidden');
        document.getElementById('study-cloze-container').classList.remove('hidden');

        renderClozeQuestionState(currentCard);
    } else {
        if (badgeEl) {
            badgeEl.textContent = "FISZKA KLASYCZNA";
            badgeEl.className = "card-type-tag tag-standard";
        }

        document.getElementById('study-cloze-container').classList.add('hidden');
        document.getElementById('study-vocab-container').classList.remove('hidden');

        document.getElementById('study-front').textContent = currentCard.front;

        let backHtml = `<div class="study-back-content"><div>${escapeHtml(currentCard.back)}</div>`;
        if (currentCard.exampleSentence) {
            backHtml += `<div class="example-sentence">${escapeHtml(currentCard.exampleSentence)}</div>`;
        }
        backHtml += `</div>`;
        document.getElementById('study-back').innerHTML = backHtml;

        document.getElementById('study-front').classList.remove('hidden');
        document.getElementById('study-back').classList.add('hidden');

        const isHardMode = Boolean(appState.settings && appState.settings.hardMode);
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

            setTimeout(() => {
                if (hmInput) hmInput.focus();
            }, 120);
        } else {
            document.getElementById('btn-show-answer').classList.remove('hidden');
            document.getElementById('hard-mode-container').classList.add('hidden');
        }

        document.getElementById('time-hard').textContent = previewSM2(currentCard, 3);
        document.getElementById('time-good').textContent = previewSM2(currentCard, 4);
        document.getElementById('time-easy').textContent = previewSM2(currentCard, 5);
    }
}

// Stan A: Widok pytania dla karty Cloze
function renderClozeQuestionState(card) {
    const activeIdx = typeof card.clozeIndex === 'number' ? card.clozeIndex : 0;
    let matchCounter = 0;

    const raw = card.rawSentence || `{{${card.back}|${card.front}}}`;
    const sentenceHtml = escapeHtml(raw).replace(CLOZE_REGEX, (full, target, hint) => {
        const isCurrentHole = (matchCounter === activeIdx);
        matchCounter++;
        if (isCurrentHole) {
            return `<span class="cloze-pill">[ ${escapeHtml(hint.trim())} <button type="button" class="btn-cloze-hint" title="Podpowiedź" onclick="showClozeHintPopup(event)">💡</button> ]</span>`;
        }
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

// Kliknięcie ikony 💡 w bloku luki (.cloze-pill)
window.showClozeHintPopup = function(event) {
    if (event) event.stopPropagation();
    if (!currentCard) return;

    const active = getActiveClozeData(currentCard);
    const firstSyllable = active.target ? (active.target.trim().charAt(0) + '...') : '';
    const dictPart = active.dictForm ? `Forma słownikowa: ${active.dictForm} | ` : '';

    const popup = document.getElementById('cloze-hint-popup');
    popup.textContent = `💡 ${dictPart}Pierwsza sylaba: "${firstSyllable}"`;
    popup.classList.remove('hidden');

    const clozeInput = document.getElementById('clozeInput');
    if (clozeInput && !clozeInput.disabled) {
        clozeInput.focus();
    }
};

// Stan B: Walidacja odpowiedzi Cloze, Automatyczny SM-2 i Haptic Feedback
window.checkCloze = function() {
    const inputEl = document.getElementById('clozeInput');
    if (!inputEl || inputEl.disabled || !currentCard) return;

    const userInput = inputEl.value.trim();
    if (!userInput) return; // Ignoruj pusty input (nie nabijaj prób)

    currentAttempts++;
    const active = getActiveClozeData(currentCard);
    const target = active.target.trim();

    if (userInput === target) {
        // SCENARIUSZ 1: Odpowiedź POPRAWNA
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
        // SCENARIUSZ 2: Odpowiedź BŁĘDNA (Brak wibracji)
        if (currentAttempts < 4) {
            inputEl.classList.remove('error');
            void inputEl.offsetWidth;
            inputEl.classList.add('error');

            const counterEl = document.getElementById('attemptCounter');
            if (counterEl) {
                counterEl.textContent = `Próba: ${currentAttempts + 1} / 4`;
            }

            setTimeout(() => {
                inputEl.classList.remove('error');
                inputEl.focus();
                inputEl.select();
            }, 400);
        } else {
            // Spalona 4. próba
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
            return `<span class="${statusClass}">${escapeHtml(target.trim())}${dictText} <button type="button" class="btn-tts" title="Odsłuchaj zdanie" onclick="speakKorean('${safeFullSentForAttr}', 0.95)">🔊</button></span>`;
        }
        return escapeHtml(target.trim());
    });

    document.getElementById('cloze-sentence-display').innerHTML = sentenceHtml;
    document.getElementById('cloze-hint-popup').classList.add('hidden');

    const noteEl = document.getElementById('cloze-note-container');
    if (card.note && card.note.trim() !== "") {
        noteEl.innerHTML = `📌 <strong>Notatka:</strong> ${escapeHtml(card.note)}`;
        noteEl.classList.remove('hidden');
    } else {
        noteEl.classList.add('hidden');
    }

    document.getElementById('cloze-input-section').classList.add('hidden');

    const btnNext = document.getElementById('btnNextCard');
    btnNext.classList.remove('hidden');
    setTimeout(() => btnNext.focus(), 100);

    // Auto-TTS po wejściu w Stan C
    speakKorean(fullKoreanSentence, 0.95);
}

// ==========================================
// 13. HARD MODE DLA KART KLASYCZNYCH
// ==========================================
function checkHardMode() {
    const inputEl = document.getElementById('hardModeInput');
    if (!inputEl || inputEl.disabled || !currentCard) return;

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

// ==========================================
// 14. OBLICZENIA ALGORYTMU SM-2 I POSTĘP SESJI
// ==========================================
function previewSM2(card, quality) {
    const temp = { ...card };
    applySM2(temp, quality);
    return `${temp.interval}d`;
}

function processAnswer(quality, advanceView = true, suppressVibrate = false) {
    if (!suppressVibrate && 'vibrate' in navigator) {
        if (quality === 4) {
            navigator.vibrate(50);
        } else if (quality === 5) {
            navigator.vibrate([30, 50, 30]);
        }
    }

    const today = getLocalToday();
    if (!appState.sessionStats || appState.sessionStats.date !== today) {
        appState.sessionStats = {
            date: today,
            again: [],
            hard: [],
            good: [],
            easy: []
        };
    }
    if (!appState.history) appState.history = {};
    if (!appState.history[today]) {
        appState.history[today] = {
            again: 0,
            hard: 0,
            good: 0,
            easy: 0,
            completedAll: false,
            newCardsDone: 0,
            newGrammarDone: 0,
            practicedMistakes: []
        };
    } else if (!Array.isArray(appState.history[today].practicedMistakes)) {
        appState.history[today].practicedMistakes = [];
    }

    const cat = quality < 3 ? 'again' : (quality === 3 ? 'hard' : (quality === 4 ? 'good' : 'easy'));

    if (currentDeckType === 'vocab') {
        appState.sessionStats[cat].push({ ...currentCard });
        appState.history[today][cat] = (appState.history[today][cat] || 0) + 1;
    }

    if (currentCard.interval === 0 && (currentCard.learningStep === 0 || currentCard.learningStep === undefined)) {
        const limitKey = currentDeckType === 'grammar' ? 'newGrammarDone' : 'newCardsDone';
        appState.history[today][limitKey] = (appState.history[today][limitKey] || 0) + 1;
    }

    applySM2(currentCard, quality);
    studyQueue.shift();
    saveState();

    if (currentDeckType === 'vocab') {
        renderDeckList();
    }
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
        if (currentDeckType === 'vocab') {
            appState.history[today].completedAll = true;
        }
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
    // Logika Intra-day Learning Step dla kart Cloze
    if (card.type === 'cloze') {
        const step = typeof card.learningStep === 'number'
            ? card.learningStep
            : (card.interval > 0 ? 2 : 0);

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
                card.learningStep = 1;
                card.intraDayDue = Date.now() + (60 * 60 * 1000);
                card.interval = 0;
                const todayMidnight = new Date();
                todayMidnight.setHours(0, 0, 0, 0);
                card.nextReview = todayMidnight.toISOString();
                return;
            } else {
                card.learningStep = 0;
                card.intraDayDue = null;
                card.rep = 0;
                card.interval = 1;
                const next = new Date();
                next.setHours(0, 0, 0, 0);
                card.nextReview = next.toISOString();
                return;
            }
        } else if (step === 1) {
            if (quality >= 3) {
                // Drugie zaliczenie tego samego dnia: karta przechodzi na learningStep = 2 i interwał 1d na jutro
                card.learningStep = 2;
                card.intraDayDue = null;
                card.rep = 1;
                card.interval = 1;
                const next = new Date();
                next.setDate(next.getDate() + 1);
                next.setHours(0, 0, 0, 0);
                card.nextReview = next.toISOString();
                return;
            } else {
                card.learningStep = 1;
                card.intraDayDue = Date.now() + (30 * 60 * 1000);
                return;
            }
        }
    }

    // Standardowy algorytm wielodniowy SM-2
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
            if (quality === 3) {
                card.interval = Math.max(1, Math.round(card.interval * 0.8));
            } else if (quality === 5) {
                card.interval = Math.round(card.interval * 1.2);
            }
        }
        card.rep++;
    }

    card.ef = Math.max(1.3, card.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    const next = new Date();
    next.setDate(next.getDate() + card.interval);
    next.setHours(0, 0, 0, 0);
    card.nextReview = next.toISOString();
}

function updateSessionProgressUI() {
    if (!appState.sessionStats) return;
    const total =
        appState.sessionStats.again.length +
        appState.sessionStats.hard.length +
        appState.sessionStats.good.length +
        appState.sessionStats.easy.length;

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

    document.getElementById('prog-again').style.width = `${pAgain}%`;
    document.getElementById('prog-hard').style.width = `${pHard}%`;
    document.getElementById('prog-good').style.width = `${pGood}%`;
    document.getElementById('prog-easy').style.width = `${pEasy}%`;

    const successRate = (((appState.sessionStats.good.length + appState.sessionStats.easy.length) / total) * 100).toFixed(0);
    document.getElementById('prog-percent').textContent = successRate;
}

function openStatsModal() {
    if (!appState.sessionStats) return;
    const container = document.getElementById('stats-details-container');
    container.innerHTML = '';

    const categories = [
        { id: 'again', name: 'Złe (Nie znam)', color: 'var(--danger)', data: appState.sessionStats.again },
        { id: 'hard', name: 'Średnie (Słabo)', color: 'var(--warning)', data: appState.sessionStats.hard },
        { id: 'good', name: 'Dobre', color: '#3B82F6', data: appState.sessionStats.good },
        { id: 'easy', name: 'Bardzo Dobre', color: 'var(--success)', data: appState.sessionStats.easy }
    ];

    let html = '';
    categories.forEach(c => {
        if (c.data.length > 0) {
            html += `<h4 style="color: ${c.color}; margin-top: 10px;">${c.name} (${c.data.length})</h4><ul class="stats-list">`;
            c.data.forEach(card => {
                html += `<li><b>${escapeHtml(card.front)}</b> - ${escapeHtml(card.back)}</li>`;
            });
            html += `</ul>`;
        }
    });

    if (html === '') {
        html = '<p class="text-center hint">Brak danych w dzisiejszej sesji.</p>';
    }
    container.innerHTML = html;
    document.getElementById('modal-stats').classList.remove('hidden');
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
    if (id === 'modal-card-editor') {
        pendingInboxWordId = null;
    }
}

// ==========================================
// 15. AKTYWNOŚĆ, STREAKS, WYKRES 7-DNIOWY I KALENDARZ
// ==========================================
function updateActivityStats() {
    if (!appState.history) return;
    const today = getLocalToday();
    const dates = Object.keys(appState.history).sort();
    const completedDates = dates.filter(d => appState.history[d].completedAll);

    let currentStreak = 0;
    let maxStreak = 0;
    const totalDays = completedDates.length;
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
        if (tempStreak > maxStreak) {
            maxStreak = tempStreak;
        }
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
    if (!container) return;
    container.innerHTML = "";

    const todayObj = new Date(getLocalToday());
    const daysData = [];
    let maxWords = 0;

    for (let i = 6; i >= 0; i--) {
        const d = new Date(todayObj);
        d.setDate(d.getDate() - i);
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const stats = appState.history[ds] || { again: 0, hard: 0, good: 0, easy: 0 };
        const total = (stats.again || 0) + (stats.hard || 0) + (stats.good || 0) + (stats.easy || 0);
        if (total > maxWords) {
            maxWords = total;
        }
        daysData.push({
            date: ds,
            short: d.toLocaleDateString('pl-PL', { weekday: 'short' }),
            stats: stats,
            total: total
        });
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
            if (pEasy > 0) html += `<div class="bar-segment bar-easy" style="height: ${pEasy}%"></div>`;
            if (pGood > 0) html += `<div class="bar-segment bar-good" style="height: ${pGood}%"></div>`;
            if (pHard > 0) html += `<div class="bar-segment bar-hard" style="height: ${pHard}%"></div>`;
            if (pAgain > 0) html += `<div class="bar-segment bar-again" style="height: ${pAgain}%"></div>`;
            html += `</div>`;
        } else {
            html += `<div class="chart-total" style="color:transparent;">0</div><div class="bar-wrapper" style="height: 0%;"></div>`;
        }

        html += `<div class="chart-label">${day.short}</div>`;
        col.innerHTML = html;
        container.appendChild(col);
    });
}

function changeMonth(offset) {
    currentCalDate.setMonth(currentCalDate.getMonth() + offset);
    renderCalendar();
}

function renderCalendar() {
    const grid = document.getElementById('calendar-grid');
    if (!grid) return;
    grid.innerHTML = "";

    const year = currentCalDate.getFullYear();
    const month = currentCalDate.getMonth();
    const monthNames = [
        "styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec",
        "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"
    ];
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
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
        if (appState.history && appState.history[dateStr] && appState.history[dateStr].completedAll) {
            el.classList.add('completed');
        }
        grid.appendChild(el);
    }
}

// ==========================================
// 16. GRA ROZSYPANKI (TAP-TO-MATCH) I SYNTEZATOR MOWY (TTS)
// ==========================================
function startMatchingGame() {
    const todayStr = getLocalToday();
    if (!appState.sessionStats || appState.sessionStats.date !== todayStr || !appState.sessionStats.again) {
        return;
    }

    const hist = appState.history[todayStr] || {};
    const practiced = hist.practicedMistakes || [];
    const uniqueMistakes = Array.from(
        new Map(appState.sessionStats.again.map(item => [item.id, item])).values()
    ).filter(item => !practiced.includes(item.id));

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

    const koArr = shuffleArrayFisherYates(chunk);
    const plArr = shuffleArrayFisherYates(chunk);

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
        speakKorean(text, 0.95);
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
                if (!appState.history[todayStr].practicedMistakes) {
                    appState.history[todayStr].practicedMistakes = [];
                }
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

window.speakKorean = function(text, rate = 0.95) {
    if ('speechSynthesis' in window && text) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ko-KR';
        utterance.rate = rate;
        window.speechSynthesis.speak(utterance);
    }
};

function closeMatchingGame() {
    document.getElementById('matching-game-view').classList.add('hidden');
    matchSelKo = null;
    matchSelPl = null;
    refreshStudySession();
}

// ==========================================
// 17. START APLIKACJI I NASŁUCHIWANIE KLAWISZY
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    loadState();

    // Obsługa klawisza Enter w Hard Mode dla kart klasycznych
    const hmInput = document.getElementById('hardModeInput');
    if (hmInput) {
        hmInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                checkHardMode();
            }
        });
    }

    // Obsługa klawisza Enter w polu wpisywania Cloze Deletion
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
