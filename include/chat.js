// =================================================================
// ✨ Tampermonkey / 同一ドメインiframe対応のためのポリフィル（最終完全版）
// =================================================================

// 動作確認
if (window.top !== window.self) { window.NOSTR_CHAT_ALIVE = true; }

if (typeof chrome === 'undefined' || !chrome.runtime) {
    // リスナーを退避させておくためのグローバルな配列
    window._mockListeners = window._mockListeners || [];

    window.chrome = {
        runtime: {
            // アイコン画像のパスをGitHubのRaw URLにすり替える
            getURL: function(path) {
                return "https://raw.githubusercontent.com/nostrurl/base/main/assets/" + path;
            },
            // 拡張機能のメッセージの代わりに、親ページの window.parent.nostr を直接叩いて結果を疑似返却する
            sendMessage: async function(message, callback) {
                const parentNostr = window.parent && window.parent.nostr;
                
                if (message.type === 'GET_PUBLIC_KEY') {
                    if (parentNostr) {
                        try {
                            const pubKey = await parentNostr.getPublicKey();
                            if (callback) callback({ pubKey: pubKey });
                            // 退避させておいたメッセージリスナー（startPublicKeyMonitorなど）にも通知を届ける
                            window._mockListeners.forEach(ln => ln({ type: 'CHAT_UI_FORCE_UPDATE', pubKey: pubKey }));
                        } catch(e) {
                            if (callback) callback({ pubKey: "Guest" });
                        }
                    } else {
                        if (callback) callback({ pubKey: "No Extension" });
                    }
                } 
                else if (message.type === 'SIGN_EVENT') {
                    if (parentNostr) {
                        try {
                            const signedEvent = await parentNostr.signEvent(message.event);
                            if (callback) callback({ success: true, event: signedEvent });
                        } catch(e) {
                            if (callback) callback({ success: false });
                        }
                    } else {
                        if (callback) callback({ success: false });
                    }
                }
            },
            // イベントリスナーをちゃんと配列に捕獲する形に強化
            onMessage: {
                addListener: function(callback) {
                    if (typeof callback === 'function') {
                        window._mockListeners.push(callback);
                    }
                }
            }
        }
    };
}
// =================================================================

// --- 1. 定義と設定 ---
const DEFAULT_CONFIG = {
    ROOM_MODE: 'url',
    CUSTOM_ROOM_NAME: 'Nostrurl',
    RELAY_URLS: [
        'wss://relay-jp.nostr.wirednet.jp',
        'wss://relay.nostr.wirednet.jp', 
    ],
    RECONNECT_INTERVAL: 5000
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
}

function generateTargetKey(url, config) {
    const roomName = config.CUSTOM_ROOM_NAME || 'Nostrurl';
    
    // 1. まずハッシュ（#）以降を削る
    let cleanUrl = url.split('#')[0];
    
    // 2. Googleのキャッシュ回避用パラメータ（zx）や、一般的な追跡パラメータ（utm_*）を削ぎ落とす
    try {
        const urlObj = new URL(cleanUrl);
        
        // 削りたいパラメータのリスト
        const badParams = ['zx', 'utm_source', 'utm_medium', 'utm_campaign', 'gclid'];
        
        badParams.forEach(param => {
            urlObj.searchParams.delete(param);
        });
        
        // パラメータを消した後のURLを再構築（末尾の無駄な「?」なども防ぐ）
        cleanUrl = urlObj.origin + urlObj.pathname;
        const remainingParams = urlObj.searchParams.toString();
        if (remainingParams) {
            cleanUrl += '?' + remainingParams;
        }
    } catch (e) {
        // 万が一URLのパースに失敗した場合は元の文字列のまま処理
        console.error("URLのクリーンアップに失敗:", e);
    }

    if (config.ROOM_MODE === 'url') return cleanUrl;
    if (config.ROOM_MODE === 'room_name') return roomName;
    return cleanUrl + roomName;
}

// --- 3. 変数の初期化 ---
let currentConfig = loadConfig();
const sockets = new Map();
const activeSubs = new Map();
const reconnectTimeouts = new Map(); // 再接続管理用

console.log("初期設定の全リレー数:", DEFAULT_CONFIG.RELAY_URLS.length);
console.log("現在読み込まれたリレー数:", currentConfig.RELAY_URLS.length);

