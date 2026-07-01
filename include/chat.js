// =================================================================
//  Tampermonkey / 同一ドメインiframe対応のためのポリフィル
// =================================================================

// 動作確認
if (window.top !== window.self) { window.NOSTR_CHAT_ALIVE = true; }

if (typeof chrome === 'undefined' || !chrome.runtime) {
    window._mockListeners = window._mockListeners || [];
    window.chrome = {
        runtime: {
            getURL: function(path) {
                return "https://raw.githubusercontent.com/nostrurl/base/main/assets/" + path;
            },
            sendMessage: async function(message, callback) {
                const parentNostr = window.parent && window.parent.nostr;
                if (message.type === 'GET_PUBLIC_KEY') {
                    if (parentNostr) {
                        try {
                            const pubKey = await parentNostr.getPublicKey();
                            if (callback) callback({ pubKey: pubKey });
                            window._mockListeners.forEach(ln => ln({ type: 'CHAT_UI_FORCE_UPDATE', pubKey: pubKey }));
                        } catch(e) { if (callback) callback({ pubKey: "Guest" }); }
                    } else { if (callback) callback({ pubKey: "No Extension" }); }
                } 
                else if (message.type === 'SIGN_EVENT') {
                    if (parentNostr) {
                        try {
                            const signedEvent = await parentNostr.signEvent(message.event);
                            if (callback) callback({ success: true, event: signedEvent });
                        } catch(e) { if (callback) callback({ success: false }); }
                    } else { if (callback) callback({ success: false }); }
                }
            },
            onMessage: {
                addListener: function(callback) {
                    if (typeof callback === 'function') { window._mockListeners.push(callback); }
                }
            }
        }
    };
}

// --- 1. 定義と設定 ---
const DEFAULT_CONFIG = {
    ROOM_MODE: 'url',
    CUSTOM_ROOM_NAME: 'Nostrurl',
    RELAY_URLS: [
        'wss://relay-jp.nostr.wirednet.jp',
        'wss://relay.nostr.wirednet.jp', 
    ],
    RECONNECT_INTERVAL: 5000,
    FILTER_MODE: 'blacklist',         // 'off' | 'whitelist' | 'blacklist'
    FILTER_DOMAINS: []          
};

// --- 2. 関数定義 ---
function loadConfig() {
    const saved = localStorage.getItem('nostrurl_config');
    const defaultCopy = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            return { ...defaultCopy, ...parsed };
        } catch (e) { 
            console.error("Config parse error:", e); 
            return defaultCopy;
        }
    }
    return defaultCopy;
}

function saveConfig(config) {
    localStorage.setItem('nostrurl_config', JSON.stringify(config));
    if (window.parent) {
        window.parent.postMessage({
            type: 'NOSTRURL_FILTER_UPDATE',
            filterMode: config.FILTER_MODE,
            filterDomains: config.FILTER_DOMAINS
        }, '*');
    }
}

function generateTargetKey(url, config) {
    const roomName = config.CUSTOM_ROOM_NAME || 'Nostrurl';
    const cleanUrl = url.split('#')[0];
    if (config.ROOM_MODE === 'url') return cleanUrl;
    if (config.ROOM_MODE === 'room_name') return roomName;
    return cleanUrl + roomName;
}

// --- 3. 変数の初期化 ---
let currentConfig = loadConfig();
const sockets = new Map();
const activeSubs = new Map();
const reconnectTimeouts = new Map(); 

const urlParams = new URLSearchParams(window.location.search);
const currentUrl = window.REAL_PARENT_URL || urlParams.get('url') || window.location.href || "about:blank";

// domain-filter.js の関数を使用してドメイン抽出
const currentDomain = window.NostrFilterManager.extractDomain(currentUrl); 

let nostrUrlTargetKey = generateTargetKey(currentUrl, currentConfig);
let pubKey = "Guest";
let isRelayConnected = false;
let commentList = [];
let seenEventIds = new Set();
let roomChangeTimeout = null;

