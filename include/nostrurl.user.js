// ==UserScript==
// @name         Nostrurl (ユーザースクリプト版)
// @namespace    nostrurl.github.io/base/
// @version      6.6.5
// @description  URLをタグにしたNostrコメント欄を設ける
// @author       Nostrurl
// @match        http://*/*
// @match        https://*/*
// @icon         https://raw.githubusercontent.com/nostrurl/base/heads/main/assets/icon.png
// @homepageURL  https://github.com/nostrurl/base
// @supportURL   https://github.com/nostrurl/base/issues
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function() {
    'use strict';
    if (window.top !== window.self) return;

    const GITHUB_RAW_HTML_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/chat.html";
    const GITHUB_RAW_CSS_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/chat.css";
    const GITHUB_RAW_FILTER_JS_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/domain-filter.js"; 
    const GITHUB_RAW_JS_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/chat.js";
    const GITHUB_RAW_PURGE_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/purge.txt";

    // ─── グローバルUI管理変数 ───
    let globalToggleBar = null;
    let globalCommentIframe = null;
    let isOpen = false;
    let isInitialized = false;
    let isListenerRegistered = false; // 重複登録防止フラグ

    const currentDomain = window.location.hostname.toLowerCase();

    // 1. 最初に必ずメッセージリスナーを1回だけ登録（最重要）
    listenToFilterUpdate();

    // 2. 初期ロード時のドメイン制限チェック
    if (shouldBlockByFilter()) {
        console.log(`[Nostrurl] フィルター設定に基づき、初期起動をスキップ: ${currentDomain}`);
        return; 
    }

    // 3. 制限をすり抜けたらUIセットアップ
    if (document.body) {
        setupParallelUI();
    } else {
        window.addEventListener('DOMContentLoaded', setupParallelUI);
    }

	// 4. フィルター判定ロジック
    function shouldBlockByFilter() {
        try {
            // ✨ 修正：localStorage ではなく GM_getValue から全サイト共通の設定を読み込む
            const saved = GM_getValue('nostrurl_global_config');
            if (!saved) return false;

            const config = JSON.parse(saved);
            const mode = config.FILTER_MODE || 'off';
            const domains = config.FILTER_DOMAINS || [];

            if (mode === 'whitelist') {
                return !domains.includes(currentDomain);
            } else if (mode === 'blacklist') {
                return domains.includes(currentDomain);
            }
        } catch (e) {
            console.error("[Nostrurl] 設定のパースに失敗:", e);
        }
        return false;
    }

    // ─── メッセージ受信（1回だけ実行される） ───
    function listenToFilterUpdate() {
        if (isListenerRegistered) return; // 既に登録されていればスキップ
        isListenerRegistered = true;

		window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'NOSTRURL_FILTER_UPDATE') {
                const { filterMode, filterDomains } = event.data;

                // ✨ 修正：メッセージを受け取ったら、即座に全サイト共通ストレージ（GM_setValue）に保存する
                const newConfig = { FILTER_MODE: filterMode, FILTER_DOMAINS: filterDomains };
                GM_setValue('nostrurl_global_config', JSON.stringify(newConfig));
                
                let currentShouldBlock = false;
                if (filterMode === 'whitelist') {
                    currentShouldBlock = !filterDomains.includes(currentDomain);
                } else if (filterMode === 'blacklist') {
                    currentShouldBlock = filterDomains.includes(currentDomain);
                }

                if (currentShouldBlock) {
                    // 非表示対象になった場合
                    if (isOpen) closeSidebar();
                    if (globalToggleBar) globalToggleBar.style.display = 'none';
                    if (globalCommentIframe) globalCommentIframe.style.display = 'none';
                } else {
                    // 表示対象になった場合
                    if (!globalToggleBar) {
                        setupParallelUI(); // UIがまだなければ新規作成（ここでの重複登録はフラグでガード済）
                    } else {
                        globalToggleBar.style.display = 'flex';
                        if (isOpen && globalCommentIframe) {
                            globalCommentIframe.style.display = 'block';
                        }
                    }
                }
            }
        });
    }

    function closeSidebar() {
        isOpen = false;
        if (globalToggleBar) {
            globalToggleBar.innerText = '◁';
            globalToggleBar.style.setProperty('transform', 'translateX(0px)', 'important');
        }
        if (globalCommentIframe) {
            globalCommentIframe.style.setProperty('transform', 'translateX(350px)', 'important');
        }
        document.documentElement.style.setProperty('margin-right', '0px', 'important');
        document.documentElement.style.setProperty('width', '100%', 'important');
    }

    // ─── UI構築 ───
    async function setupParallelUI() {
        if (document.getElementById('nostr-toggle-bar')) return;

        const targetBody = document.body;
        if (!targetBody) return;

        const toggleBar = document.createElement('div');
        toggleBar.id = 'nostr-toggle-bar';
        toggleBar.style.cssText = `
            position: fixed !important;
            bottom: 15% !important;
            right: 0px !important;
            width: 24px !important;
            height: 100px !important;
            background-color: #6a1b9a !important;
            color: #ffffff !important;
            border-radius: 8px 0 0 8px !important;
            cursor: pointer !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            font-size: 14px !important;
            font-weight: bold !important;
            box-shadow: -2px 0 10px rgba(0,0,0,0.3) !important;
            user-select: none !important;
            z-index: 1000000 !important;
            transition: transform 0.3s ease-in-out !important;
        `;
        toggleBar.innerText = '◁';

        const commentIframe = document.createElement('iframe');
        commentIframe.id = 'nostr-comment-iframe';
        commentIframe.style.cssText = `
            position: fixed !important;
            top: 0px !important;
            right: 0px !important;
            width: 350px !important;
            height: 100% !important;
            border: none !important;
            background: #1a1a1a !important;
            z-index: 999999 !important;
            transform: translateX(350px) !important;
            transition: transform 0.3s ease-in-out !important;
            box-shadow: -5px 0 15px rgba(0,0,0,0.5) !important;
        `;

        targetBody.appendChild(commentIframe);
        targetBody.appendChild(toggleBar);

        globalToggleBar = toggleBar;
        globalCommentIframe = commentIframe;

        toggleBar.onclick = async () => {
            isOpen = !isOpen;
            if (isOpen) {
                toggleBar.innerText = '▷';
                commentIframe.style.setProperty('transform', 'translateX(0px)', 'important');
                toggleBar.style.setProperty('transform', 'translateX(-350px)', 'important');

                document.documentElement.style.setProperty('margin-right', '350px', 'important');
                document.documentElement.style.setProperty('width', 'calc(100% - 350px)', 'important');
                document.documentElement.style.setProperty('transition', 'margin-right 0.3s ease, width 0.3s ease', 'important');

                if (!isInitialized) {
                    isInitialized = true;
                    await fetchAndInjectEverything(commentIframe);
                }
            } else {
                closeSidebar();
            }
        };
    }

	// ホワイト・ブラックのリストを反映するために Tampermonkey の特権通信を使うラッパー関数
    function customFetch(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'undefined') {
                // 万が一 @grant が効いていない環境用のフォールバック
                fetch(url).then(resolve).catch(reject);
                return;
            }

            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                onload: function(response) {
                    if (response.status >= 200 && response.status < 300) {
                        // 標準の fetch.text() や ok プロパティに似せたオブジェクトを返す
                        resolve({
                            ok: true,
                            text: () => Promise.resolve(response.responseText)
                        });
                    } else {
                        resolve({ ok: false });
                    }
                },
                onerror: function(err) {
                    reject(err);
                }
            });
        });
    }

	// ─── 各種インジェクション・パージ処理 ───
    async function fetchAndInjectEverything(iframe) {
        // ✨ あなたが一生懸命作ってくれた最高のデザイン（そのままキープ！）
        const cspNoticeHTML = `
            <div style="color: #ff5252; background: #1a1a1a; padding: 20px; font-family: sans-serif; font-size: 14px; line-height: 1.6; text-align: center;">
                <div style="font-size: 24px; margin-bottom: 10px;">⚠️</div>
                <strong>起動制限</strong><br>
                サイトのセキュリティ設定により、<br>
                Nostrurlの実行がブロックされました。<br>
                <span style="font-size: 12px; color: #aaa;">（拡張機能版をご利用ください）</span><br>
                <a href="https://nostrurl.github.io/base/" style="color: #a370f7; text-decoration: none;">Nostrurl's Lab</a> | <a href="https://github.com/nostrurl" style="color: #a370f7; text-decoration: none;">Nostrurl</a>
            </div>
        `;

        const networkNoticeHTML = `
            <div style="color: #ffb74d; background: #1a1a1a; padding: 20px; font-family: sans-serif; font-size: 14px; line-height: 1.6; text-align: center;">
                <div style="font-size: 24px; margin-bottom: 10px;">📡</div>
                <strong>通信エラー</strong><br>
                スクリプトの取得に失敗しました。<br>
                ネットワーク接続やGitHubの状態を<br>
                確認してください。<br>
                <span style="font-size: 11px; color: #aaa; display: inline-block; margin-top: 8px;">一時的なエラーの可能性があります</span><br>
                <a href="https://nostrurl.github.io/base/" style="color: #a370f7; text-decoration: none;">Nostrurl's Lab</a> | <a href="https://github.com/nostrurl" style="color: #a370f7; text-decoration: none;">Nostrurl</a>
            </div>
        `;

        try {
            const timestamp = Date.now();
            
            // 特権通信（customFetch）を使って安全にロード
            const [htmlRes, cssRes, filterJsRes, jsRes, purgeRes] = await Promise.all([
                customFetch(`${GITHUB_RAW_HTML_URL}?t=${timestamp}`).catch(() => null),
                customFetch(`${GITHUB_RAW_CSS_URL}?t=${timestamp}`).catch(() => null),
                customFetch(`${GITHUB_RAW_FILTER_JS_URL}?t=${timestamp}`).catch(() => null),
                customFetch(`${GITHUB_RAW_JS_URL}?t=${timestamp}`).catch(() => null),
                customFetch(`${GITHUB_RAW_PURGE_URL}?t=${timestamp}`).catch(() => null)
            ]);

            if (!htmlRes || !htmlRes.ok || !cssRes || !cssRes.ok || !jsRes || !jsRes.ok) throw new Error("HTTP_ERROR");

            const htmlText = await htmlRes.text();
            const cssText = await cssRes.text();
            const filterJsText = (filterJsRes && filterJsRes.ok) ? await filterJsRes.text() : "";
            let jsText = await jsRes.text();

            let purgeRules = [];
            if (purgeRes && purgeRes.ok) {
                const purgeText = await purgeRes.text();
                purgeRules = purgeText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
            }

            const targetUrl = new URL(window.location.href);
            for (const key of [...targetUrl.searchParams.keys()]) {
                if (purgeRules.some(r => r.endsWith('*') ? key.startsWith(r.slice(0, -1)) : key === r)) {
                    targetUrl.searchParams.delete(key);
                }
            }

            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
            iframeDoc.open();
            iframeDoc.write(htmlText);

            const styleElement = iframeDoc.createElement('style');
            styleElement.textContent = cssText;
            iframeDoc.head.appendChild(styleElement);

            const versionElement = iframeDoc.querySelector('.version-info');
            if (versionElement) versionElement.innerText = typeof GM_info !== 'undefined' ? `v${GM_info.script.version}` : 'v6.5.1';

            let isStorageAvailable = false;
            try {
                window.localStorage.setItem('__nostr_test__', '1');
                window.localStorage.removeItem('__nostr_test__');
                isStorageAvailable = true;
            } catch (e) {}

            iframe.contentWindow.REAL_PARENT_URL = targetUrl.toString();
            iframe.contentWindow.NOSTR_CHAT_ALIVE = false;
            iframe.contentWindow.PARENT_STORAGE_AVAILABLE = isStorageAvailable;

            // domain-filter.js の流し込み
            if (filterJsText) {
                const filterScriptElement = iframeDoc.createElement('script');
                filterScriptElement.textContent = filterJsText;
                iframeDoc.body.appendChild(filterScriptElement);
            }

            // chat.js の流し込み
            const scriptElement = iframeDoc.createElement('script');
            scriptElement.textContent = jsText;
            iframeDoc.body.appendChild(scriptElement);
            
            iframeDoc.close();

            setTimeout(() => {
                // もしCSPでチャットのスクリプト実行（NOSTR_CHAT_ALIVE）が止められたら
                if (!iframe.contentWindow.NOSTR_CHAT_ALIVE) {
                    // iframe の中身を一度空にして、自作のエラー画面をきれいに流し込む
                    try {
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                        iframeDoc.open();
                        iframeDoc.write(`
                            <body style="margin:0; background:#1a1a1a; display:flex; align-items:center; justify-content:center; height:100vh;">
                                ${cspNoticeHTML}
                            </body>
                        `);
                        iframeDoc.close();
                    } catch(e) {}
                }
            }, 1000);

        } catch (e) {
            // 通信エラーが起きたら、自作の親切な通信エラー画面を出す
            showNotice(iframe, networkNoticeHTML);
        }
    }

    function showNotice(iframe, html) {
        try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
            iframeDoc.open();
            iframeDoc.write(html);
            iframeDoc.close();
        } catch (e) {}
    }
})();