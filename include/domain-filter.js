// =================================================================
// ドメインフィルター管理モジュール (domain-filter.js)
// =================================================================

// ドメイン抽出ヘルパー（手動入力の揺らぎや親URLから純粋なホスト名を取り出す）
function extractDomain(inputUrl) {
    try {
        let target = inputUrl.trim();
        if (!/^https?:\/\//i.test(target)) {
            target = 'https://' + target;
        }
        return new URL(target).hostname.toLowerCase();
    } catch (e) {
        return inputUrl.trim().toLowerCase();
    }
}

// LocalStorageへの保存と、親(Tampermonkey)へのメッセージ送信を自己完結
function localSaveConfig(config) {
    try {
        localStorage.setItem('nostrurl_config', JSON.stringify(config));
        if (window.parent) {
            window.parent.postMessage({
                type: 'NOSTRURL_FILTER_UPDATE',
                filterMode: config.FILTER_MODE || 'off',
                filterDomains: config.FILTER_DOMAINS || []
            }, '*');
        }
    } catch (e) {
        console.error("[Nostrurl/list.js] 保存失敗:", e);
    }
}

function renderGuiFilterList(config, currentDomain, elements) {
    if (!elements.guiFilterList) return;
    elements.guiFilterList.innerHTML = '';
    const domains = config.FILTER_DOMAINS || [];
    
    // 検索クエリが本当に空（長さ0）の場合は検索処理自体をスキップさせる
    const rawSearch = elements.guiFilterSearch ? elements.guiFilterSearch.value.trim().toLowerCase() : '';
    const searchQuery = rawSearch.length > 0 ? rawSearch : null;

    if (domains.length === 0) {
        elements.guiFilterList.innerHTML = '<div style="color: #666; text-align: center; padding: 10px; font-size: 11px;">登録されたドメインはありません</div>';
        updateFilterToggleBtn(config, currentDomain, elements);
        return;
    }

    domains.forEach(domain => {
        const li = document.createElement('li');
        li.className = 'gui-filter-item';
        li.innerHTML = `<span>${domain}</span>`;

        // 検索クエリがある場合のみ、マッチ判定を行う
        if (searchQuery && !domain.includes(searchQuery)) {
            li.classList.add('hide-item');
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'gui-btn-del';
        delBtn.innerText = '削除';
        delBtn.onclick = () => {
            // 配列から削除
            config.FILTER_DOMAINS = config.FILTER_DOMAINS.filter(d => d !== domain);
            
            // 自己完結関数でLocalStorageとTampermonkeyを更新
            localSaveConfig(config);
            
            // 再レンダリング
            renderGuiFilterList(config, currentDomain, elements);
        };

        li.appendChild(delBtn);
        elements.guiFilterList.appendChild(li);
    });

    updateFilterToggleBtn(config, currentDomain, elements);
}

function updateFilterToggleBtn(config, currentDomain, elements) {
    if (!elements.guiFilterToggleCurrentBtn) return;
    const domains = config.FILTER_DOMAINS || [];
    const isRegistered = domains.includes(currentDomain);

    elements.guiFilterToggleCurrentBtn.classList.remove('state-add', 'state-remove');

    if (isRegistered) {
        elements.guiFilterToggleCurrentBtn.innerText = `❌ ${currentDomain} をリストから除外`;
        elements.guiFilterToggleCurrentBtn.classList.add('state-remove');
    } else {
        elements.guiFilterToggleCurrentBtn.innerText = `📄 ${currentDomain} をリストに登録`;
        elements.guiFilterToggleCurrentBtn.classList.add('state-add');
    }
}

window.NostrFilterManager = {
    extractDomain,
    renderGuiFilterList,
    updateFilterToggleBtn,
    localSaveConfig
};