// ==UserScript==
// @name         Nostrurl (ユーザースクリプト版)
// @namespace    nostrurl.github.io/base/
// @version      6.2.13
// @description  URLをタグにしたNostrコメント欄を設ける
// @author       Nostrurl
// @match        http://*/*
// @match        https://*/*
// @icon         https://raw.githubusercontent.com/nostrurl/base/refs/heads/main/assets/icon.png
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    if (window.top !== window.self) return;

    const GITHUB_RAW_HTML_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/chat.html";
    const GITHUB_RAW_CSS_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/chat.css";
    const GITHUB_RAW_JS_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/chat.js";
    // ★ 外部のブラックリストファイルのURL（環境に合わせてパスは調整してください）
    const GITHUB_RAW_PURGE_URL = "https://raw.githubusercontent.com/nostrurl/base/main/include/purge.txt";

    if (document.body) {
        setupParallelUI();
    } else {
        window.addEventListener('DOMContentLoaded', setupParallelUI);
    }

    async function setupParallelUI() {
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

        let isOpen = false;
        let isInitialized = false;

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
                toggleBar.innerText = '◁';
                commentIframe.style.setProperty('transform', 'translateX(350px)', 'important');
                toggleBar.style.setProperty('transform', 'translateX(0px)', 'important');
                document.documentElement.style.setProperty('margin-right', '0px', 'important');
                document.documentElement.style.setProperty('width', '100%', 'important');
            }
        };
    }

    async function fetchAndInjectEverything(iframe) {
        const cspNoticeHTML = `
            <div style="color: #ff5252; background: #1a1a1a; padding: 20px; font-family: sans-serif; font-size: 14px; line-height: 1.6; text-align: center;">
                <div style="font-size: 24px; margin-bottom: 10px;">⚠️</div>
                <strong>起動制限</strong><br>
                サイトのセキュリティ設定により、<br>
                Nostrurlの実行がブロックされました。<br>
                <span style="font-size: 12px; color: #aaa;">（拡張機能版をご利用ください）</span>
            </div>
        `;

        const networkNoticeHTML = `
            <div style="color: #ffb74d; background: #1a1a1a; padding: 20px; font-family: sans-serif; font-size: 14px; line-height: 1.6; text-align: center;">
                <div style="font-size: 24px; margin-bottom: 10px;">📡</div>
                <strong>通信エラー</strong><br>
                スクリプトの取得に失敗しました。<br>
                ネットワーク接続やGitHubの状態を<br>
                確認してください。<br>
                <span style="font-size: 11px; color: #aaa; display: inline-block; margin-top: 8px;">一時的なエラーの可能性があります</span>
            </div>
        `;

        try {
            const timestamp = Date.now();
            // ★ purgeRes を追加して、4つのファイルを同時に超高速ダウンロード
            const [htmlRes, cssRes, jsRes, purgeRes] = await Promise.all([
                fetch(`${GITHUB_RAW_HTML_URL}?t=${timestamp}`),
                fetch(`${GITHUB_RAW_CSS_URL}?t=${timestamp}`),
                fetch(`${GITHUB_RAW_JS_URL}?t=${timestamp}`),
                fetch(`${GITHUB_RAW_PURGE_URL}?t=${timestamp}`).catch(() => null) // purge.txtが無くても最悪起動はできるようにエラー逃げ道を用意
            ]);

            if (!htmlRes.ok || !cssRes.ok || !jsRes.ok) {
                throw new Error("HTTP_ERROR");
            }

            const htmlText = await htmlRes.text();
            const cssText = await cssRes.text();
            const jsText = await jsRes.text();

            // ─── purge.txt からクレンジング用リストを生成 ───
            let purgeRules = [];
            if (purgeRes && purgeRes.ok) {
                const purgeText = await purgeRes.text();
                purgeRules = purgeText.split('\n')
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#')); // 空行とコメントを除外
            }

            // ─── URLのクレンジング処理 ───
            const cleanUrl = new URL(window.location.href);
            const currentKeys = [...cleanUrl.searchParams.keys()];

            for (const key of currentKeys) {
                const shouldDelete = purgeRules.some(rule => {
                    if (rule.endsWith('*')) {
                        // 「utm_*」のような前方一致ルール（「*」を除いた部分で始まるかチェック）
                        return key.startsWith(rule.slice(0, -1));
                    }
                    // 通常の完全一致ルール
                    return key === rule;
                });

                if (shouldDelete) {
                    cleanUrl.searchParams.delete(key);
                }
            }
            // ──────────────────────────────

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

            iframe.contentWindow.REAL_PARENT_URL = cleanUrl.toString();
            iframe.contentWindow.NOSTR_CHAT_ALIVE = false;

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