// UI表示状態の管理フラグ
let activeView = 'chat'; // 'chat' | 'config' | 'manual'

// --- 4. DOM要素の取得 ---
document.getElementById('header-icon').src = chrome.runtime.getURL('icon.png');
const commentBox = document.getElementById('comments');
const configBox = document.getElementById('manual-view'); // ⚙️ライブ設定コンテナ (config.html側)
const manualBox = document.getElementById('manual-content-view'); // 📜ヘルプマニュアルコンテナ (manual.html側)

const menuBtn = document.getElementById('menu-btn'); // ⚙️ボタン
const manualBtn = document.getElementById('manual-btn'); // 📜ボタン

const inputArea = document.getElementById('input');
const sendBtn = document.getElementById('send');
const guiMode = document.getElementById('gui-mode');
const guiRoomName = document.getElementById('gui-room-name');
const guiRelayList = document.getElementById('gui-relay-list');
const guiRelayInput = document.getElementById('gui-relay-input');
const guiRelayAddBtn = document.getElementById('gui-relay-add-btn');
const activeKeyDisp = document.getElementById('active-key-disp');
const displayKeySpan = document.getElementById('display-key');
const connStatusDisp = document.getElementById('connection-status');

// 新機能用DOM要素（domain-filter.jsに渡すためにオブジェクトにまとめる）
const filterElements = {
    guiFilterMode: document.getElementById('gui-filter-mode'),
    guiFilterToggleCurrentBtn: document.getElementById('gui-filter-toggle-current-btn'),
    guiFilterSearch: document.getElementById('gui-filter-search'),
    guiFilterList: document.getElementById('gui-filter-list'),
    guiFilterInput: document.getElementById('gui-filter-input'),
    guiFilterAddBtn: document.getElementById('gui-filter-add-btn')
};

// --- 5. UIの初期設定 ---
if (guiMode) guiMode.value = currentConfig.ROOM_MODE;
if (guiRoomName) guiRoomName.value = currentConfig.CUSTOM_ROOM_NAME;
if (activeKeyDisp) activeKeyDisp.innerText = nostrUrlTargetKey;

if (filterElements.guiFilterMode) {
    filterElements.guiFilterMode.value = currentConfig.FILTER_MODE || 'off';
}

// 初期状態はコメント欄を「フル表示」にする
if (commentBox) {
    commentBox.classList.remove('hide-element');
    commentBox.style.display = 'block'; // コメント欄を最初から全開にする
}

// ライブ設定とマニュアルは、初期状態で絶対に領域を確保させず完全に隠す
if (configBox) {
    configBox.classList.remove('show-element');
    configBox.classList.add('hide-element');
    configBox.style.display = 'none';
}
if (manualBox) {
    manualBox.classList.remove('show-element');
    manualBox.classList.add('hide-element');
    manualBox.style.display = 'none';
}

// --- 6. 処理ロジック ---
function updateStatusUI() {
    if (!connStatusDisp || !displayKeySpan) return;
    if (pubKey === "Guest") displayKeySpan.innerText = "Guest（閲覧モード）";
    else if (pubKey === "No Extension") displayKeySpan.innerText = "鍵がないよ";
    else displayKeySpan.innerText = pubKey.length > 8 ? `${pubKey.substring(0, 8)}...` : pubKey;

    if (pubKey === "No Extension") connStatusDisp.innerHTML = '❌ 連携失敗';
    else if (pubKey !== "Guest" && isRelayConnected) connStatusDisp.innerHTML = '✅ 公開鍵';
    else connStatusDisp.innerHTML = '⏳ 鍵確認中...';
}

function startPublicKeyMonitor() {
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'CHAT_UI_FORCE_UPDATE' && pubKey !== message.pubKey) {
            pubKey = message.pubKey;
            updateStatusUI();
        }
    });
    chrome.runtime.sendMessage({ type: 'GET_PUBLIC_KEY' }, (response) => {
        if (response && response.pubKey) { pubKey = response.pubKey; updateStatusUI(); }
    });
}