const urlParams = new URLSearchParams(window.location.search);
const currentUrl = window.REAL_PARENT_URL || urlParams.get('url') || window.location.href || "about:blank";
let nostrUrlTargetKey = generateTargetKey(currentUrl, currentConfig);
let pubKey = "Guest";
let isRelayConnected = false;
let commentList = [];
let seenEventIds = new Set();
let roomChangeTimeout = null;
let isManualMode = false;

// --- 4. DOM要素の取得 ---
document.getElementById('header-icon').src = chrome.runtime.getURL('icon.png');
const commentBox = document.getElementById('comments');
const manualBox = document.getElementById('manual-view');
const menuBtn = document.getElementById('menu-btn');
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

// --- 5. UIの初期設定 ---
guiMode.value = currentConfig.ROOM_MODE;
guiRoomName.value = currentConfig.CUSTOM_ROOM_NAME;
activeKeyDisp.innerText = nostrUrlTargetKey;

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
    activeKeyDisp.innerText = nostrUrlTargetKey;
    commentList = []; seenEventIds.clear();
    commentBox.innerHTML = "Loading comments...";
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
            console.log(`[Connected]: ${url}`);
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
            console.log(`[Disconnected]: ${url}`);
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
    if (isManualMode) return;
    if (commentList.length === 0) { commentBox.innerHTML = '<div style="color:#aaa; text-align:center; margin-top:20px;">まだコメントがありません</div>'; return; }
    
    commentList.sort((a, b) => a.created_at - b.created_at);
    
    const pad = (n) => String(n).padStart(2, '0');
    
    commentBox.innerHTML = commentList.map(ev => {
        const date = new Date(ev.created_at * 1000);
        const timeStr = `${String(date.getFullYear()).slice(-2)}/${pad(date.getMonth()+1)}/${pad(date.getDate())}  ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        return `<div class="msg-row"><div class="msg-header"><strong style="color: #b388ff;">${ev.pubkey.substring(0,8)}:</strong><span class="msg-time">${timeStr}</span></div><div class="msg-content">${escapeHtml(ev.content)}</div></div>`;
    }).join('');
    commentBox.scrollTop = commentBox.scrollHeight;
}

function renderGuiRelayList() {
    guiRelayList.innerHTML = '';
    currentConfig.RELAY_URLS.forEach((url, i) => {
        const li = document.createElement('li');
        li.className = 'gui-relay-item';
        li.innerHTML = `<span>${url}</span>`;
        const delBtn = document.createElement('button');
        delBtn.className = 'gui-btn-del';
        delBtn.innerText = '削除';
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

// --- 7. 初期化とイベントリスナー設定 ---
startPublicKeyMonitor();

menuBtn.onclick = () => {
    isManualMode = !isManualMode;
    manualBox.classList.toggle('show-element', isManualMode);
    manualBox.classList.toggle('hide-element', !isManualMode);
    commentBox.classList.toggle('hide-element', isManualMode);
    menuBtn.innerText = isManualMode ? '💬' : '⚙️';
    if (!isManualMode) renderComments();
};

guiMode.onchange = () => { currentConfig.ROOM_MODE = guiMode.value; saveConfig(currentConfig); handleRoomChange(); };
guiRoomName.oninput = () => { currentConfig.CUSTOM_ROOM_NAME = guiRoomName.value.trim(); saveConfig(currentConfig); clearTimeout(roomChangeTimeout); roomChangeTimeout = setTimeout(handleRoomChange, 300); };
guiRelayAddBtn.onclick = () => {
    const url = guiRelayInput.value.trim();
    if (url && url.startsWith('wss://') && !currentConfig.RELAY_URLS.includes(url)) {
        currentConfig.RELAY_URLS.push(url); saveConfig(currentConfig); renderGuiRelayList(); connectToRelay(url);
    }
};

sendBtn.onclick = executeSubmit;
inputArea.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') executeSubmit(); };

currentConfig.RELAY_URLS.forEach(url => connectToRelay(url));
renderGuiRelayList();

// --- デバッグ用 ---
window.debugNostr = {
    listSockets: () => {
        sockets.forEach((ws, url) => {
            console.log(`URL: ${url}, 状態: ${ws.readyState === 1 ? 'OPEN' : 'CLOSED'}`);
        });
    },
    reconnectAll: () => {
        currentConfig.RELAY_URLS.forEach(url => connectToRelay(url));
    }
};