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
    const saved = typeof GM_getValue !== 'undefined' 
        ? GM_getValue('nostrurl_config') 
        : localStorage.getItem('nostrurl_config');

    const defaultCopy = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    if (saved) {
        try {
            const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
            // parsed の中身を defaultCopy で包み込んで、足りない項目（RELAY_URLS等）を絶対に補完する
            return Object.assign({}, defaultCopy, parsed);
        } catch (e) { 
            console.error("Config parse error:", e); 
            return defaultCopy;
        }
    }
    return defaultCopy;
}

// ================= 設定の保存（GM関数によるユーザー主権の確立） =================

// 設定を保存する関数
function saveConfig(config) {
    try {
        // Tampermonkeyの強固な保存領域に保存
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue('nostrurl_config', config);
        } else {
            localStorage.setItem('nostrurl_config', JSON.stringify(config));
        }
    } catch (e) {
        console.error("設定の保存に失敗したよ:", e);
    }

    // 親画面への通知（既存ロジック）
    if (window.parent) {
        window.parent.postMessage({
            type: 'NOSTRURL_FILTER_UPDATE',
            filterMode: config.FILTER_MODE,
            filterDomains: config.FILTER_DOMAINS
        }, '*');
    }
}

// GUI上のリレー一覧をレンダリングする関数（削除ボタン内蔵）
function renderGuiRelayList() {
    if (!guiRelayList) return;
    guiRelayList.innerHTML = '';

    // クラッシュ防止に安全ガードを追加
    if (currentConfig && currentConfig.RELAY_URLS) {
        currentConfig.RELAY_URLS.forEach((url, index) => {
            const item = document.createElement('div');
            item.className = 'gui-relay-item';

            const urlSpan = document.createElement('span');
            urlSpan.innerText = url;
            item.appendChild(urlSpan);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'gui-btn-del';
            removeBtn.innerText = '解除';
            
            // ユーザーの意思でリレーを捨てる自由（切断＆削除＆保存）
            removeBtn.onclick = () => {
                currentConfig.RELAY_URLS.splice(index, 1);
                saveConfig(currentConfig); // 変更をGM領域へ保存
                
                // 接続中のWebSocketがあれば切断して管理から消す
                if (sockets.has(url)) {
                    const ws = sockets.get(url);
                    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                        ws.close();
                    }
                    sockets.delete(url);
                    if (activeSubs.has(url)) activeSubs.delete(url);
                }
                
                renderGuiRelayList(); // UI更新
            };

            item.appendChild(removeBtn);
            guiRelayList.appendChild(item);
        });
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
// グローバル設定の読み込み初期化
let currentConfig = (() => {
    try {
        const saved = typeof GM_getValue !== 'undefined' 
            ? GM_getValue('nostrurl_config') 
            : localStorage.getItem('nostrurl_config');
            
        if (saved) {
            const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
            // ここも確実にデフォルトの構造と合体させる
            return Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_CONFIG)), parsed);
        }
    } catch (e) {
        console.error("初期設定の読み込みに失敗:", e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
})();
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
const configBox = document.getElementById('config-view'); // ⚙️ライブ設定コンテナ (config.html側)
const manualBox = document.getElementById('manual-view'); // 📜ヘルプマニュアルコンテナ (manual.html側)