window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'STATUS_UPDATE') {
        const newStatus = event.data.status;
        if (newStatus === 'No Extension') { pubKey = 'No Extension'; updateStatusUI(); }
        else if (newStatus === 'Connected') {
            chrome.runtime.sendMessage({ type: 'GET_PUBLIC_KEY' }, (res) => {
                if (res && res.pubKey) { pubKey = res.pubKey; updateStatusUI(); }
            });
        }
    }
});

function handleRoomChange() {
    nostrUrlTargetKey = generateTargetKey(currentUrl, currentConfig);
    if (activeKeyDisp) activeKeyDisp.innerText = nostrUrlTargetKey;
    commentList = []; seenEventIds.clear();
    if (commentBox) commentBox.innerHTML = "Loading comments...";
    sockets.forEach((ws, url) => {
        if (ws.readyState === WebSocket.OPEN) {
            if (activeSubs.has(url)) ws.send(JSON.stringify(["CLOSE", activeSubs.get(url)]));
            const newSubId = 'sub-' + Math.random().toString(36).substr(2, 9);
            activeSubs.set(url, newSubId);
            ws.send(JSON.stringify(["REQ", newSubId, { "kinds": [1], "#r": [nostrUrlTargetKey], "limit": 50 }]));
        }
    });
}

function connectToRelay(url) {
    if (sockets.has(url) && sockets.get(url).readyState === WebSocket.OPEN) return;
    if (reconnectTimeouts.has(url)) { clearTimeout(reconnectTimeouts.get(url)); reconnectTimeouts.delete(url); }

    try {
        const ws = new WebSocket(url);
        sockets.set(url, ws);
        ws.onopen = () => {
            isRelayConnected = true; updateStatusUI();
            const subId = 'sub-' + Math.random().toString(36).substr(2, 9);
            activeSubs.set(url, subId);
            ws.send(JSON.stringify(["REQ", subId, { "kinds": [1], "#r": [nostrUrlTargetKey], "limit": 50 }]));
        };
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data[0] === "EVENT") {
                const nostrEvent = data[2];
                if (nostrEvent.tags.some(t => t[0] === 'r' && t[1] === nostrUrlTargetKey) && !seenEventIds.has(nostrEvent.id)) {
                    seenEventIds.add(nostrEvent.id); commentList.push(nostrEvent); renderComments();
                }
            }
        };
        ws.onclose = () => {
            sockets.delete(url); activeSubs.delete(url);
            isRelayConnected = Array.from(sockets.values()).some(s => s.readyState === WebSocket.OPEN);
            updateStatusUI();
            if (currentConfig.RELAY_URLS.includes(url)) {
                const timer = setTimeout(() => connectToRelay(url), currentConfig.RECONNECT_INTERVAL);
                reconnectTimeouts.set(url, timer);
            }
        };
    } catch (e) {
        if (currentConfig.RELAY_URLS.includes(url)) {
            const timer = setTimeout(() => connectToRelay(url), currentConfig.RECONNECT_INTERVAL);
            reconnectTimeouts.set(url, timer);
        }
    }
}

