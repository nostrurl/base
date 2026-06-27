// ==UserScript==
// @name         Nostrurl (ユーザースクリプト版)
// @namespace    nostrurl.github.io/base/
// @version      6.3.0
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

    // ★ GitHub Pagesの公開URL（リポジトリ名が base の場合）
    const PAGES_CHAT_URL = "https://nostrurl.github.io/base/include/chat.html";
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
                    await loadIframeViaPages(commentIframe);
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

    async function loadIframeViaPages(iframe) {
        let cleanUrl = window.location.href;

        // ─── purge.txt からクレンジング用リストを生成（ここだけ親サイト側で一度処理） ───
        try {
            const timestamp = Date.now();
            const purgeRes = await fetch(`${GITHUB_RAW_PURGE_URL}?t=${timestamp}`).catch(() => null);
            
            if (purgeRes && purgeRes.ok) {
                const purgeText = await purgeRes.text();
                const purgeRules = purgeText.split('\n')
                    .map(line => line.trim().replace(/\r$/, ''))
                    .filter(line => line && !line.startsWith('#'));

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
                cleanUrl = targetUrl.toString();
            }
        } catch (e) {
            console.warn("[Nostrurl] purge.txt の取得または解析に失敗しました。元のURLを使用します:", e);
        }

        // ─── GitHub Pages の URL にクレンジング済みのURLをパラメータとして付与して src に代入 ───
        const finalSrc = `${PAGES_CHAT_URL}?parentUrl=${encodeURIComponent(cleanUrl)}`;
        iframe.src = finalSrc;
        console.log("[Nostrurl] GitHub Pages経由でiframeを読み込みました:", finalSrc);
    }
})();