const configBtn = document.getElementById('config-btn'); // ⚙️ボタン
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
			
			// Nostrurl仕様：特定のURL（部屋名）50件をGet！
            // ws.send(JSON.stringify(["REQ", newSubId, { "kinds": [1], "#r": [nostrUrlTargetKey], "limit": 50 }]));
			
			// Public仕様：部屋なんて関係ない、最新の投稿（kind:1）を何でも50件Get！
			ws.send(JSON.stringify(["REQ", newSubId, { "kinds": [1], "limit": 50 }]));
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
            
			// Nostrurl仕様：特定のURL（部屋名）50件をGet！
			// ws.send(JSON.stringify(["REQ", subId, { "kinds": [1], "#r": [nostrUrlTargetKey], "limit": 50 }]));
			
			// Public仕様：部屋なんて関係ない、最新の投稿（kind:1）を何でも50件Get！
			ws.send(JSON.stringify(["REQ", subId, { "kinds": [1], "limit": 50 }]));
        };
		
		/*
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data[0] === "EVENT") {
                const nostrEvent = data[2];
                if (nostrEvent.tags.some(t => t[0] === 'r' && t[1] === nostrUrlTargetKey) && !seenEventIds.has(nostrEvent.id)) {
                    seenEventIds.add(nostrEvent.id); commentList.push(nostrEvent); renderComments();
                }
            }
        };
		*/
		
                
        // ⭕ 部屋名（#r）のチェックを撤廃！重複チェック（seenEventIds）だけで即採用する
		ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data[0] === "EVENT") {
                const nostrEvent = data[2];
                if (!seenEventIds.has(nostrEvent.id)) {
                    seenEventIds.add(nostrEvent.id); 
                    commentList.push(nostrEvent); 
                    renderComments();
                }
            }
        };
		
        ws.onclose = () => {
            sockets.delete(url); activeSubs.delete(url);
            isRelayConnected = Array.from(sockets.values()).some(s => s.readyState === WebSocket.OPEN);
            updateStatusUI();
			if (currentConfig.RELAY_URLS?.includes(url)) {
				const timer = setTimeout(() => connectToRelay(url), currentConfig.RECONNECT_INTERVAL);
				reconnectTimeouts.set(url, timer);
			}
        };
    } catch (e) {
		if (currentConfig.RELAY_URLS?.includes(url)) {
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
    
    // 2. ⚙️ライブ設定コンテナ（#config-view）
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
    
    // 3. 📜マニュアルコンテナ（#manual-view）
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
    if (configBtn) configBtn.innerText = (activeView === 'config') ? '💬' : '⚙️';
    if (manualBtn) manualBtn.innerText = (activeView === 'manual') ? '💬' : '📜';

    // 画面がチャットに戻ったか、設定を開いたかに応じた処理
    if (activeView === 'chat') {
        renderComments();
    } else if (activeView === 'config') {
        currentConfig = loadConfig(); 
        if (filterElements.guiFilterMode) {
            filterElements.guiFilterMode.value = currentConfig.FILTER_MODE || 'off';
        }
		renderGuiRelayList();
        window.NostrFilterManager.renderGuiFilterList(currentConfig, currentDomain, filterElements);
    }
}


// --- 8. 初期化とイベントリスナー設定 ---
startPublicKeyMonitor();

// 歯車マーク（configBtn）を押したら「ライブ設定（config）」を開く
if (configBtn) {
    configBtn.onclick = () => switchView('config');
}

// マニュアルマーク（manualBtn）を押したら「ヘルプマニュアル（manual）」を開く
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

// 接続と描画を開始するまさにこの瞬間に、最新のストレージデータを強制ロードして同期を確定させる
currentConfig = loadConfig();

// 最新の配列に基づいて接続を開始し、UIを構築する
currentConfig.RELAY_URLS.forEach(url => connectToRelay(url));
renderGuiRelayList();

// 初期レンダリング
if (window.NostrFilterManager && typeof window.NostrFilterManager.renderGuiFilterList === 'function') {
    window.NostrFilterManager.renderGuiFilterList(currentConfig, currentDomain, filterElements);
}


// ================= ライブ設定：リレー追加ボタンの処理 =================
if (guiRelayAddBtn && guiRelayInput) {
    guiRelayAddBtn.onclick = () => {
        const newRelayUrl = guiRelayInput.value.trim();
        if (!newRelayUrl) return;

        // wss:// から始まっているか簡易チェック
        if (!newRelayUrl.startsWith('wss://') && !newRelayUrl.startsWith('ws://')) {
            alert('リレーURLは wss:// または ws:// から始めてね！');
            return;
        }

        // 重複チェック
		if (currentConfig.RELAY_URLS?.includes(newRelayUrl)) {
			alert('このリレーはすでに追加されているよ！');
			return;
		}

        // 設定の配列に追加して保存
        currentConfig.RELAY_URLS.push(newRelayUrl);
        saveConfig(currentConfig);

        // 新しいリレーにその場で即座に接続を開始
        connectToRelay(newRelayUrl);

        // UI（一覧表示）を更新して、入力欄を空にする
        renderGuiRelayList();
        guiRelayInput.value = '';
    };
}