function renderComments() {
    if (activeView !== 'chat') return; // チャット画面以外のときは描写をスキップ
    if (!commentBox) return;
    if (commentList.length === 0) { 
        commentBox.innerHTML = '<div style="color:#aaa; text-align:center; margin-top:20px;">まだコメントがありません</div>'; 
        return; 
    }
    
    commentList.sort((a, b) => a.created_at - b.created_at);
    const pad = (n) => String(n).padStart(2, '0');
    
    commentBox.innerHTML = commentList.map(ev => {
        const date = new Date(ev.created_at * 1000);
        const timeStr = `${String(date.getFullYear()).slice(-2)}/${pad(date.getMonth()+1)}/${pad(date.getDate())}  ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        return `<div class="msg-row"><div class="msg-header"><strong style="color: #b388ff;">${ev.pubkey.substring(0,8)}:</strong><span class="msg-time">${timeStr}</span></div><div class="msg-content-wrap"><div class="msg-content">${linkifyAndTruncate(ev.content)}</div></div><div class="msg-action-bar"></div></div>`;
    }).join('');

    const rows = commentBox.querySelectorAll('.msg-row');
    rows.forEach(row => {
        const wrap = row.querySelector('.msg-content-wrap');
        const content = row.querySelector('.msg-content');
        const actionBar = row.querySelector('.msg-action-bar');
        
        if (content.scrollHeight > 120) {
            wrap.classList.add('is-clamped');
            const btn = document.createElement('button');
            btn.className = 'read-more-btn';
            btn.innerText = '▼ 続きを読む';
            btn.onclick = () => {
                const isOpen = wrap.classList.toggle('is-expanded');
                wrap.classList.toggle('is-clamped', !isOpen);
                btn.innerText = isOpen ? '▲ 折りたたむ' : '▼ 続きを読む';
            };
            actionBar.appendChild(btn);
        }
    });
    commentBox.scrollTop = commentBox.scrollHeight;
}

function renderGuiRelayList() {
    if (!guiRelayList) return;
    guiRelayList.innerHTML = '';
    currentConfig.RELAY_URLS.forEach((url, i) => {
        const li = document.createElement('li');
        li.className = 'gui-relay-item';
        li.innerHTML = `<span>${url}</span>`;
        const delBtn = document.createElement('button');
        delBtn.className = 'gui-btn-del';
        delBtn.innerText = '解除';
        delBtn.onclick = () => {
            currentConfig.RELAY_URLS = currentConfig.RELAY_URLS.filter(u => u !== url);
            saveConfig(currentConfig);
            if (sockets.has(url)) sockets.get(url).close();
            if (reconnectTimeouts.has(url)) { clearTimeout(reconnectTimeouts.get(url)); reconnectTimeouts.delete(url); }
            renderGuiRelayList();
        };
        li.appendChild(delBtn);
        guiRelayList.appendChild(li);
    });
}

function escapeHtml(str) { return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }

function linkifyAndTruncate(text) {
    let escaped = escapeHtml(text);
    const urlRegex = /(https?:\/\/[^\s<>\"]+)/g;
    return escaped.replace(urlRegex, (url) => {
        let displayUrl = url;
        if (url.length > 50) { displayUrl = url.substring(0, 47) + '...'; }
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color: #82b1ff; text-decoration: underline;">${displayUrl}</a>`;
    });
}

const executeSubmit = async () => {
    if (pubKey === "Guest" || pubKey === "No Extension") { alert("投稿できません"); return; }
    const text = inputArea.value.trim(); if (!text) return;
    let baseEvent = { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [["r", nostrUrlTargetKey]], content: text };
    chrome.runtime.sendMessage({ type: 'SIGN_EVENT', event: baseEvent }, (res) => {
        if (res && res.success) {
            sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["EVENT", res.event])); });
            inputArea.value = "";
        }
    });
};

