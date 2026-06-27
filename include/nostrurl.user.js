// ==UserScript==
// @name         Nostrurl (ユーザースクリプト版)
// @namespace    nostrurl.github.io/base/
// @version      6.5.0
// @description  URLをタグにしたNostrコメント欄を設ける
// @author       Nostrurl
// @match        http://*/*
// @match        https://*/*
// @icon         https://raw.githubusercontent.com/nostrurl/base/refs/heads/main/assets/icon.png
// @homepageURL  https://github.com/nostrurl/base
// @supportURL   https://github.com/nostrurl/base/issues
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    if (window.top !== window.self) return;

    const GITHUB_RAW_HTML_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/chat.html";
    const GITHUB_RAW_CSS_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/chat.css";
    const GITHUB_RAW_JS_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/chat.js";
    const GITHUB_RAW_PURGE_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/purge.txt";

    // ─── グローバルUI参照用の変数（イベントリスナーからも制御できるように外出し） ───
    let globalToggleBar = null;
    let globalCommentIframe = null;
    let isOpen = false;
    let isInitialized = false;

    // 現在のサイトのドメイン（ホスト名）を取得
    const currentDomain = window.location.hostname.toLowerCase();

    // =================================================================
    // 🛡️ 初期判定：このドメインでUIを表示すべきかどうかをチェック
    // =================================================================
    if (shouldBlockByFilter()) {
        console.log(`[Nostrurl] フィルター設定に基づき、このドメイン (${currentDomain}) では起動をスキップします。`);
        // メッセージリスナーだけは登録しておく（後から設定が変わる可能性があるため）
        listenToFilterUpdate();
        return; 
    }

    // 起動OKならUIをセットアップ
    if (document.body) {
        setupParallelUI();
    } else {
        window.addEventListener('DOMContentLoaded', setupParallelUI);
    }

    // フィルター設定をlocalStorageからパースしてブロック判定を行う関数
    function shouldBlockByFilter() {
        try {
            const saved = localStorage.getItem('nostrurl_config');
            if (!saved) return false; // 設定がなければ制限なし

            const config = JSON.parse(saved);
            const mode = config.FILTER_MODE || 'off';
            const domains = config.FILTER_DOMAINS || [];

            if (mode === 'whitelist') {
                // ホワイトリスト：登録されて「いない」ならブロック
                return !domains.includes(currentDomain);
            } else if (mode === 'blacklist') {
                // ブラックリスト：登録されて「いる」ならブロック
                return domains.includes(currentDomain);
            }
        } catch (e) {
            console.error("[Nostrurl] フィルター設定の読み込みに失敗しました:", e);
        }
        return false;
    }

    // =================================================================
    // 📡 子(iframe)からの設定更新メッセージを待ち受けるリスナー
    // =================================================================
    function listenToFilterUpdate() {
        window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'NOSTRURL_FILTER_UPDATE') {
                const { filterMode, filterDomains } = event.data;
                console.log("[Nostrurl] フィルター設定のリアルタイム更新を受信しました:", filterMode);

                // メッセージを元に、このサイトが非表示対象になったかを再計算
                let currentShouldBlock = false;
                if (filterMode === 'whitelist') {
                    currentShouldBlock = !filterDomains.includes(currentDomain);
                } else if (filterMode === 'blacklist') {
                    currentShouldBlock = filterDomains.includes(currentDomain);
                }

                // ブロック対象になった場合
                if (currentShouldBlock) {
                    // もしUIが既に生成されているなら、画面から跡形もなく消し去る（または強制的に閉じる）
                    if (isOpen) {
                        closeSidebar();
                    }
                    if (globalToggleBar) globalToggleBar.style.display = 'none';
                    if (globalCommentIframe) globalCommentIframe.style.display = 'none';
                    console.log(`[Nostrurl] 設定変更により、このサイト (${currentDomain}) は対象外となりました。UIを非表示にします。`);
                } else {
                    // ブロック解除された（表示対象になった）場合
                    if (!globalToggleBar) {
                        // 最初に読み込まれずUIが存在しない場合はセットアップを実行
                        setupParallelUI();
                    } else {
                        // 既にUIが存在して隠されていた場合は再表示
                        globalToggleBar.style.display = 'flex';
                        globalCommentIframe.style.display = 'block';
                    }
                }
            }
        });
    }

    // サイドバーを安全に閉じて親画面のレイアウトを戻すヘルパー関数
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

    // =================================================================
    // 🏗️ メインのUI構築
    // =================================================================
    async function setupParallelUI() {
        // 多重生成防止
        if (document.getElementById('nostr-toggle-bar')) return;

        const targetBody = document.body;

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

        // グローバル参照へ代入
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

        // メッセージリスナーを一度だけ開始
        listenToFilterUpdate();
    }

    async function fetchAndInjectEverything(iframe) {
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
            const [htmlRes, cssRes, jsRes, purgeRes] = await Promise.all([
                fetch(`${GITHUB_RAW_HTML_URL}?t=${timestamp}`),
                fetch(`${GITHUB_RAW_CSS_URL}?t=${timestamp}`),
                fetch(`${GITHUB_RAW_JS_URL}?t=${timestamp}`),
                fetch(`${GITHUB_RAW_PURGE_URL}?t=${timestamp}`).catch(() => null)
            ]);

            if (!htmlRes.ok || !cssRes.ok || !jsRes.ok) {
                throw new Error("HTTP_ERROR");
            }

            const htmlText = await htmlRes.text();
            const cssText = await cssRes.text();
            let jsText = await jsRes.text();

            let purgeRules = [];
            if (purgeRes && purgeRes.ok) {
                const purgeText = await purgeRes.text();
                purgeRules = purgeText.split('\n')
                    .map(line => line.trim().replace(/\r$/, ''))
                    .filter(line => line && !line.startsWith('#'));
            }

            const targetUrl = new URL(window.location.href);
            const currentKeys = [...targetUrl.searchParams.keys()];

            for (const key of currentKeys) {
                const shouldDelete = purgeRules.some(rule => {
                    if (rule.endsWith('*')) {
                        return key.startsWith(rule.slice(0, -1));
                    }
                    return key === rule;
                });

                if (shouldDelete) {
                    targetUrl.searchParams.delete(key);
                }
            }

            const cleanUrl = targetUrl.toString();

            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
            iframeDoc.open();
            iframeDoc.write(htmlText);

            const styleElement = iframeDoc.createElement('style');
            styleElement.textContent = cssText;
            iframeDoc.head.appendChild(styleElement);

            const versionElement = iframeDoc.querySelector('.version-info');
            if (versionElement) {
                versionElement.innerText = typeof GM_info !== 'undefined' ? `v${GM_info.script.version}` : '不正なバージョン';
            }

            let isStorageAvailable = false;
            try {
                window.localStorage.setItem('__nostr_test__', '1');
                window.localStorage.removeItem('__nostr_test__');
                isStorageAvailable = true;
            } catch (e) {
                console.warn("[Nostrurl] 親ドメインでのlocalStorage利用が制限されています:", e.message);
            }

            iframe.contentWindow.REAL_PARENT_URL = cleanUrl;
            iframe.contentWindow.NOSTR_CHAT_ALIVE = false;
            iframe.contentWindow.PARENT_STORAGE_AVAILABLE = isStorageAvailable;

            const scriptElement = iframeDoc.createElement('script');
            scriptElement.textContent = jsText;
            iframeDoc.body.appendChild(scriptElement);
            iframeDoc.close();

            console.log("[Nostrurl] インクルード処理完了（生存確認開始）");

            setTimeout(() => {
                if (!iframe.contentWindow.NOSTR_CHAT_ALIVE) {
                    console.warn("[Nostrurl] スクリプトの実行拒否（CSP）を検知しました。");
                    showNotice(iframe, cspNoticeHTML);
                }
            }, 1000);

        } catch (e) {
            console.warn("[Nostrurl] 通信エラーまたは取得失敗を検知しました:", e.message);
            showNotice(iframe, networkNoticeHTML);
        }
    }

    function showNotice(iframe, html) {
        try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
            iframeDoc.open();
            iframeDoc.write(html);
            iframeDoc.close();
        } catch (e) {
            console.error("[Nostrurl] UIの書き換えに失敗:", e);
        }
    }
})();