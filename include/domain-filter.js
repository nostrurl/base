// =================================================================
// ドメインフィルター管理モジュール (list.js)
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

// フィルターリストのレンダリングロジック
function renderGuiFilterList(config, currentDomain, elements) {
    if (!elements.guiFilterList) return;
    elements.guiFilterList.innerHTML = '';
    const domains = config.FILTER_DOMAINS || [];
    const searchQuery = elements.guiFilterSearch ? elements.guiFilterSearch.value.toLowerCase().trim() : '';

    if (domains.length === 0) {
        elements.guiFilterList.innerHTML = '<div style="color: #666; text-align: center; padding: 10px; font-size: 11px;">登録されたドメインはありません</div>';
        updateFilterToggleBtn(config, currentDomain, elements);
        return;
    }

    domains.forEach(domain => {
        const li = document.createElement('li');
        li.className = 'gui-filter-item';
        li.innerHTML = `<span>${domain}</span>`;

        // 検索文字にマッチしない場合は非表示クラスを付与
        if (searchQuery && !domain.includes(searchQuery)) {
            li.classList.add('hide-item');
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'gui-btn-del';
        delBtn.innerText = '削除';
        delBtn.onclick = () => {
            config.FILTER_DOMAINS = config.FILTER_DOMAINS.filter(d => d !== domain);
            saveConfig(config);
            renderGuiFilterList(config, currentDomain, elements);
        };

        li.appendChild(delBtn);
        elements.guiFilterList.appendChild(li);
    });

    updateFilterToggleBtn(config, currentDomain, elements);
}

// クイック登録・解除ボタンの状態（テキストと緑／赤の色分けクラス）を動的更新する
function updateFilterToggleBtn(config, currentDomain, elements) {
    if (!elements.guiFilterToggleCurrentBtn) return;
    const domains = config.FILTER_DOMAINS || [];
    const isRegistered = domains.includes(currentDomain);

    // 一旦色分けクラスをすべて剥がす
    elements.guiFilterToggleCurrentBtn.classList.remove('state-add', 'state-remove');

    if (isRegistered) {
        elements.guiFilterToggleCurrentBtn.innerText = `❌ ${currentDomain} をリストから除外`;
        elements.guiFilterToggleCurrentBtn.classList.add('state-remove');
    } else {
        elements.guiFilterToggleCurrentBtn.innerText = `📄 ${currentDomain} をリストに登録`;
        elements.guiFilterToggleCurrentBtn.classList.add('state-add');
    }
}

// chat.js が求めている「NostrFilterManager」という名前でグローバルに公開する
window.NostrFilterManager = {
    extractDomain,
    renderGuiFilterList,
    updateFilterToggleBtn
};