// --- 7. ビュー（表示切り替え）の一元管理ロジック ---
function switchView(target) {
    if (activeView === target) {
        // 開いている画面のボタンをもう一度押したら、通常のチャット画面に戻す
        activeView = 'chat';
    } else {
        activeView = target;
    }

    // 1. チャット欄（#comments）の切り替え
    if (commentBox) {
        if (activeView === 'chat') {
            commentBox.classList.remove('hide-element');
            commentBox.style.display = 'block';
        } else {
            commentBox.classList.add('hide-element');
            commentBox.style.display = 'none';
        }
    }
    
    // 2. ⚙️歯車マークに対応：ライブ設定コンテナ（#manual-view）
    if (configBox) {
        if (activeView === 'config') {
            configBox.classList.remove('hide-element');
            configBox.classList.add('show-element');
            configBox.style.display = 'block';
        } else {
            configBox.classList.remove('show-element');
            configBox.classList.add('hide-element');
            configBox.style.display = 'none';
        }
    }
    
    // 3. 📜マニュアルマークに対応：ヘルプマニュアルコンテナ（#manual-content-view）
    if (manualBox) {
        if (activeView === 'manual') {
            manualBox.classList.remove('hide-element');
            manualBox.classList.add('show-element');
            manualBox.style.display = 'block';
        } else {
            manualBox.classList.remove('show-element');
            manualBox.classList.add('hide-element');
            manualBox.style.display = 'none';
        }
    }

    // 各ボタンのアイコン（開いている時は「💬」に戻るトグル仕様）を同期
    if (menuBtn) menuBtn.innerText = (activeView === 'config') ? '💬' : '⚙️';
    if (manualBtn) manualBtn.innerText = (activeView === 'manual') ? '💬' : '📜';

    // 画面がチャットに戻ったか、設定を開いたかに応じた処理
    if (activeView === 'chat') {
        renderComments();
    } else if (activeView === 'config') {
        currentConfig = loadConfig(); 
        if (filterElements.guiFilterMode) {
            filterElements.guiFilterMode.value = currentConfig.FILTER_MODE || 'off';
        }
        window.NostrFilterManager.renderGuiFilterList(currentConfig, currentDomain, filterElements);
    }
}


// --- 8. 初期化とイベントリスナー設定 ---
startPublicKeyMonitor();

// 💡 【修正】歯車マーク（menuBtn）を押したら「ライブ設定（config）」を開く
if (menuBtn) {
    menuBtn.onclick = () => switchView('config');
}

// 💡 【修正】マニュアルマーク（manualBtn）を押したら「ヘルプマニュアル（manual）」を開く
if (manualBtn) {
    manualBtn.onclick = () => switchView('manual');
}


// ================= フィルターUIのイベントリスナー設定 =================

if (filterElements.guiFilterMode) {
    filterElements.guiFilterMode.onchange = () => {
        currentConfig.FILTER_MODE = filterElements.guiFilterMode.value;
        saveConfig(currentConfig);
    };
}

if (filterElements.guiFilterToggleCurrentBtn) {
    filterElements.guiFilterToggleCurrentBtn.onclick = () => {
        const domains = currentConfig.FILTER_DOMAINS || [];
        if (domains.includes(currentDomain)) {
            currentConfig.FILTER_DOMAINS = domains.filter(d => d !== currentDomain);
        } else {
            currentConfig.FILTER_DOMAINS.push(currentDomain);
        }
        saveConfig(currentConfig);
        window.NostrFilterManager.renderGuiFilterList(currentConfig, currentDomain, filterElements);
    };
}

if (filterElements.guiFilterSearch) {
    filterElements.guiFilterSearch.oninput = () => {
        window.NostrFilterManager.renderGuiFilterList(currentConfig, currentDomain, filterElements);
    };
}

if (filterElements.guiFilterAddBtn) {
    filterElements.guiFilterAddBtn.onclick = () => {
        const rawInput = filterElements.guiFilterInput.value.trim();
        if (!rawInput) return;

        const domain = window.NostrFilterManager.extractDomain(rawInput);
        if (domain && !currentConfig.FILTER_DOMAINS.includes(domain)) {
            currentConfig.FILTER_DOMAINS.push(domain);
            saveConfig(currentConfig);
            filterElements.guiFilterInput.value = '';
            window.NostrFilterManager.renderGuiFilterList(currentConfig, currentDomain, filterElements);
        }
    };
}

if (sendBtn) sendBtn.onclick = executeSubmit;
if (inputArea) {
    inputArea.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') executeSubmit(); };
}

currentConfig.RELAY_URLS.forEach(url => connectToRelay(url));
renderGuiRelayList();

// 初期レンダリング
if (window.NostrFilterManager && typeof window.NostrFilterManager.renderGuiFilterList === 'function') {
    window.NostrFilterManager.renderGuiFilterList(currentConfig, currentDomain, filterElements);
}