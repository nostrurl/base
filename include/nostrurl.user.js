// ==UserScript==
// @name         Nostrurl (ユーザースクリプト版)
// @namespace    nostrurl.github.io/base/
// @version      6.3.3
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

    function setupParallelUI() {
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

		// 権限を与える
        //commentIframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
		commentIframe.setAttribute('allow', 'cross-origin-isolated');
        commentIframe.name = 'nostr-comment-frame';

        targetBody.appendChild(commentIframe);
        targetBody.appendChild(toggleBar);

        let isOpen = false;
        let isInitialized = false;

	// ★ 修正後：onclick から「async」を外します
        toggleBar.onclick = () => {
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
                    // await を使わず、普通に呼び出す
                    loadIframeViaPages(commentIframe);
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

    // ★ 修正後：こちらも「async」を外し、fetchの部分を .then() に変更します
    function loadIframeViaPages(iframe) {
        let cleanUrl = window.location.href;

        const timestamp = Date.now();
        fetch(`${GITHUB_RAW_PURGE_URL}?t=${timestamp}`)
            .then(purgeRes => {
                if (purgeRes && purgeRes.ok) {
                    return purgeRes.text();
                }
                throw new Error("fetch failed");
            })
            .then(purgeText => {
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
            })
            .catch(e => {
                console.warn("[Nostrurl] purge.txt の取得に失敗したか、スキップしました。元のURLを使用します:", e);
            })
            .finally(() => {
                // 最後に必ず src を代入して iframe を読み込ませる
                const finalSrc = `${PAGES_CHAT_URL}?parentUrl=${encodeURIComponent(cleanUrl)}`;
                iframe.src = finalSrc;
                console.log("[Nostrurl] GitHub Pages経由でiframeを読み込みました:", finalSrc);
            });
    }
})();