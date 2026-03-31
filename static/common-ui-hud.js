/**
 * Live2D UI HUD - Agent任务HUD组件
 * 包含任务面板、任务卡片、HUD拖拽功能
 */

window.AgentHUD = window.AgentHUD || {};

/**
 * 精简 AI 生成的冗长任务描述为用户友好的短文本
 * 例: "设置一个15分钟后的一次性提醒，内容为'起来活动'" → "15分钟后 起来活动"
 * 例: "打开浏览器搜索今天的天气" → "搜索今天的天气"
 */
window.AgentHUD._shortenDesc = function (desc) {
    if (!desc) return desc;
    let s = desc.trim();
    // 去掉开头的冗余动词
    s = s.replace(/^(请|帮我?|帮忙|设置一个?|创建一个?|添加一个?|发送一[条个]?|执行|进行|打开|启动|调用|运行)\s*/, '');
    // 去掉"的一次性提醒"
    s = s.replace(/的一次性提醒/g, '');
    // "，内容为'xxx'" → " xxx"
    s = s.replace(/[，,]\s*(内容[为是]|提醒内容[为是])\s*['""\u2018\u2019\u201C\u201D「」]?/g, ' ');
    // "提醒用户" → ""
    s = s.replace(/提醒用户/g, '');
    // 去掉引号
    s = s.replace(/['""\u2018\u2019\u201C\u201D「」]/g, '');
    // 去掉尾部的"的提醒"
    s = s.replace(/[的地得]?提醒$/, '');
    s = s.trim().replace(/^[，,。.、\s]+|[，,。.、\s]+$/g, '');
    return s.slice(0, 50) || desc.slice(0, 50);
};

// 缓存当前显示器边界信息（多屏幕支持）
let cachedDisplayHUD = {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight
};

// 更新显示器边界信息
async function updateDisplayBounds(centerX, centerY) {
    if (!window.electronScreen || !window.electronScreen.getAllDisplays) {
        // 非 Electron 环境，使用窗口大小
        cachedDisplayHUD = {
            x: 0,
            y: 0,
            width: window.innerWidth,
            height: window.innerHeight
        };
        return;
    }

    try {
        const displays = await window.electronScreen.getAllDisplays();
        if (!displays || displays.length === 0) {
            // 没有显示器信息，使用窗口大小
            cachedDisplayHUD = {
                x: 0,
                y: 0,
                width: window.innerWidth,
                height: window.innerHeight
            };
            return;
        }

        // 如果提供了中心点坐标，找到包含该点的显示器
        if (typeof centerX === 'number' && typeof centerY === 'number') {
            for (const display of displays) {
                if (centerX >= display.x && centerX < display.x + display.width &&
                    centerY >= display.y && centerY < display.y + display.height) {
                    cachedDisplayHUD = {
                        x: display.x,
                        y: display.y,
                        width: display.width,
                        height: display.height
                    };
                    return;
                }
            }
        }

        // 否则使用主显示器或第一个显示器
        const primaryDisplay = displays.find(d => d.primary) || displays[0];
        cachedDisplayHUD = {
            x: primaryDisplay.x,
            y: primaryDisplay.y,
            width: primaryDisplay.width,
            height: primaryDisplay.height
        };
    } catch (error) {
        console.warn('Failed to update display bounds:', error);
        // 失败时使用窗口大小
        cachedDisplayHUD = {
            x: 0,
            y: 0,
            width: window.innerWidth,
            height: window.innerHeight
        };
    }
}

// 将 updateDisplayBounds 暴露到全局，确保其他脚本或模块可以调用（兼容不同加载顺序）
try {
    if (typeof window !== 'undefined') window.updateDisplayBounds = updateDisplayBounds;
} catch (e) {
    // 忽略不可用的全局对象情形
}

// 创建Agent弹出框内容
window.AgentHUD._createAgentPopupContent = function (popup) {
    // 添加状态显示栏 - Fluent Design
    const statusDiv = document.createElement('div');
    statusDiv.id = 'live2d-agent-status';
    Object.assign(statusDiv.style, {
        fontSize: '12px',
        color: 'var(--neko-popup-accent, #2a7bc4)',
        padding: '6px 8px',
        borderRadius: '4px',
        background: 'var(--neko-popup-accent-bg, rgba(42, 123, 196, 0.05))',
        marginBottom: '8px',
        minHeight: '20px',
        textAlign: 'center'
    });
    // 【状态机】初始显示"查询中..."，由状态机更新
    statusDiv.textContent = window.t ? window.t('settings.toggles.checking') : '查询中...';
    statusDiv.setAttribute('data-i18n', 'settings.toggles.checking');
    popup.appendChild(statusDiv);

    // 【状态机严格控制】所有 agent 开关默认禁用，title显示查询中
    // 只有状态机检测到可用性后才逐个恢复交互
    const agentToggles = [
        {
            id: 'agent-master',
            label: window.t ? window.t('settings.toggles.agentMaster') : 'Agent总开关',
            labelKey: 'settings.toggles.agentMaster',
            initialDisabled: true,
            initialTitle: window.t ? window.t('settings.toggles.checking') : '查询中...'
        },
        {
            id: 'agent-keyboard',
            label: window.t ? window.t('settings.toggles.keyboardControl') : '键鼠控制',
            labelKey: 'settings.toggles.keyboardControl',
            initialDisabled: true,
            initialTitle: window.t ? window.t('settings.toggles.checking') : '查询中...'
        },
        {
            id: 'agent-browser',
            label: window.t ? window.t('settings.toggles.browserUse') : 'Browser Control',
            labelKey: 'settings.toggles.browserUse',
            initialDisabled: true,
            initialTitle: window.t ? window.t('settings.toggles.checking') : '查询中...'
        },
        {
            id: 'agent-user-plugin',
            label: window.t ? window.t('settings.toggles.userPlugin') : '用户插件',
            labelKey: 'settings.toggles.userPlugin',
            initialDisabled: true,
            initialTitle: window.t ? window.t('settings.toggles.checking') : '查询中...'
        },
        {
            id: 'agent-openfang',
            label: window.t ? window.t('settings.toggles.openfang') : '虚拟机',
            labelKey: 'settings.toggles.openfang',
            initialDisabled: true,
            initialTitle: window.t ? window.t('settings.toggles.checking') : '查询中...'
        }
    ];

    agentToggles.forEach(toggle => {
        const toggleItem = this._createToggleItem(toggle, popup);
        popup.appendChild(toggleItem);

        if (toggle.id === 'agent-user-plugin' && typeof this._createSidePanelContainer === 'function') {
            const sidePanel = this._createSidePanelContainer();
            sidePanel.style.flexDirection = 'column';
            sidePanel.style.alignItems = 'stretch';
            sidePanel.style.gap = '4px';
            sidePanel.style.padding = '6px 10px';
            sidePanel._anchorElement = toggleItem;
            sidePanel._popupElement = popup;

            const configBtn = document.createElement('div');
            const LABEL_KEY = 'settings.toggles.pluginManagementPanel';
            const LABEL_FALLBACK = '管理面板';
            Object.assign(configBtn.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 8px',
                cursor: 'pointer',
                borderRadius: '6px',
                fontSize: '12px',
                whiteSpace: 'nowrap',
                color: 'var(--neko-popup-text, #333)',
                transition: 'background 0.15s ease'
            });
            const configIcon = document.createElement('span');
            configIcon.textContent = '⚙';
            configIcon.style.fontSize = '13px';
            const configLabel = document.createElement('span');
            configLabel.textContent = window.t ? window.t(LABEL_KEY) : LABEL_FALLBACK;
            configLabel.setAttribute('data-i18n', LABEL_KEY);
            configLabel.style.userSelect = 'none';
            const configArrow = document.createElement('span');
            configArrow.textContent = '↗';
            configArrow.style.marginLeft = 'auto';
            configArrow.style.opacity = '0.5';
            configArrow.style.fontSize = '11px';
            configBtn.appendChild(configIcon);
            configBtn.appendChild(configLabel);
            configBtn.appendChild(configArrow);

            configBtn.addEventListener('mouseenter', () => {
                configBtn.style.background = 'var(--neko-popup-hover, rgba(68,183,254,0.1))';
            });
            configBtn.addEventListener('mouseleave', () => {
                configBtn.style.background = 'transparent';
            });

            let isOpening = false;
            configBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isOpening) return;
                isOpening = true;
                const dashboardUrl = '/api/agent/user_plugin/dashboard';
                const width = Math.min(1280, Math.round(screen.width * 0.8));
                const height = Math.min(900, Math.round(screen.height * 0.8));
                const left = Math.max(0, Math.floor((screen.width - width) / 2));
                const top = Math.max(0, Math.floor((screen.height - height) / 2));
                const features = `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes`;
                if (typeof window.openOrFocusWindow === 'function') {
                    window.openOrFocusWindow(dashboardUrl, 'neko_plugin_dashboard', features);
                } else {
                    window.open(dashboardUrl, 'neko_plugin_dashboard', features);
                }
                setTimeout(() => { isOpening = false; }, 500);
            });

            sidePanel.appendChild(configBtn);

            const KB_MODE_KEY = 'neko.kb.direct_mode';
            const KB_DOC_KEY = 'neko.kb.document_name';
            const KB_DOC_TOTAL_KEY = 'neko.kb.document_total';
            const KB_API_BASE = 'http://127.0.0.1:48916';
            const AGENT_API_BASE = 'http://127.0.0.1:48915';
            const KB_MANAGER_THEME = {
                headerGradient: 'linear-gradient(to right, #4BD4FD, #17A7FF)',
                panelGradient: 'linear-gradient(180deg, rgba(240,248,255,0.99), rgba(227,244,255,0.99))',
                panelBorder: '#b3e5fc',
                lineSoft: 'rgba(179, 229, 252, 0.85)',
                linePrimary: 'rgba(64, 197, 241, 0.45)',
                actionText: '#40C5F1',
                actionFill: 'rgba(64, 197, 241, 0.16)',
                actionFillHover: 'rgba(64, 197, 241, 0.24)',
                danger: '#ff5252',
                dangerHover: '#ff4444',
                dangerActive: '#e53935',
                dangerBg: 'rgba(255, 255, 255, 0.95)',
                dangerBorder: 'rgba(255, 82, 82, 0.35)',
                titleGlow: '#22b3ff'
            };

            const kbState = {
                enabled: localStorage.getItem(KB_MODE_KEY) === '1',
                documentName: localStorage.getItem(KB_DOC_KEY) || '',
                documentTotal: Number(localStorage.getItem(KB_DOC_TOTAL_KEY) || '0')
            };

            const kbModeBtn = document.createElement('div');
            Object.assign(kbModeBtn.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 8px',
                cursor: 'pointer',
                borderRadius: '6px',
                fontSize: '12px',
                whiteSpace: 'nowrap',
                color: 'var(--neko-popup-text, #333)',
                transition: 'background 0.15s ease'
            });

            const kbModeIcon = document.createElement('span');
            kbModeIcon.textContent = '📚';
            kbModeIcon.style.fontSize = '13px';

            const kbModeLabel = document.createElement('span');
            kbModeLabel.textContent = '知识库直连';
            kbModeLabel.style.userSelect = 'none';

            const kbModeBadge = document.createElement('span');
            Object.assign(kbModeBadge.style, {
                marginLeft: 'auto',
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: '999px',
                border: '1px solid rgba(0,0,0,0.1)'
            });

            function updateKbModeBadge() {
                kbModeBadge.textContent = kbState.enabled ? 'ON' : 'OFF';
                kbModeBadge.style.background = kbState.enabled ? 'rgba(68,183,254,0.16)' : 'rgba(0,0,0,0.04)';
                kbModeBadge.style.color = kbState.enabled ? '#2a7bc4' : '#666';
            }

            updateKbModeBadge();
            kbModeBtn.appendChild(kbModeIcon);
            kbModeBtn.appendChild(kbModeLabel);
            kbModeBtn.appendChild(kbModeBadge);

            kbModeBtn.addEventListener('mouseenter', () => {
                kbModeBtn.style.background = 'var(--neko-popup-hover, rgba(68,183,254,0.1))';
            });
            kbModeBtn.addEventListener('mouseleave', () => {
                kbModeBtn.style.background = 'transparent';
            });

            const uploadBtn = document.createElement('div');
            Object.assign(uploadBtn.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 8px',
                cursor: 'pointer',
                borderRadius: '6px',
                fontSize: '12px',
                whiteSpace: 'nowrap',
                color: 'var(--neko-popup-text, #333)',
                transition: 'background 0.15s ease'
            });

            const manageBtn = document.createElement('div');
            Object.assign(manageBtn.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 8px',
                cursor: 'pointer',
                borderRadius: '6px',
                fontSize: '12px',
                whiteSpace: 'nowrap',
                color: 'var(--neko-popup-text, #333)',
                transition: 'background 0.15s ease'
            });

            const uploadIcon = document.createElement('span');
            uploadIcon.textContent = '⤴';
            uploadIcon.style.fontSize = '13px';

            const uploadLabel = document.createElement('span');
            uploadLabel.textContent = '上传文档';
            uploadLabel.style.userSelect = 'none';

            const uploadArrow = document.createElement('span');
            uploadArrow.textContent = '↗';
            uploadArrow.style.marginLeft = 'auto';
            uploadArrow.style.opacity = '0.5';
            uploadArrow.style.fontSize = '11px';

            uploadBtn.appendChild(uploadIcon);
            uploadBtn.appendChild(uploadLabel);
            uploadBtn.appendChild(uploadArrow);

            const manageIcon = document.createElement('span');
            manageIcon.textContent = '▤';
            manageIcon.style.fontSize = '13px';

            const manageLabel = document.createElement('span');
            manageLabel.textContent = '文档管理';
            manageLabel.style.userSelect = 'none';

            const manageArrow = document.createElement('span');
            manageArrow.textContent = '↗';
            manageArrow.style.marginLeft = 'auto';
            manageArrow.style.opacity = '0.5';
            manageArrow.style.fontSize = '11px';

            manageBtn.appendChild(manageIcon);
            manageBtn.appendChild(manageLabel);
            manageBtn.appendChild(manageArrow);

            uploadBtn.addEventListener('mouseenter', () => {
                uploadBtn.style.background = 'var(--neko-popup-hover, rgba(68,183,254,0.1))';
            });
            uploadBtn.addEventListener('mouseleave', () => {
                uploadBtn.style.background = 'transparent';
            });

            manageBtn.addEventListener('mouseenter', () => {
                manageBtn.style.background = 'var(--neko-popup-hover, rgba(68,183,254,0.1))';
            });
            manageBtn.addEventListener('mouseleave', () => {
                manageBtn.style.background = 'transparent';
            });

            const kbDocHint = document.createElement('div');
            Object.assign(kbDocHint.style, {
                fontSize: '11px',
                opacity: '0.75',
                padding: '2px 8px 0 8px',
                lineHeight: '1.4'
            });

            function updateKbDocHint() {
                if (kbState.documentName) {
                    if (kbState.documentTotal > 1) {
                        kbDocHint.textContent = `最近上传: ${kbState.documentName} (共 ${kbState.documentTotal} 篇)`;
                    } else {
                        kbDocHint.textContent = `已上传: ${kbState.documentName}`;
                    }
                } else {
                    kbDocHint.textContent = '未上传文档';
                }
            }

            updateKbDocHint();

            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '*/*';
            fileInput.style.display = 'none';

            let managerOverlay = null;
            let managerPanel = null;
            let managerRows = null;
            let managerTitle = null;
            let managerLoading = false;
            let managerFoldersCache = [];
            let managerDocsCache = [];
            let managerCurrentFolder = '';
            let managerFilterKeyword = '';
            let managerSortBy = 'updated_desc';
            let managerSearchInput = null;
            let managerSortSelect = null;
            let managerBreadcrumb = null;
            let managerRenameFolderBtn = null;
            let managerDeleteFolderBtn = null;
            let managerInlineStatus = null;
            let managerHudDisabledNodes = [];
            let managerDragState = null;
            let managerResizeState = null;
            let managerMaximizedSnapshot = null;
            let managerPreviewOverlay = null;
            let managerPreviewPanel = null;
            let managerPreviewDragState = null;
            let managerPreviewResizeState = null;
            let managerPreviewMaximizedSnapshot = null;
            let managerPreviewTitle = null;
            let managerPreviewBody = null;
            let managerMathJaxReadyPromise = null;
            const managerUploadInput = document.createElement('input');
            managerUploadInput.type = 'file';
            managerUploadInput.accept = '*/*';
            managerUploadInput.style.display = 'none';
            let kbPluginEnsureTs = 0;

            async function ensureKnowledgeBasePluginReady() {
                const now = Date.now();
                if (now - kbPluginEnsureTs < 3000) {
                    return;
                }
                kbPluginEnsureTs = now;

                try {
                    const flagsResp = await fetch(`${AGENT_API_BASE}/agent/flags`);
                    if (flagsResp.ok) {
                        const flagsData = await flagsResp.json();
                        const enabled = !!(
                            flagsData &&
                            flagsData.agent_flags &&
                            flagsData.agent_flags.user_plugin_enabled
                        );
                        if (enabled) {
                            return;
                        }
                    }
                } catch (_err) {
                    // Continue and try best-effort enable below.
                }

                try {
                    await fetch(`${AGENT_API_BASE}/agent/flags`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ user_plugin_enabled: true })
                    });
                    // Give embedded plugin lifecycle a short warm-up window.
                    await new Promise((resolve) => setTimeout(resolve, 600));
                } catch (_err) {
                    // Keep runPluginEntry behavior unchanged; downstream call will surface concrete error.
                }
            }

            async function runPluginEntry(entryId, args) {
                await ensureKnowledgeBasePluginReady();
                const maxAttempts = 2;
                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    const createResp = await fetch(`${KB_API_BASE}/runs`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            plugin_id: 'knowledge_base',
                            entry_id: entryId,
                            args: args || {}
                        })
                    });

                    if (!createResp.ok) {
                        throw new Error(`创建任务失败 (${createResp.status})`);
                    }

                    const createData = await createResp.json();
                    const runId = createData && createData.run_id;
                    if (!runId) {
                        throw new Error('任务创建返回异常');
                    }

                    const started = Date.now();
                    const timeoutMs = 200000;
                    let runData = null;
                    let pollDelayMs = 90;

                    while (Date.now() - started < timeoutMs) {
                        const runResp = await fetch(`${KB_API_BASE}/runs/${encodeURIComponent(runId)}`);
                        if (!runResp.ok) {
                            throw new Error(`查询任务失败 (${runResp.status})`);
                        }
                        runData = await runResp.json();
                        const status = runData && runData.status;
                        if (status === 'queued' || status === 'running') {
                            await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
                            pollDelayMs = Math.min(450, Math.floor(pollDelayMs * 1.4));
                            continue;
                        }
                        break;
                    }

                    if (!runData || (runData.status !== 'succeeded' && runData.status !== 'failed')) {
                        throw new Error('任务超时');
                    }

                    if (runData.status === 'failed') {
                        const errCode = runData.error && runData.error.code ? String(runData.error.code) : '';
                        const isRetryable = errCode === 'NOT_READY' && attempt + 1 < maxAttempts;
                        if (isRetryable) {
                            await ensureKnowledgeBasePluginReady();
                            await new Promise((resolve) => setTimeout(resolve, 1200));
                            continue;
                        }
                        const errMsg = runData.error && runData.error.message ? runData.error.message : '任务执行失败';
                        throw new Error(errMsg);
                    }

                    const exportResp = await fetch(`${KB_API_BASE}/runs/${encodeURIComponent(runId)}/export?limit=50`);
                    if (!exportResp.ok) {
                        throw new Error(`读取任务结果失败 (${exportResp.status})`);
                    }
                    const exportData = await exportResp.json();
                    const items = Array.isArray(exportData && exportData.items) ? exportData.items : [];
                    const trigger = items.find((it) => it && it.label === 'trigger_response') || items[items.length - 1] || null;
                    const triggerJson = trigger && trigger.json ? trigger.json : null;
                    const triggerData = triggerJson && triggerJson.data ? triggerJson.data : null;
                    return {
                        run: runData,
                        trigger: triggerJson,
                        data: triggerData
                    };
                }

                throw new Error('插件暂未就绪，请稍后重试');
            }

            function ensureManagerDialog() {
                if (managerOverlay) {
                    return;
                }

                managerOverlay = document.createElement('div');
                Object.assign(managerOverlay.style, {
                    position: 'fixed',
                    inset: '0',
                    zIndex: '2147483000',
                    background: 'rgba(20, 46, 70, 0.30)',
                    display: 'none',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backdropFilter: 'blur(3px)',
                    pointerEvents: 'auto'
                });

                const panel = document.createElement('div');
                Object.assign(panel.style, {
                    width: 'min(700px, 92vw)',
                    height: 'min(78vh, 720px)',
                    minWidth: '360px',
                    minHeight: '280px',
                    background: KB_MANAGER_THEME.panelGradient,
                    border: `1px solid ${KB_MANAGER_THEME.linePrimary}`,
                    borderRadius: '14px',
                    boxShadow: '0 20px 48px rgba(10, 29, 52, 0.26)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    resize: 'none',
                    position: 'fixed',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    zIndex: '2147483001',
                    pointerEvents: 'auto',
                    willChange: 'left, top'
                });
                managerPanel = panel;

                const managerExpandBtn = document.createElement('button');
                managerExpandBtn.type = 'button';
                managerExpandBtn.textContent = '⤢';
                managerExpandBtn.title = '扩展窗口';
                Object.assign(managerExpandBtn.style, {
                    position: 'absolute',
                    right: '10px',
                    bottom: '10px',
                    width: '28px',
                    height: '28px',
                    borderRadius: '999px',
                    border: '1px solid rgba(255,255,255,0.62)',
                    background: 'linear-gradient(180deg, #4BD4FD, #1E88E5)',
                    color: '#ffffff',
                    fontSize: '14px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    boxShadow: '0 6px 16px rgba(30, 136, 229, 0.38)',
                    zIndex: '3'
                });

                const header = document.createElement('div');
                Object.assign(header.style, {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 14px',
                    background: KB_MANAGER_THEME.headerGradient,
                    borderBottom: `1px solid ${KB_MANAGER_THEME.linePrimary}`,
                    cursor: 'move',
                    userSelect: 'none'
                });

                managerTitle = document.createElement('div');
                managerTitle.textContent = '知识库文档管理';
                Object.assign(managerTitle.style, {
                    fontSize: '15px',
                    fontWeight: '700',
                    color: '#ffffff',
                    textShadow: `0 1px 2px ${KB_MANAGER_THEME.titleGlow}`
                });

                const closeBtn = document.createElement('button');
                closeBtn.type = 'button';
                closeBtn.textContent = '关闭';
                Object.assign(closeBtn.style, {
                    border: '1px solid rgba(255,255,255,0.58)',
                    background: 'rgba(255,255,255,0.24)',
                    color: '#ffffff',
                    borderRadius: '999px',
                    padding: '4px 10px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: '600'
                });

                const toolbar = document.createElement('div');
                Object.assign(toolbar.style, {
                    display: 'flex',
                    gap: '8px',
                    flexWrap: 'wrap',
                    padding: '10px 14px',
                    borderBottom: `1px dashed ${KB_MANAGER_THEME.linePrimary}`,
                    background: 'rgba(255,255,255,0.75)'
                });

                const refreshBtn = document.createElement('button');
                refreshBtn.type = 'button';
                refreshBtn.textContent = '刷新列表';
                const backFolderBtn = document.createElement('button');
                backFolderBtn.type = 'button';
                backFolderBtn.textContent = '返回文件夹';
                const createFoldersBtn = document.createElement('button');
                createFoldersBtn.type = 'button';
                createFoldersBtn.textContent = '新建文件夹';
                const renameFolderBtn = document.createElement('button');
                renameFolderBtn.type = 'button';
                renameFolderBtn.textContent = '重命名当前文件夹';
                const deleteFolderBtn = document.createElement('button');
                deleteFolderBtn.type = 'button';
                deleteFolderBtn.textContent = '删除当前文件夹';
                const uploadDocBtn = document.createElement('button');
                uploadDocBtn.type = 'button';
                uploadDocBtn.textContent = '上传文档';

                [refreshBtn, backFolderBtn, createFoldersBtn, renameFolderBtn, deleteFolderBtn, uploadDocBtn].forEach((btn) => {
                    Object.assign(btn.style, {
                        border: `1px solid ${KB_MANAGER_THEME.lineSoft}`,
                        background: `linear-gradient(180deg, ${KB_MANAGER_THEME.actionFill}, rgba(255,255,255,0.92))`,
                        color: KB_MANAGER_THEME.actionText,
                        borderRadius: '999px',
                        padding: '5px 12px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: '600'
                    });
                });

                Object.assign(deleteFolderBtn.style, {
                    color: '#c62828',
                    border: '1px solid rgba(244, 67, 54, 0.25)',
                    background: 'linear-gradient(180deg, rgba(244,67,54,0.10), rgba(255,255,255,0.92))'
                });

                managerSearchInput = document.createElement('input');
                managerSearchInput.type = 'text';
                managerSearchInput.placeholder = '搜索文档名...';
                Object.assign(managerSearchInput.style, {
                    flex: '1',
                    minWidth: '180px',
                    border: `1px solid ${KB_MANAGER_THEME.lineSoft}`,
                    background: 'rgba(255,255,255,0.9)',
                    color: 'var(--neko-popup-text, #333)',
                    borderRadius: '999px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    outline: 'none'
                });

                managerSortSelect = document.createElement('select');
                [
                    { value: 'updated_desc', text: '最近更新' },
                    { value: 'updated_asc', text: '最早更新' },
                    { value: 'name_asc', text: '名称 A-Z' },
                    { value: 'name_desc', text: '名称 Z-A' },
                    { value: 'chunk_desc', text: '分块数 从多到少' },
                    { value: 'chunk_asc', text: '分块数 从少到多' }
                ].forEach((opt) => {
                    const option = document.createElement('option');
                    option.value = opt.value;
                    option.textContent = opt.text;
                    managerSortSelect.appendChild(option);
                });
                Object.assign(managerSortSelect.style, {
                    border: `1px solid ${KB_MANAGER_THEME.lineSoft}`,
                    background: 'rgba(255,255,255,0.9)',
                    color: 'var(--neko-popup-text, #333)',
                    borderRadius: '999px',
                    padding: '5px 10px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    minWidth: '130px',
                    outline: 'none'
                });

                managerBreadcrumb = document.createElement('div');
                Object.assign(managerBreadcrumb.style, {
                    padding: '6px 14px 4px 14px',
                    fontSize: '12px',
                    color: KB_MANAGER_THEME.actionText,
                    opacity: '0.95',
                    borderBottom: `1px dashed ${KB_MANAGER_THEME.lineSoft}`,
                    background: 'rgba(255,255,255,0.6)'
                });

                managerInlineStatus = document.createElement('div');
                managerInlineStatus.textContent = '';
                Object.assign(managerInlineStatus.style, {
                    display: 'none',
                    margin: '6px 14px 0 14px',
                    padding: '6px 10px',
                    borderRadius: '8px',
                    fontSize: '12px',
                    fontWeight: '600',
                    background: 'rgba(30, 136, 229, 0.92)',
                    color: '#ffffff',
                    border: '1px solid rgba(255,255,255,0.35)'
                });

                managerRows = document.createElement('div');
                Object.assign(managerRows.style, {
                    padding: '8px 10px 12px 10px',
                    overflowY: 'auto',
                    minHeight: '120px',
                    flex: '1'
                });

                const tip = document.createElement('div');
                tip.textContent = '提示: 支持层级文件夹管理。可新建/重命名目录，并将文档或子目录拖拽到目标目录。';
                Object.assign(tip.style, {
                    fontSize: '11px',
                    opacity: '0.72',
                    padding: '8px 14px 12px 14px',
                    lineHeight: '1.45'
                });

                function setHudOverlayInteractivity(disabled) {
                    const targets = document.querySelectorAll(
                        '[id$="-floating-buttons"], [id$="-lock-icon"], [id$="-return-button-container"], #agent-task-hud'
                    );

                    if (disabled) {
                        managerHudDisabledNodes = [];
                        targets.forEach((node) => {
                            if (!node || node === managerOverlay || node.contains(managerOverlay)) {
                                return;
                            }
                            managerHudDisabledNodes.push({
                                node,
                                pointerEvents: node.style.pointerEvents,
                                opacity: node.style.opacity
                            });
                            node.style.pointerEvents = 'none';
                            if (!node.style.opacity) {
                                node.style.opacity = '0.86';
                            }
                        });
                        return;
                    }

                    managerHudDisabledNodes.forEach((item) => {
                        if (!item || !item.node) {
                            return;
                        }
                        item.node.style.pointerEvents = item.pointerEvents || '';
                        item.node.style.opacity = item.opacity || '';
                    });
                    managerHudDisabledNodes = [];
                }

                function closeManager() {
                    managerOverlay.style.display = 'none';
                    setManagerInlineStatus('');
                    setHudOverlayInteractivity(false);
                }

                function clampManagerPanelPosition(left, top) {
                    if (!managerPanel) {
                        return { left, top };
                    }
                    const rect = managerPanel.getBoundingClientRect();
                    // Allow panel to be dragged partially off-screen, but keep a visible grab area.
                    const minVisibleX = 96;
                    const minVisibleY = 56;
                    const minLeft = Math.min(0, minVisibleX - rect.width);
                    const maxLeft = Math.max(0, window.innerWidth - minVisibleX);
                    const minTop = Math.min(0, minVisibleY - rect.height);
                    const maxTop = Math.max(0, window.innerHeight - minVisibleY);
                    return {
                        left: Math.min(Math.max(minLeft, left), maxLeft),
                        top: Math.min(Math.max(minTop, top), maxTop)
                    };
                }

                function getManagerResizeEdge(ev) {
                    if (!managerPanel) {
                        return null;
                    }
                    const rect = managerPanel.getBoundingClientRect();
                    const edge = 8;
                    const onLeft = ev.clientX >= rect.left && ev.clientX <= rect.left + edge;
                    const onRight = ev.clientX <= rect.right && ev.clientX >= rect.right - edge;
                    const onTop = ev.clientY >= rect.top && ev.clientY <= rect.top + edge;
                    const onBottom = ev.clientY <= rect.bottom && ev.clientY >= rect.bottom - edge;
                    if (!(onLeft || onRight || onTop || onBottom)) {
                        return null;
                    }
                    return { left: onLeft, right: onRight, top: onTop, bottom: onBottom };
                }

                function managerResizeCursor(edge) {
                    if (!edge) {
                        return 'default';
                    }
                    if ((edge.left && edge.top) || (edge.right && edge.bottom)) {
                        return 'nwse-resize';
                    }
                    if ((edge.right && edge.top) || (edge.left && edge.bottom)) {
                        return 'nesw-resize';
                    }
                    if (edge.left || edge.right) {
                        return 'ew-resize';
                    }
                    return 'ns-resize';
                }

                function isManagerInteractiveTarget(target) {
                    if (!target || !(target instanceof Element)) {
                        return false;
                    }
                    return !!target.closest('button, input, textarea, select, a, summary, iframe, [contenteditable="true"], [draggable="true"]');
                }

                function toggleManagerPanelMaximize() {
                    if (!managerPanel) {
                        return;
                    }
                    if (!managerMaximizedSnapshot) {
                        const rect = managerPanel.getBoundingClientRect();
                        managerMaximizedSnapshot = {
                            left: managerPanel.style.left,
                            top: managerPanel.style.top,
                            width: managerPanel.style.width,
                            height: managerPanel.style.height,
                            transform: managerPanel.style.transform,
                            rectLeft: rect.left,
                            rectTop: rect.top,
                            rectWidth: rect.width,
                            rectHeight: rect.height
                        };
                        const pad = 14;
                        managerPanel.style.transform = 'none';
                        managerPanel.style.left = `${pad}px`;
                        managerPanel.style.top = `${pad}px`;
                        managerPanel.style.width = `${Math.max(360, window.innerWidth - pad * 2)}px`;
                        managerPanel.style.height = `${Math.max(280, window.innerHeight - pad * 2)}px`;
                        managerExpandBtn.textContent = '🗗';
                        managerExpandBtn.title = '还原窗口';
                        return;
                    }
                    const snapshot = managerMaximizedSnapshot;
                    managerMaximizedSnapshot = null;
                    managerPanel.style.transform = snapshot.transform || 'none';
                    managerPanel.style.left = snapshot.left || `${snapshot.rectLeft}px`;
                    managerPanel.style.top = snapshot.top || `${snapshot.rectTop}px`;
                    managerPanel.style.width = snapshot.width || `${snapshot.rectWidth}px`;
                    managerPanel.style.height = snapshot.height || `${snapshot.rectHeight}px`;
                    managerExpandBtn.textContent = '⤢';
                    managerExpandBtn.title = '扩展窗口';
                }

                function startManagerDrag(ev) {
                    if (ev.button !== 0 || !managerPanel) {
                        return;
                    }
                    const resizeEdge = getManagerResizeEdge(ev);
                    if (resizeEdge) {
                        const rect = managerPanel.getBoundingClientRect();
                        managerPanel.style.transform = 'none';
                        managerPanel.style.left = `${rect.left}px`;
                        managerPanel.style.top = `${rect.top}px`;
                        managerResizeState = {
                            edge: resizeEdge,
                            startX: ev.clientX,
                            startY: ev.clientY,
                            startLeft: rect.left,
                            startTop: rect.top,
                            startWidth: rect.width,
                            startHeight: rect.height
                        };
                        managerMaximizedSnapshot = null;
                        managerExpandBtn.textContent = '⤢';
                        managerExpandBtn.title = '扩展窗口';
                        document.body.style.userSelect = 'none';
                        ev.preventDefault();
                        return;
                    }
                    if (ev.target === closeBtn || closeBtn.contains(ev.target)) {
                        return;
                    }
                    if (isManagerInteractiveTarget(ev.target)) {
                        return;
                    }
                    const rect = managerPanel.getBoundingClientRect();
                    managerPanel.style.transform = 'none';
                    managerPanel.style.left = `${rect.left}px`;
                    managerPanel.style.top = `${rect.top}px`;
                    managerDragState = {
                        offsetX: ev.clientX - rect.left,
                        offsetY: ev.clientY - rect.top
                    };
                    document.body.style.userSelect = 'none';
                    ev.preventDefault();
                }

                function moveManagerDrag(ev) {
                    if (managerResizeState && managerPanel) {
                        const minW = 360;
                        const minH = 280;
                        const dx = ev.clientX - managerResizeState.startX;
                        const dy = ev.clientY - managerResizeState.startY;
                        let nextLeft = managerResizeState.startLeft;
                        let nextTop = managerResizeState.startTop;
                        let nextWidth = managerResizeState.startWidth;
                        let nextHeight = managerResizeState.startHeight;

                        if (managerResizeState.edge.right) {
                            nextWidth = Math.max(minW, managerResizeState.startWidth + dx);
                        }
                        if (managerResizeState.edge.bottom) {
                            nextHeight = Math.max(minH, managerResizeState.startHeight + dy);
                        }
                        if (managerResizeState.edge.left) {
                            const rawWidth = managerResizeState.startWidth - dx;
                            nextWidth = Math.max(minW, rawWidth);
                            nextLeft = managerResizeState.startLeft + (managerResizeState.startWidth - nextWidth);
                        }
                        if (managerResizeState.edge.top) {
                            const rawHeight = managerResizeState.startHeight - dy;
                            nextHeight = Math.max(minH, rawHeight);
                            nextTop = managerResizeState.startTop + (managerResizeState.startHeight - nextHeight);
                        }

                        managerPanel.style.left = `${nextLeft}px`;
                        managerPanel.style.top = `${nextTop}px`;
                        managerPanel.style.width = `${nextWidth}px`;
                        managerPanel.style.height = `${nextHeight}px`;
                        managerPanel.style.transform = 'none';
                        return;
                    }
                    if (!managerDragState || !managerPanel) {
                        return;
                    }
                    const nextLeft = ev.clientX - managerDragState.offsetX;
                    const nextTop = ev.clientY - managerDragState.offsetY;
                    const clamped = clampManagerPanelPosition(nextLeft, nextTop);
                    managerPanel.style.left = `${clamped.left}px`;
                    managerPanel.style.top = `${clamped.top}px`;
                    managerPanel.style.transform = 'none';
                }

                function endManagerDrag() {
                    managerDragState = null;
                    managerResizeState = null;
                    document.body.style.userSelect = '';
                    if (managerPanel) {
                        managerPanel.style.cursor = 'default';
                    }
                }

                managerOverlay.addEventListener('click', (ev) => {
                    if (ev.target === managerOverlay) {
                        closeManager();
                    }
                });

                closeBtn.addEventListener('click', closeManager);
                panel.addEventListener('mousedown', startManagerDrag);
                panel.addEventListener('mousemove', (ev) => {
                    if (managerDragState || managerResizeState || !managerPanel) {
                        return;
                    }
                    const edge = getManagerResizeEdge(ev);
                    managerPanel.style.cursor = edge ? managerResizeCursor(edge) : 'default';
                });
                managerExpandBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    toggleManagerPanelMaximize();
                });
                managerExpandBtn.addEventListener('mouseenter', () => {
                    managerExpandBtn.style.filter = 'brightness(1.06)';
                });
                managerExpandBtn.addEventListener('mouseleave', () => {
                    managerExpandBtn.style.filter = 'none';
                });
                window.addEventListener('mousemove', moveManagerDrag);
                window.addEventListener('mouseup', endManagerDrag);
                window.addEventListener('resize', () => {
                    if (managerMaximizedSnapshot && managerPanel) {
                        const pad = 14;
                        managerPanel.style.left = `${pad}px`;
                        managerPanel.style.top = `${pad}px`;
                        managerPanel.style.width = `${Math.max(360, window.innerWidth - pad * 2)}px`;
                        managerPanel.style.height = `${Math.max(280, window.innerHeight - pad * 2)}px`;
                    }
                });
                closeBtn.addEventListener('mouseenter', () => {
                    closeBtn.style.background = 'rgba(255,255,255,0.34)';
                });
                closeBtn.addEventListener('mouseleave', () => {
                    closeBtn.style.background = 'rgba(255,255,255,0.24)';
                });
                refreshBtn.addEventListener('click', () => {
                    loadManagerDocuments();
                });
                backFolderBtn.addEventListener('click', async () => {
                    managerCurrentFolder = '';
                    managerFilterKeyword = '';
                    if (managerSearchInput) {
                        managerSearchInput.value = '';
                    }
                    await loadManagerDocuments();
                });
                createFoldersBtn.addEventListener('click', async () => {
                    const inputName = window.prompt('请输入新文件夹名称', '新文件夹');
                    if (inputName === null) {
                        return;
                    }
                    const folderName = String(inputName || '').trim();
                    if (!folderName) {
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast('文件夹名称不能为空', 2600);
                        }
                        return;
                    }
                    try {
                        const result = await runPluginEntry('create_folder', {
                            folder_name: folderName,
                            parent_folder: managerCurrentFolder || ''
                        });
                        const data = result && result.data ? result.data : null;
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast(data && data.message ? String(data.message) : '文件夹已创建', 2600);
                        }
                        await loadManagerDocuments();
                    } catch (err) {
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast(`创建文件夹失败: ${err && err.message ? err.message : err}`, 4200);
                        }
                    }
                });
                renameFolderBtn.addEventListener('click', async () => {
                    if (!managerCurrentFolder) {
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast('请先进入要重命名的目录', 2600);
                        }
                        return;
                    }
                    const segments = String(managerCurrentFolder).split('/');
                    const currentName = segments[segments.length - 1] || managerCurrentFolder;
                    const newNameInput = window.prompt('请输入新文件夹名称', currentName);
                    if (newNameInput === null) {
                        return;
                    }
                    const newName = String(newNameInput || '').trim();
                    if (!newName) {
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast('文件夹名称不能为空', 2600);
                        }
                        return;
                    }
                    try {
                        const result = await runPluginEntry('rename_folder', {
                            folder_path: managerCurrentFolder,
                            new_name: newName
                        });
                        const data = result && result.data ? result.data : null;
                        if (data && data.renamed && data.new_folder_path) {
                            managerCurrentFolder = String(data.new_folder_path);
                        }
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast(data && data.message ? String(data.message) : '目录重命名完成', 2800);
                        }
                        await loadManagerDocuments();
                    } catch (err) {
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast(`重命名目录失败: ${err && err.message ? err.message : err}`, 4200);
                        }
                    }
                });
                deleteFolderBtn.addEventListener('click', async () => {
                    if (!managerCurrentFolder) {
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast('请先进入要删除的目录', 2600);
                        }
                        return;
                    }
                    const ok = window.confirm(`确认删除目录及其内部文档: ${managerCurrentFolder} ?`);
                    if (!ok) {
                        return;
                    }
                    try {
                        const result = await runPluginEntry('delete_folder', {
                            folder_path: managerCurrentFolder
                        });
                        const data = result && result.data ? result.data : null;
                        managerCurrentFolder = '';
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast(data && data.message ? String(data.message) : '目录删除完成', 3200);
                        }
                        await loadManagerDocuments();
                    } catch (err) {
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast(`删除目录失败: ${err && err.message ? err.message : err}`, 4200);
                        }
                    }
                });
                uploadDocBtn.addEventListener('click', () => {
                    managerUploadInput.click();
                });
                [refreshBtn, backFolderBtn, createFoldersBtn, renameFolderBtn, deleteFolderBtn, uploadDocBtn].forEach((btn) => {
                    btn.addEventListener('mouseenter', () => {
                        btn.style.background = `linear-gradient(180deg, ${KB_MANAGER_THEME.actionFillHover}, rgba(255,255,255,0.94))`;
                    });
                    btn.addEventListener('mouseleave', () => {
                        if (btn === deleteFolderBtn) {
                            btn.style.background = 'linear-gradient(180deg, rgba(244,67,54,0.10), rgba(255,255,255,0.92))';
                        } else {
                            btn.style.background = `linear-gradient(180deg, ${KB_MANAGER_THEME.actionFill}, rgba(255,255,255,0.92))`;
                        }
                    });
                });
                managerSearchInput.addEventListener('input', () => {
                    managerFilterKeyword = String(managerSearchInput.value || '').trim().toLowerCase();
                    applyManagerDocsView();
                });
                managerSortSelect.addEventListener('change', () => {
                    managerSortBy = String(managerSortSelect.value || 'updated_desc');
                    applyManagerDocsView();
                });

                header.appendChild(managerTitle);
                header.appendChild(closeBtn);
                toolbar.appendChild(refreshBtn);
                toolbar.appendChild(backFolderBtn);
                toolbar.appendChild(createFoldersBtn);
                toolbar.appendChild(renameFolderBtn);
                toolbar.appendChild(deleteFolderBtn);
                toolbar.appendChild(uploadDocBtn);
                toolbar.appendChild(managerSearchInput);
                toolbar.appendChild(managerSortSelect);
                panel.appendChild(header);
                panel.appendChild(toolbar);
                panel.appendChild(managerInlineStatus);
                panel.appendChild(managerBreadcrumb);
                panel.appendChild(managerRows);
                panel.appendChild(tip);
                panel.appendChild(managerExpandBtn);
                managerOverlay.appendChild(panel);
                document.body.appendChild(managerOverlay);
                managerOverlay._setHudOverlayInteractivity = setHudOverlayInteractivity;
                managerRenameFolderBtn = renameFolderBtn;
                managerDeleteFolderBtn = deleteFolderBtn;
            }

            function _toUpdatedTimestamp(item) {
                const raw = item && item.updated_at ? String(item.updated_at) : '';
                if (!raw) {
                    return 0;
                }
                const t = Date.parse(raw);
                return Number.isFinite(t) ? t : 0;
            }

            function _formatUpdatedAt(raw) {
                if (!raw) {
                    return '';
                }
                return String(raw).replace('T', ' ').slice(0, 19);
            }

            function normalizeManagerFolderPath(pathText) {
                return String(pathText || '')
                    .replace(/\\/g, '/')
                    .split('/')
                    .map((segment) => String(segment || '').trim())
                    .filter((segment) => !!segment && segment !== '.' && segment !== '..')
                    .join('/');
            }

            function setManagerInlineStatus(message, isError = false) {
                if (!managerInlineStatus) {
                    return;
                }
                const text = String(message || '').trim();
                if (!text) {
                    managerInlineStatus.style.display = 'none';
                    managerInlineStatus.textContent = '';
                    return;
                }
                managerInlineStatus.style.display = 'block';
                managerInlineStatus.textContent = text;
                managerInlineStatus.style.background = isError ? 'rgba(229, 57, 53, 0.94)' : 'rgba(30, 136, 229, 0.92)';
            }

            function updateManagerBreadcrumb() {
                if (!managerBreadcrumb) {
                    return;
                }
                if (!managerCurrentFolder) {
                    managerBreadcrumb.textContent = '当前位置: 文档文件夹';
                    if (managerSearchInput) {
                        managerSearchInput.placeholder = '搜索文件夹名...';
                    }
                    if (managerRenameFolderBtn) {
                        managerRenameFolderBtn.disabled = true;
                        managerRenameFolderBtn.style.opacity = '0.55';
                        managerRenameFolderBtn.style.cursor = 'not-allowed';
                    }
                    if (managerDeleteFolderBtn) {
                        managerDeleteFolderBtn.disabled = true;
                        managerDeleteFolderBtn.style.opacity = '0.55';
                        managerDeleteFolderBtn.style.cursor = 'not-allowed';
                    }
                    return;
                }
                managerBreadcrumb.textContent = `当前位置: 文档文件夹 / ${managerCurrentFolder}`;
                if (managerSearchInput) {
                    managerSearchInput.placeholder = '搜索文档名...';
                }
                if (managerRenameFolderBtn) {
                    managerRenameFolderBtn.disabled = false;
                    managerRenameFolderBtn.style.opacity = '1';
                    managerRenameFolderBtn.style.cursor = 'pointer';
                }
                if (managerDeleteFolderBtn) {
                    managerDeleteFolderBtn.disabled = false;
                    managerDeleteFolderBtn.style.opacity = '1';
                    managerDeleteFolderBtn.style.cursor = 'pointer';
                }
            }

            function ensurePreviewDialog() {
                if (managerPreviewOverlay) {
                    return;
                }
                managerPreviewOverlay = document.createElement('div');
                Object.assign(managerPreviewOverlay.style, {
                    position: 'fixed',
                    inset: '0',
                    zIndex: '2147483100',
                    background: 'rgba(10, 24, 38, 0.42)',
                    display: 'none',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backdropFilter: 'blur(2px)',
                    pointerEvents: 'auto'
                });

                const panel = document.createElement('div');
                Object.assign(panel.style, {
                    width: 'min(900px, 94vw)',
                    height: 'min(82vh, 760px)',
                    minWidth: '380px',
                    minHeight: '260px',
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: '14px',
                    overflow: 'hidden',
                    resize: 'none',
                    border: `1px solid ${KB_MANAGER_THEME.linePrimary}`,
                    background: 'linear-gradient(180deg, rgba(248,252,255,0.98), rgba(236,247,255,0.98))',
                    boxShadow: '0 18px 42px rgba(7, 29, 50, 0.35)',
                    pointerEvents: 'auto',
                    position: 'fixed',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%, -50%)'
                });
                managerPreviewPanel = panel;

                const previewExpandBtn = document.createElement('button');
                previewExpandBtn.type = 'button';
                previewExpandBtn.textContent = '⤢';
                previewExpandBtn.title = '扩展窗口';
                Object.assign(previewExpandBtn.style, {
                    position: 'absolute',
                    right: '10px',
                    bottom: '10px',
                    width: '28px',
                    height: '28px',
                    borderRadius: '999px',
                    border: '1px solid rgba(255,255,255,0.62)',
                    background: 'linear-gradient(180deg, #4BD4FD, #1E88E5)',
                    color: '#ffffff',
                    fontSize: '14px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    boxShadow: '0 6px 16px rgba(30, 136, 229, 0.38)',
                    zIndex: '3'
                });

                const header = document.createElement('div');
                Object.assign(header.style, {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    background: KB_MANAGER_THEME.headerGradient,
                    color: '#fff',
                    userSelect: 'none',
                    cursor: 'move'
                });

                managerPreviewTitle = document.createElement('div');
                managerPreviewTitle.textContent = '文档预览';
                Object.assign(managerPreviewTitle.style, {
                    fontSize: '14px',
                    fontWeight: '700'
                });

                const closeBtn = document.createElement('button');
                closeBtn.type = 'button';
                closeBtn.textContent = '关闭';
                Object.assign(closeBtn.style, {
                    border: '1px solid rgba(255,255,255,0.58)',
                    background: 'rgba(255,255,255,0.22)',
                    color: '#fff',
                    borderRadius: '999px',
                    padding: '4px 10px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: '600'
                });

                managerPreviewBody = document.createElement('div');
                Object.assign(managerPreviewBody.style, {
                    margin: '0',
                    padding: '14px',
                    overflow: 'auto',
                    fontSize: '12px',
                    lineHeight: '1.5',
                    color: '#214767',
                    background: 'rgba(255,255,255,0.9)',
                    minHeight: '120px',
                    flex: '1',
                    pointerEvents: 'auto'
                });

                function isPreviewInteractiveTarget(target) {
                    if (!target || !(target instanceof Element)) {
                        return false;
                    }
                    return !!target.closest('button, input, textarea, select, a, summary, iframe, [contenteditable="true"], [draggable="true"]');
                }

                function getPreviewResizeEdge(ev) {
                    if (!managerPreviewPanel) {
                        return null;
                    }
                    const rect = managerPreviewPanel.getBoundingClientRect();
                    const edge = 8;
                    const onLeft = ev.clientX >= rect.left && ev.clientX <= rect.left + edge;
                    const onRight = ev.clientX <= rect.right && ev.clientX >= rect.right - edge;
                    const onTop = ev.clientY >= rect.top && ev.clientY <= rect.top + edge;
                    const onBottom = ev.clientY <= rect.bottom && ev.clientY >= rect.bottom - edge;
                    if (!(onLeft || onRight || onTop || onBottom)) {
                        return null;
                    }
                    return { left: onLeft, right: onRight, top: onTop, bottom: onBottom };
                }

                function previewResizeCursor(edge) {
                    if (!edge) {
                        return 'default';
                    }
                    if ((edge.left && edge.top) || (edge.right && edge.bottom)) {
                        return 'nwse-resize';
                    }
                    if ((edge.right && edge.top) || (edge.left && edge.bottom)) {
                        return 'nesw-resize';
                    }
                    if (edge.left || edge.right) {
                        return 'ew-resize';
                    }
                    return 'ns-resize';
                }

                function togglePreviewPanelMaximize() {
                    if (!managerPreviewPanel) {
                        return;
                    }
                    if (!managerPreviewMaximizedSnapshot) {
                        const rect = managerPreviewPanel.getBoundingClientRect();
                        managerPreviewMaximizedSnapshot = {
                            left: managerPreviewPanel.style.left,
                            top: managerPreviewPanel.style.top,
                            width: managerPreviewPanel.style.width,
                            height: managerPreviewPanel.style.height,
                            transform: managerPreviewPanel.style.transform,
                            rectLeft: rect.left,
                            rectTop: rect.top,
                            rectWidth: rect.width,
                            rectHeight: rect.height
                        };
                        const pad = 16;
                        managerPreviewPanel.style.transform = 'none';
                        managerPreviewPanel.style.left = `${pad}px`;
                        managerPreviewPanel.style.top = `${pad}px`;
                        managerPreviewPanel.style.width = `${Math.max(380, window.innerWidth - pad * 2)}px`;
                        managerPreviewPanel.style.height = `${Math.max(260, window.innerHeight - pad * 2)}px`;
                        previewExpandBtn.textContent = '🗗';
                        previewExpandBtn.title = '还原窗口';
                        return;
                    }
                    const snapshot = managerPreviewMaximizedSnapshot;
                    managerPreviewMaximizedSnapshot = null;
                    managerPreviewPanel.style.transform = snapshot.transform || 'none';
                    managerPreviewPanel.style.left = snapshot.left || `${snapshot.rectLeft}px`;
                    managerPreviewPanel.style.top = snapshot.top || `${snapshot.rectTop}px`;
                    managerPreviewPanel.style.width = snapshot.width || `${snapshot.rectWidth}px`;
                    managerPreviewPanel.style.height = snapshot.height || `${snapshot.rectHeight}px`;
                    previewExpandBtn.textContent = '⤢';
                    previewExpandBtn.title = '扩展窗口';
                }

                function endPreviewDrag() {
                    managerPreviewDragState = null;
                    managerPreviewResizeState = null;
                    document.body.style.userSelect = '';
                    if (managerPreviewPanel) {
                        managerPreviewPanel.style.cursor = 'default';
                    }
                }

                function startPreviewDrag(ev) {
                    if (ev.button !== 0 || !managerPreviewPanel) {
                        return;
                    }
                    const resizeEdge = getPreviewResizeEdge(ev);
                    if (resizeEdge) {
                        const rect = managerPreviewPanel.getBoundingClientRect();
                        managerPreviewPanel.style.transform = 'none';
                        managerPreviewPanel.style.left = `${rect.left}px`;
                        managerPreviewPanel.style.top = `${rect.top}px`;
                        managerPreviewResizeState = {
                            edge: resizeEdge,
                            startX: ev.clientX,
                            startY: ev.clientY,
                            startLeft: rect.left,
                            startTop: rect.top,
                            startWidth: rect.width,
                            startHeight: rect.height
                        };
                        managerPreviewMaximizedSnapshot = null;
                        previewExpandBtn.textContent = '⤢';
                        previewExpandBtn.title = '扩展窗口';
                        document.body.style.userSelect = 'none';
                        ev.preventDefault();
                        ev.stopPropagation();
                        return;
                    }
                    if (ev.target === closeBtn || closeBtn.contains(ev.target)) {
                        return;
                    }
                    if (isPreviewInteractiveTarget(ev.target)) {
                        return;
                    }
                    const rect = managerPreviewPanel.getBoundingClientRect();
                    managerPreviewPanel.style.transform = 'none';
                    managerPreviewPanel.style.left = `${rect.left}px`;
                    managerPreviewPanel.style.top = `${rect.top}px`;
                    managerPreviewDragState = {
                        offsetX: ev.clientX - rect.left,
                        offsetY: ev.clientY - rect.top
                    };
                    document.body.style.userSelect = 'none';
                    ev.preventDefault();
                    ev.stopPropagation();
                }

                function movePreviewDrag(ev) {
                    if (managerPreviewResizeState && managerPreviewPanel) {
                        const minW = 380;
                        const minH = 260;
                        const dx = ev.clientX - managerPreviewResizeState.startX;
                        const dy = ev.clientY - managerPreviewResizeState.startY;
                        let nextLeft = managerPreviewResizeState.startLeft;
                        let nextTop = managerPreviewResizeState.startTop;
                        let nextWidth = managerPreviewResizeState.startWidth;
                        let nextHeight = managerPreviewResizeState.startHeight;

                        if (managerPreviewResizeState.edge.right) {
                            nextWidth = Math.max(minW, managerPreviewResizeState.startWidth + dx);
                        }
                        if (managerPreviewResizeState.edge.bottom) {
                            nextHeight = Math.max(minH, managerPreviewResizeState.startHeight + dy);
                        }
                        if (managerPreviewResizeState.edge.left) {
                            const rawWidth = managerPreviewResizeState.startWidth - dx;
                            nextWidth = Math.max(minW, rawWidth);
                            nextLeft = managerPreviewResizeState.startLeft + (managerPreviewResizeState.startWidth - nextWidth);
                        }
                        if (managerPreviewResizeState.edge.top) {
                            const rawHeight = managerPreviewResizeState.startHeight - dy;
                            nextHeight = Math.max(minH, rawHeight);
                            nextTop = managerPreviewResizeState.startTop + (managerPreviewResizeState.startHeight - nextHeight);
                        }

                        managerPreviewPanel.style.left = `${nextLeft}px`;
                        managerPreviewPanel.style.top = `${nextTop}px`;
                        managerPreviewPanel.style.width = `${nextWidth}px`;
                        managerPreviewPanel.style.height = `${nextHeight}px`;
                        managerPreviewPanel.style.transform = 'none';
                        return;
                    }
                    if (!managerPreviewDragState || !managerPreviewPanel) {
                        return;
                    }
                    const nextLeft = ev.clientX - managerPreviewDragState.offsetX;
                    const nextTop = ev.clientY - managerPreviewDragState.offsetY;
                    managerPreviewPanel.style.left = `${nextLeft}px`;
                    managerPreviewPanel.style.top = `${nextTop}px`;
                    managerPreviewPanel.style.transform = 'none';
                }

                closeBtn.addEventListener('click', () => {
                    endPreviewDrag();
                    managerPreviewOverlay.style.display = 'none';
                });
                managerPreviewOverlay.addEventListener('click', (ev) => {
                    if (ev.target === managerPreviewOverlay) {
                        endPreviewDrag();
                        managerPreviewOverlay.style.display = 'none';
                    }
                });
                panel.addEventListener('mousedown', startPreviewDrag);
                panel.addEventListener('mousemove', (ev) => {
                    if (managerPreviewDragState || managerPreviewResizeState || !managerPreviewPanel) {
                        return;
                    }
                    const edge = getPreviewResizeEdge(ev);
                    managerPreviewPanel.style.cursor = edge ? previewResizeCursor(edge) : 'default';
                });
                previewExpandBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    togglePreviewPanelMaximize();
                });
                previewExpandBtn.addEventListener('mouseenter', () => {
                    previewExpandBtn.style.filter = 'brightness(1.06)';
                });
                previewExpandBtn.addEventListener('mouseleave', () => {
                    previewExpandBtn.style.filter = 'none';
                });
                window.addEventListener('mousemove', movePreviewDrag);
                window.addEventListener('mouseup', endPreviewDrag);
                window.addEventListener('resize', () => {
                    if (managerPreviewMaximizedSnapshot && managerPreviewPanel) {
                        const pad = 16;
                        managerPreviewPanel.style.left = `${pad}px`;
                        managerPreviewPanel.style.top = `${pad}px`;
                        managerPreviewPanel.style.width = `${Math.max(380, window.innerWidth - pad * 2)}px`;
                        managerPreviewPanel.style.height = `${Math.max(260, window.innerHeight - pad * 2)}px`;
                    }
                });

                header.appendChild(managerPreviewTitle);
                header.appendChild(closeBtn);
                panel.appendChild(header);
                panel.appendChild(managerPreviewBody);
                panel.appendChild(previewExpandBtn);
                managerPreviewOverlay.appendChild(panel);
                document.body.appendChild(managerPreviewOverlay);
            }

            async function openManagerDocumentPreview(item) {
                const name = item && item.document_name ? String(item.document_name) : '';
                if (!name) {
                    return;
                }
                ensurePreviewDialog();
                managerPreviewTitle.textContent = `文档预览: ${name}`;
                managerPreviewBody.textContent = '文档内容加载中...';
                managerPreviewOverlay.style.display = 'flex';
                try {
                    const result = await runPluginEntry('get_document_content', {
                        document_name: name,
                        max_chars: 28000
                    });
                    const data = result && result.data ? result.data : null;
                    const found = !!(data && data.found);
                    if (!found) {
                        managerPreviewBody.textContent = '未找到该文档内容。';
                        return;
                    }
                    const content = data && data.content ? String(data.content) : '';
                    const docType = data && data.doc_type ? String(data.doc_type).toUpperCase() : '';
                    const updatedAt = _formatUpdatedAt(data && data.updated_at ? data.updated_at : '');
                    const fromChunks = !!(data && data.from_chunks);
                    const meta = [
                        `类型: ${docType || '未知'}`,
                        updatedAt ? `更新时间: ${updatedAt}` : '',
                        data && data.pdf_too_large ? '提示: 原PDF过大，已降级为文本预览' : '',
                        fromChunks ? '来源: 索引分块拼接（原文件内容不可直接读取）' : '来源: 原文件读取'
                    ].filter(Boolean).join(' | ');

                    if (docType === 'PDF' && data && data.pdf_base64) {
                        managerPreviewBody.innerHTML = '';

                        const metaDiv = document.createElement('div');
                        metaDiv.textContent = meta;
                        Object.assign(metaDiv.style, {
                            marginBottom: '10px',
                            color: KB_MANAGER_THEME.actionText,
                            fontWeight: '600'
                        });

                        const frame = document.createElement('iframe');
                        frame.src = `data:application/pdf;base64,${String(data.pdf_base64)}`;
                        frame.title = `PDF预览: ${name}`;
                        Object.assign(frame.style, {
                            width: '100%',
                            height: '56vh',
                            border: `1px solid ${KB_MANAGER_THEME.linePrimary}`,
                            borderRadius: '8px',
                            background: '#fff'
                        });

                        const detail = document.createElement('details');
                        detail.style.marginTop = '10px';
                        const summary = document.createElement('summary');
                        summary.textContent = '查看抽取文本（用于检索）';
                        summary.style.cursor = 'pointer';
                        summary.style.color = '#2b5578';
                        const textPre = document.createElement('pre');
                        textPre.textContent = content || '(抽取文本为空)';
                        Object.assign(textPre.style, {
                            marginTop: '8px',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            maxHeight: '22vh',
                            overflow: 'auto',
                            padding: '8px',
                            borderRadius: '8px',
                            background: 'rgba(245,250,255,0.95)',
                            border: `1px solid ${KB_MANAGER_THEME.lineSecondary}`
                        });
                        detail.appendChild(summary);
                        detail.appendChild(textPre);

                        managerPreviewBody.appendChild(metaDiv);
                        managerPreviewBody.appendChild(frame);
                        managerPreviewBody.appendChild(detail);
                        return;
                    }

                    const isMarkdownLike = docType === 'MD' || name.toLowerCase().endsWith('.md') || name.toLowerCase().endsWith('.markdown');
                    managerPreviewBody.innerHTML = '';

                    const metaDiv = document.createElement('div');
                    metaDiv.textContent = meta;
                    Object.assign(metaDiv.style, {
                        marginBottom: '10px',
                        color: KB_MANAGER_THEME.actionText,
                        fontWeight: '600'
                    });
                    managerPreviewBody.appendChild(metaDiv);

                    if (isMarkdownLike) {
                        const mdDiv = document.createElement('div');
                        mdDiv.innerHTML = renderManagerMarkdown(content || '(文档内容为空)');
                        Object.assign(mdDiv.style, {
                            color: KB_MANAGER_THEME.actionText,
                            lineHeight: '1.6',
                            wordBreak: 'break-word'
                        });
                        managerPreviewBody.appendChild(mdDiv);
                        await typesetManagerMath(mdDiv);
                    } else {
                        const plain = document.createElement('pre');
                        plain.textContent = content || '(文档内容为空)';
                        Object.assign(plain.style, {
                            margin: '0',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word'
                        });
                        managerPreviewBody.appendChild(plain);
                    }
                } catch (err) {
                    managerPreviewBody.textContent = `加载文档失败: ${err && err.message ? err.message : err}`;
                }
            }

            function escapeHtml(text) {
                return String(text || '')
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            }

            function ensureManagerMathJax() {
                if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
                    return Promise.resolve(true);
                }
                if (managerMathJaxReadyPromise) {
                    return managerMathJaxReadyPromise;
                }
                managerMathJaxReadyPromise = new Promise((resolve) => {
                    try {
                        if (!window.MathJax) {
                            window.MathJax = {
                                loader: {
                                    load: ['[tex]/noerrors']
                                },
                                tex: {
                                    inlineMath: [['$', '$'], ['\\(', '\\)']],
                                    displayMath: [['$$', '$$'], ['\\[', '\\]']],
                                    packages: { '[+]': ['noerrors'] }
                                },
                                options: {
                                    skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
                                },
                                svg: {
                                    fontCache: 'global'
                                }
                            };
                        }
                        const script = document.createElement('script');
                        script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js';
                        script.async = true;
                        script.onload = () => resolve(true);
                        script.onerror = () => resolve(false);
                        document.head.appendChild(script);
                    } catch (_err) {
                        resolve(false);
                    }
                });
                return managerMathJaxReadyPromise;
            }

            async function typesetManagerMath(container) {
                if (!container) {
                    return;
                }
                const ready = await ensureManagerMathJax();
                if (!ready || !window.MathJax || typeof window.MathJax.typesetPromise !== 'function') {
                    return;
                }
                try {
                    await window.MathJax.typesetPromise([container]);
                    container.querySelectorAll('.mjx-merror, .MathJax_Error, mjx-container [data-mml-node="merror"]').forEach((node) => {
                        node.style.display = 'none';
                    });
                } catch (_err) {
                    // 数学公式渲染失败时保留原文，不阻塞主流程。
                }
            }

            function isLikelySafeMathExpression(expr) {
                const source = String(expr || '').trim();
                if (!source) {
                    return false;
                }
                // 避免把整段 OCR/提取文本误判为公式，导致 MathJax 报错提示。
                if (source.length > 220) {
                    return false;
                }
                if (/\r|\n/.test(source)) {
                    return false;
                }
                if (/(^|[^\\])#/.test(source)) {
                    return false;
                }
                return true;
            }

            function renderInlineMarkdown(text) {
                const source = String(text || '');
                const formulas = [];
                const tokenized = source.replace(/(\$\$[\s\S]+?\$\$|\$(?:\\.|[^$\\\n])+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/g, (match) => {
                    const token = `__NEKO_MATH_TOKEN_${formulas.length}__`;
                    if (isLikelySafeMathExpression(match)) {
                        formulas.push(match.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
                    } else {
                        formulas.push(
                            escapeHtml(match)
                                .replace(/\$/g, '&#36;')
                                .replace(/\\\(/g, '&#92;(')
                                .replace(/\\\)/g, '&#92;)')
                                .replace(/\\\[/g, '&#92;[')
                                .replace(/\\\]/g, '&#92;]')
                        );
                    }
                    return token;
                });

                let html = escapeHtml(tokenized);
                html = html.replace(/`([^`]+)`/g, '<code style="background: rgba(18,88,137,0.10); border-radius: 4px; padding: 1px 5px;">$1</code>');
                html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
                html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color: #40C5F1; text-decoration: underline;">$1</a>');

                formulas.forEach((formula, idx) => {
                    const token = `__NEKO_MATH_TOKEN_${idx}__`;
                    html = html.split(token).join(formula);
                });
                // Defensive fallback: strip unresolved math placeholders instead of leaking tokens to UI.
                html = html.replace(/__NEKO_MATH_TOKEN_\d+__/g, '');
                return html;
            }

            function decodeEscapedLineBreaks(text) {
                const source = String(text || '').replace(/\r\n/g, '\n');
                if (source.includes('\n')) {
                    return source;
                }
                if (!source.includes('\\n')) {
                    return source;
                }
                const count = (source.match(/\\n/g) || []).length;
                if (count < 2 && !source.includes('\\n\\n')) {
                    return source;
                }
                return source.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
            }

            function renderManagerMarkdown(text) {
                const source = decodeEscapedLineBreaks(text);
                const blocks = source.split(/\n{2,}/);
                const htmlBlocks = [];

                blocks.forEach((block) => {
                    const raw = String(block || '').trim();
                    if (!raw) {
                        return;
                    }

                    if (raw.startsWith('```') && raw.endsWith('```')) {
                        const code = raw.replace(/^```[\w-]*\n?/, '').replace(/```$/, '');
                        htmlBlocks.push(`<pre style="margin: 0 0 12px 0; padding: 10px; border-radius: 8px; background: rgba(13,44,70,0.08); overflow: auto;"><code>${escapeHtml(code)}</code></pre>`);
                        return;
                    }

                    if ((raw.startsWith('$$') && raw.endsWith('$$')) || (raw.startsWith('\\[') && raw.endsWith('\\]'))) {
                        if (isLikelySafeMathExpression(raw)) {
                            htmlBlocks.push(`<div style="margin: 0 0 12px 0; padding: 10px 8px; border-radius: 8px; background: rgba(64, 197, 241, 0.08); overflow-x: auto;">${raw}</div>`);
                        } else {
                            htmlBlocks.push(`<pre style="margin: 0 0 12px 0; padding: 10px; border-radius: 8px; background: rgba(13,44,70,0.08); overflow: auto;"><code>${escapeHtml(raw)}</code></pre>`);
                        }
                        return;
                    }

                    const lines = raw.split('\n');
                    if (lines.length >= 2 && /^\s*\|?\s*[-: ]+[-|: ]*\s*$/.test(lines[1])) {
                        const rowHtml = lines
                            .map((line, idx) => {
                                const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => renderInlineMarkdown(cell.trim()));
                                const tag = idx === 0 ? 'th' : 'td';
                                const cellHtml = cells.map((cell) => `<${tag} style="border: 1px solid rgba(33,71,103,0.18); padding: 6px 8px;">${cell}</${tag}>`).join('');
                                return idx === 1 ? '' : `<tr>${cellHtml}</tr>`;
                            })
                            .filter(Boolean)
                            .join('');
                        htmlBlocks.push(`<table style="width: 100%; border-collapse: collapse; margin-bottom: 12px;">${rowHtml}</table>`);
                        return;
                    }

                    if (/^#{1,6}\s+/.test(raw)) {
                        const level = Math.min(6, (raw.match(/^#+/) || ['#'])[0].length);
                        const content = raw.replace(/^#{1,6}\s+/, '');
                        htmlBlocks.push(`<h${level} style="margin: 12px 0 8px 0;">${renderInlineMarkdown(content)}</h${level}>`);
                        return;
                    }

                    if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
                        const items = lines.map((line) => `<li>${renderInlineMarkdown(line.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('');
                        htmlBlocks.push(`<ul style="margin: 0 0 12px 18px; padding: 0;">${items}</ul>`);
                        return;
                    }

                    if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
                        const items = lines.map((line) => `<li>${renderInlineMarkdown(line.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('');
                        htmlBlocks.push(`<ol style="margin: 0 0 12px 18px; padding: 0;">${items}</ol>`);
                        return;
                    }

                    if (lines.every((line) => /^>\s?/.test(line))) {
                        const quote = lines.map((line) => renderInlineMarkdown(line.replace(/^>\s?/, ''))).join('<br>');
                        htmlBlocks.push(`<blockquote style="margin: 0 0 12px 0; padding: 8px 12px; border-left: 3px solid rgba(33,71,103,0.28); background: rgba(33,71,103,0.06);">${quote}</blockquote>`);
                        return;
                    }

                    htmlBlocks.push(`<p style="margin: 0 0 12px 0;">${lines.map((line) => renderInlineMarkdown(line)).join('<br>')}</p>`);
                });

                return htmlBlocks.join('');
            }

            async function moveManagerEntity(payload, targetFolder) {
                const folderPath = normalizeManagerFolderPath(targetFolder);
                if (!payload || !folderPath) {
                    return;
                }
                try {
                    if (payload.type === 'document' && payload.document_name) {
                        const result = await runPluginEntry('move_document', {
                            document_name: payload.document_name,
                            target_folder: folderPath
                        });
                        const data = result && result.data ? result.data : null;
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast(data && data.message ? String(data.message) : '文档移动完成', 2600);
                        }
                        await loadManagerDocuments();
                        return;
                    }

                    if (payload.type === 'folder' && payload.folder_path) {
                        const sourceFolder = normalizeManagerFolderPath(payload.folder_path);
                        if (!sourceFolder || sourceFolder === folderPath || folderPath.startsWith(`${sourceFolder}/`)) {
                            if (typeof window.showStatusToast === 'function') {
                                window.showStatusToast('不能把目录移动到自己内部', 2600);
                            }
                            return;
                        }
                        const result = await runPluginEntry('move_folder', {
                            folder_path: sourceFolder,
                            target_folder: folderPath
                        });
                        const data = result && result.data ? result.data : null;
                        if (data && data.moved && managerCurrentFolder === sourceFolder && data.new_folder_path) {
                            managerCurrentFolder = String(data.new_folder_path);
                        }
                        if (typeof window.showStatusToast === 'function') {
                            window.showStatusToast(data && data.message ? String(data.message) : '目录移动完成', 2800);
                        }
                        await loadManagerDocuments();
                    }
                } catch (err) {
                    if (typeof window.showStatusToast === 'function') {
                        window.showStatusToast(`移动失败: ${err && err.message ? err.message : err}`, 4200);
                    }
                }
            }

            function bindDropTarget(node, targetFolder) {
                if (!node) {
                    return;
                }
                const normalizedTarget = normalizeManagerFolderPath(targetFolder);
                node.addEventListener('dragover', (ev) => {
                    ev.preventDefault();
                    node.style.boxShadow = '0 0 0 2px rgba(64, 197, 241, 0.45)';
                });
                node.addEventListener('dragleave', () => {
                    node.style.boxShadow = 'none';
                });
                node.addEventListener('drop', async (ev) => {
                    ev.preventDefault();
                    node.style.boxShadow = 'none';
                    let payload = null;
                    try {
                        payload = JSON.parse(ev.dataTransfer.getData('application/x-neko-kb-item') || '{}');
                    } catch (e) {
                        payload = null;
                    }
                    if (!payload) {
                        return;
                    }
                    await moveManagerEntity(payload, normalizedTarget);
                });
            }

            function renderManagerFolders(folders, appendMode = false) {
                if (!managerRows) {
                    return;
                }
                if (!appendMode) {
                    managerRows.innerHTML = '';
                }
                if (!Array.isArray(folders) || folders.length === 0) {
                    if (!appendMode) {
                        setManagerRowsMessage('暂无可用文件夹');
                    }
                    return;
                }

                folders.forEach((folder) => {
                    const folderKey = folder && folder.folder_key ? normalizeManagerFolderPath(folder.folder_key) : '';
                    const folderName = folder && folder.folder_name ? String(folder.folder_name) : (folderKey || '未命名目录');
                    const docCount = Number(folder && folder.document_count ? folder.document_count : 0);
                    const updatedAt = _formatUpdatedAt(folder && folder.updated_at ? folder.updated_at : '');

                    const card = document.createElement('div');
                    Object.assign(card.style, {
                        border: `1px solid ${KB_MANAGER_THEME.lineSoft}`,
                        borderRadius: '12px',
                        background: 'rgba(255,255,255,0.82)',
                        padding: '10px 12px',
                        marginBottom: '8px',
                        cursor: 'pointer',
                        transition: 'all 0.16s ease'
                    });

                    const headRow = document.createElement('div');
                    Object.assign(headRow.style, {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px'
                    });

                    const title = document.createElement('div');
                    title.textContent = `文件夹: ${folderName}`;
                    Object.assign(title.style, {
                        color: KB_MANAGER_THEME.actionText,
                        fontSize: '14px',
                        fontWeight: '700',
                        flex: '1',
                        minWidth: '0',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                    });

                    const renameBtn = document.createElement('button');
                    renameBtn.type = 'button';
                    renameBtn.textContent = '重命名';
                    Object.assign(renameBtn.style, {
                        border: `1px solid ${KB_MANAGER_THEME.lineSoft}`,
                        background: 'rgba(255,255,255,0.96)',
                        color: KB_MANAGER_THEME.actionText,
                        borderRadius: '999px',
                        padding: '4px 10px',
                        fontSize: '11px',
                        cursor: 'pointer',
                        flexShrink: '0'
                    });

                    const removeBtn = document.createElement('button');
                    removeBtn.type = 'button';
                    removeBtn.textContent = '删除';
                    Object.assign(removeBtn.style, {
                        border: '1px solid rgba(244, 67, 54, 0.25)',
                        background: 'rgba(255,255,255,0.96)',
                        color: '#d32f2f',
                        borderRadius: '999px',
                        padding: '4px 10px',
                        fontSize: '11px',
                        cursor: 'pointer',
                        flexShrink: '0'
                    });

                    const meta = document.createElement('div');
                    meta.textContent = updatedAt
                        ? `文档数: ${docCount} | 最近更新: ${updatedAt} | 拖入此目录可归类`
                        : `文档数: ${docCount} | 拖入此目录可归类`;
                    Object.assign(meta.style, {
                        fontSize: '11px',
                        color: KB_MANAGER_THEME.actionText,
                        marginTop: '4px'
                    });

                    headRow.appendChild(title);
                    headRow.appendChild(renameBtn);
                    headRow.appendChild(removeBtn);
                    card.appendChild(headRow);
                    card.appendChild(meta);
                    managerRows.appendChild(card);

                    card.draggable = !!folderKey;
                    card.addEventListener('dragstart', (ev) => {
                        if (!folderKey || !ev.dataTransfer) {
                            return;
                        }
                        ev.dataTransfer.effectAllowed = 'move';
                        ev.dataTransfer.setData('application/x-neko-kb-item', JSON.stringify({
                            type: 'folder',
                            folder_path: folderKey
                        }));
                    });

                    bindDropTarget(card, folderKey);

                    card.addEventListener('mouseenter', () => {
                        card.style.transform = 'translateY(-1px)';
                        card.style.boxShadow = '0 8px 20px rgba(64, 197, 241, 0.2)';
                    });
                    card.addEventListener('mouseleave', () => {
                        card.style.transform = 'translateY(0)';
                        card.style.boxShadow = 'none';
                    });

                    renameBtn.addEventListener('click', async (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (!folderKey) {
                            return;
                        }
                        const suggest = folderName;
                        const input = window.prompt('请输入新文件夹名称', suggest);
                        if (input === null) {
                            return;
                        }
                        const nextName = String(input || '').trim();
                        if (!nextName) {
                            if (typeof window.showStatusToast === 'function') {
                                window.showStatusToast('文件夹名称不能为空', 2600);
                            }
                            return;
                        }
                        try {
                            const result = await runPluginEntry('rename_folder', {
                                folder_path: folderKey,
                                new_name: nextName
                            });
                            const data = result && result.data ? result.data : null;
                            if (data && data.renamed && managerCurrentFolder === folderKey && data.new_folder_path) {
                                managerCurrentFolder = String(data.new_folder_path);
                            }
                            if (typeof window.showStatusToast === 'function') {
                                window.showStatusToast(data && data.message ? String(data.message) : '目录重命名完成', 2800);
                            }
                            await loadManagerDocuments();
                        } catch (err) {
                            if (typeof window.showStatusToast === 'function') {
                                window.showStatusToast(`重命名目录失败: ${err && err.message ? err.message : err}`, 4200);
                            }
                        }
                    });

                    removeBtn.addEventListener('click', async (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (!folderKey) {
                            if (typeof window.showStatusToast === 'function') {
                                window.showStatusToast('目录路径无效，无法删除', 2600);
                            }
                            return;
                        }
                        const ok = window.confirm(`确认删除目录及其内部文档: ${folderName} ?`);
                        if (!ok) {
                            return;
                        }
                        try {
                            const result = await runPluginEntry('delete_folder', {
                                folder_path: folderKey
                            });
                            const data = result && result.data ? result.data : null;
                            if (typeof window.showStatusToast === 'function') {
                                window.showStatusToast(data && data.message ? String(data.message) : '目录删除完成', 3200);
                            }
                            if (managerCurrentFolder === folderKey) {
                                managerCurrentFolder = '';
                            }
                            await loadManagerDocuments();
                        } catch (err) {
                            if (typeof window.showStatusToast === 'function') {
                                window.showStatusToast(`删除目录失败: ${err && err.message ? err.message : err}`, 4200);
                            }
                        }
                    });

                    card.addEventListener('click', async () => {
                        if (!folderKey) {
                            return;
                        }
                        managerCurrentFolder = folderKey;
                        managerFilterKeyword = '';
                        if (managerSearchInput) {
                            managerSearchInput.value = '';
                        }
                        await loadManagerDocuments();
                    });
                });
            }

            function applyManagerDocsView() {
                const keyword = String(managerFilterKeyword || '').trim().toLowerCase();
                updateManagerBreadcrumb();

                const folders = Array.isArray(managerFoldersCache) ? managerFoldersCache.slice() : [];
                const docs = Array.isArray(managerDocsCache) ? managerDocsCache.slice() : [];

                let folderFiltered = folders;
                let docFiltered = docs;
                if (keyword) {
                    folderFiltered = folders.filter((item) => {
                        const name = item && item.folder_name ? String(item.folder_name).toLowerCase() : '';
                        return name.includes(keyword);
                    });
                    docFiltered = docs.filter((item) => {
                        const name = item && item.document_name ? String(item.document_name).toLowerCase() : '';
                        return name.includes(keyword);
                    });
                }

                docFiltered.sort((a, b) => {
                    const nameA = a && a.document_name ? String(a.document_name) : '';
                    const nameB = b && b.document_name ? String(b.document_name) : '';
                    const chunkA = Number(a && a.chunk_count ? a.chunk_count : 0);
                    const chunkB = Number(b && b.chunk_count ? b.chunk_count : 0);
                    const timeA = _toUpdatedTimestamp(a);
                    const timeB = _toUpdatedTimestamp(b);

                    if (managerSortBy === 'updated_asc') return timeA - timeB;
                    if (managerSortBy === 'name_asc') return nameA.localeCompare(nameB, 'zh-Hans-CN');
                    if (managerSortBy === 'name_desc') return nameB.localeCompare(nameA, 'zh-Hans-CN');
                    if (managerSortBy === 'chunk_desc') return chunkB - chunkA;
                    if (managerSortBy === 'chunk_asc') return chunkA - chunkB;
                    return timeB - timeA;
                });

                if (managerTitle) {
                    const posTitle = managerCurrentFolder ? `知识库文档管理（${managerCurrentFolder}）` : '知识库文档管理（根目录）';
                    managerTitle.textContent = `${posTitle} 文件夹 ${folderFiltered.length}/${folders.length} 文档 ${docFiltered.length}/${docs.length}`;
                }

                if (!managerRows) {
                    return;
                }
                managerRows.innerHTML = '';
                if (folderFiltered.length === 0 && docFiltered.length === 0) {
                    if (keyword) {
                        setManagerRowsMessage(`未找到匹配内容: ${keyword}`);
                    } else {
                        setManagerRowsMessage('当前目录为空');
                    }
                    return;
                }

                if (folderFiltered.length > 0) {
                    renderManagerFolders(folderFiltered, true);
                }
                if (docFiltered.length > 0) {
                    renderManagerDocuments(docFiltered, true);
                }
            }

            function setManagerRowsMessage(message) {
                if (!managerRows) {
                    return;
                }
                managerRows.innerHTML = '';
                const row = document.createElement('div');
                row.textContent = message;
                Object.assign(row.style, {
                    fontSize: '12px',
                    opacity: '0.8',
                    padding: '10px 8px'
                });
                managerRows.appendChild(row);
            }

            function renderManagerDocuments(docs, appendMode = false) {
                if (!managerRows) {
                    return;
                }
                if (!appendMode) {
                    managerRows.innerHTML = '';
                }

                if (!Array.isArray(docs) || docs.length === 0) {
                    if (!appendMode) {
                        setManagerRowsMessage('当前未收录文档');
                    }
                    return;
                }

                docs.forEach((item, idx) => {
                    const name = item && item.document_name ? String(item.document_name) : '(未命名)';
                    const chunks = Number(item && item.chunk_count ? item.chunk_count : 0);

                    const row = document.createElement('div');
                    Object.assign(row.style, {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        border: `1px solid ${KB_MANAGER_THEME.lineSoft}`,
                        borderRadius: '10px',
                        background: 'rgba(255,255,255,0.75)',
                        padding: '8px 10px',
                        marginBottom: '8px',
                        cursor: 'pointer'
                    });
                    row.draggable = true;
                    row.addEventListener('dragstart', (ev) => {
                        if (!ev.dataTransfer || !name || name === '(未命名)') {
                            return;
                        }
                        ev.dataTransfer.effectAllowed = 'move';
                        ev.dataTransfer.setData('application/x-neko-kb-item', JSON.stringify({
                            type: 'document',
                            document_name: name
                        }));
                    });

                    const idxTag = document.createElement('div');
                    idxTag.textContent = String(idx + 1);
                    Object.assign(idxTag.style, {
                        width: '20px',
                        textAlign: 'center',
                        fontSize: '11px',
                        opacity: '0.7'
                    });

                    const info = document.createElement('div');
                    Object.assign(info.style, {
                        flex: '1',
                        minWidth: '0'
                    });

                    const title = document.createElement('div');
                    title.textContent = name;
                    Object.assign(title.style, {
                        fontSize: '13px',
                        fontWeight: '600',
                        color: KB_MANAGER_THEME.actionText,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                    });

                    const meta = document.createElement('div');
                    const updatedAt = item && item.updated_at ? String(item.updated_at).replace('T', ' ').slice(0, 19) : '';
                    const docType = item && item.doc_type ? String(item.doc_type).toUpperCase() : (name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'MD');
                    meta.textContent = updatedAt
                        ? `类型: ${docType} | 分块: ${chunks} | 更新: ${updatedAt}`
                        : `类型: ${docType} | 分块: ${chunks}`;
                    Object.assign(meta.style, {
                        fontSize: '11px',
                        color: KB_MANAGER_THEME.actionText,
                        opacity: '0.92',
                        marginTop: '2px'
                    });

                    const delBtn = document.createElement('button');
                    delBtn.type = 'button';
                    delBtn.textContent = '删除文档';
                    Object.assign(delBtn.style, {
                        border: 'none',
                        background: KB_MANAGER_THEME.danger,
                        color: '#ffffff',
                        borderRadius: '999px',
                        padding: '6px 14px',
                        fontSize: '12px',
                        fontWeight: '600',
                        boxShadow: '0 1px 3px rgba(255, 82, 82, 0.2)',
                        cursor: 'pointer',
                        flexShrink: '0'
                    });

                    delBtn.addEventListener('click', async (ev) => {
                        ev.stopPropagation();
                        const ok = window.confirm(`确认删除文档: ${name} ?`);
                        if (!ok) {
                            return;
                        }
                        try {
                            await runPluginEntry('delete_document', { document_name: name });
                            if (typeof window.showStatusToast === 'function') {
                                window.showStatusToast(`已删除: ${name}`, 2800);
                            }
                            await loadManagerDocuments();
                        } catch (err) {
                            if (typeof window.showStatusToast === 'function') {
                                window.showStatusToast(`删除文档失败: ${err && err.message ? err.message : err}`, 4500);
                            }
                        }
                    });

                    info.appendChild(title);
                    info.appendChild(meta);
                    row.appendChild(idxTag);
                    row.appendChild(info);
                    row.appendChild(delBtn);
                    managerRows.appendChild(row);

                    row.addEventListener('mouseenter', () => {
                        row.style.boxShadow = '0 8px 20px rgba(64, 197, 241, 0.22)';
                        row.style.transform = 'translateY(-1px)';
                    });
                    row.addEventListener('mouseleave', () => {
                        row.style.boxShadow = 'none';
                        row.style.transform = 'translateY(0)';
                    });

                    delBtn.addEventListener('mouseenter', () => {
                        delBtn.style.background = KB_MANAGER_THEME.dangerHover;
                        delBtn.style.transform = 'translateY(-1px)';
                        delBtn.style.boxShadow = '0 2px 8px rgba(255, 82, 82, 0.3)';
                    });
                    delBtn.addEventListener('mouseleave', () => {
                        delBtn.style.background = KB_MANAGER_THEME.danger;
                        delBtn.style.transform = 'translateY(0)';
                        delBtn.style.boxShadow = '0 1px 3px rgba(255, 82, 82, 0.2)';
                    });
                    delBtn.addEventListener('mousedown', () => {
                        delBtn.style.background = KB_MANAGER_THEME.dangerActive;
                        delBtn.style.transform = 'translateY(1px) scale(0.98)';
                    });
                    delBtn.addEventListener('mouseup', () => {
                        delBtn.style.background = KB_MANAGER_THEME.dangerHover;
                        delBtn.style.transform = 'translateY(-1px)';
                    });

                    row.addEventListener('click', async () => {
                        await openManagerDocumentPreview(item);
                    });
                });
            }

            async function loadManagerDocuments() {
                if (managerLoading) {
                    return;
                }
                managerLoading = true;
                setManagerRowsMessage('文档列表加载中...');
                try {
                    let folders = [];
                    let docs = [];
                    try {
                        const managerView = await runPluginEntry('list_manager_view', {
                            parent_folder: managerCurrentFolder || '',
                            limit: 300,
                            include_subfolders: false
                        });
                        const mvData = managerView && managerView.data ? managerView.data : null;
                        folders = Array.isArray(mvData && mvData.folders) ? mvData.folders : [];
                        docs = Array.isArray(mvData && mvData.documents) ? mvData.documents : [];
                    } catch (_managerViewErr) {
                        let folderResult = null;
                        try {
                            folderResult = await runPluginEntry('list_document_folders', {
                                parent_folder: managerCurrentFolder || ''
                            });
                        } catch (err) {
                            folderResult = null;
                        }
                        const folderData = folderResult && folderResult.data ? folderResult.data : null;
                        folders = Array.isArray(folderData && folderData.folders) ? folderData.folders : [];

                        const listArgs = { limit: 300, include_subfolders: false };
                        if (managerCurrentFolder) {
                            listArgs.folder = managerCurrentFolder;
                        }
                        const result = await runPluginEntry('list_documents', listArgs);
                        const data = result && result.data ? result.data : null;
                        docs = Array.isArray(data && data.documents) ? data.documents : [];
                    }

                    managerFoldersCache = folders;
                    managerDocsCache = docs;
                    applyManagerDocsView();
                    if (!managerCurrentFolder) {
                        setManagerInlineStatus('');
                    }
                } catch (err) {
                    managerFoldersCache = [];
                    managerDocsCache = [];
                    setManagerRowsMessage(`读取文档列表失败: ${err && err.message ? err.message : err}`);
                } finally {
                    managerLoading = false;
                }
            }

            window.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape' && managerPreviewOverlay && managerPreviewOverlay.style.display === 'flex') {
                    managerPreviewOverlay.style.display = 'none';
                    return;
                }
                if (ev.key === 'Escape' && managerOverlay && managerOverlay.style.display === 'flex') {
                    managerOverlay.style.display = 'none';
                    if (typeof managerOverlay._setHudOverlayInteractivity === 'function') {
                        managerOverlay._setHudOverlayInteractivity(false);
                    }
                }
            });

            function arrayBufferToBase64(buffer) {
                const bytes = new Uint8Array(buffer);
                const chunkSize = 0x8000;
                let binary = '';
                for (let i = 0; i < bytes.length; i += chunkSize) {
                    const sub = bytes.subarray(i, i + chunkSize);
                    binary += String.fromCharCode(...sub);
                }
                return btoa(binary);
            }

            async function uploadKnowledgeFile(file, targetFolder = '') {
                if (!file) {
                    return;
                }
                const lowerName = String(file.name || '').toLowerCase();
                const isPdf = lowerName.endsWith('.pdf') || String(file.type || '').toLowerCase() === 'application/pdf';

                try {
                    setManagerInlineStatus('文档上传中，请稍候...');
                    const normalizedTargetFolder = normalizeManagerFolderPath(targetFolder);
                    let uploadResult = null;
                    if (isPdf) {
                        const arr = await file.arrayBuffer();
                        const pdfBase64 = arrayBufferToBase64(arr);
                        uploadResult = await runPluginEntry('upload_markdown', {
                            markdown_text: '',
                            pdf_base64: pdfBase64,
                            document_name: file.name,
                            folder: normalizedTargetFolder
                        });
                    } else {
                        const markdownText = await file.text();
                        uploadResult = await runPluginEntry('upload_markdown', {
                            markdown_text: markdownText,
                            document_name: file.name,
                            folder: normalizedTargetFolder
                        });
                    }
                    const data = uploadResult && uploadResult.data ? uploadResult.data : null;
                    const uploadedName = data && data.document_name ? data.document_name : file.name;
                    const total = data && Number.isFinite(Number(data.document_total)) ? Number(data.document_total) : kbState.documentTotal;

                    kbState.documentName = uploadedName;
                    kbState.documentTotal = total;
                    localStorage.setItem(KB_DOC_KEY, kbState.documentName);
                    localStorage.setItem(KB_DOC_TOTAL_KEY, String(kbState.documentTotal));
                    updateKbDocHint();

                    if (typeof window.showStatusToast === 'function') {
                        if (kbState.documentTotal > 1) {
                            window.showStatusToast(`知识库上传完成: ${uploadedName} (共 ${kbState.documentTotal} 篇)`, 3000);
                        } else {
                            window.showStatusToast(`知识库上传完成: ${uploadedName}`, 3000);
                        }
                    }
                    if (normalizedTargetFolder) {
                        setManagerInlineStatus(`上传完成: ${uploadedName} -> ${normalizedTargetFolder}`);
                    } else {
                        setManagerInlineStatus(`上传完成: ${uploadedName}`);
                    }
                } catch (err) {
                    if (typeof window.showStatusToast === 'function') {
                        window.showStatusToast(`知识库上传失败: ${err && err.message ? err.message : err}`, 5000);
                    }
                    setManagerInlineStatus(`上传失败: ${err && err.message ? err.message : err}`, true);
                }
            }

            kbModeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                kbState.enabled = !kbState.enabled;
                localStorage.setItem(KB_MODE_KEY, kbState.enabled ? '1' : '0');
                updateKbModeBadge();
                if (typeof window.showStatusToast === 'function') {
                    window.showStatusToast(kbState.enabled ? '知识库直连模式已开启' : '知识库直连模式已关闭', 2200);
                }
            });

            uploadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                fileInput.click();
            });

            manageBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                ensureManagerDialog();
                managerCurrentFolder = '';
                if (managerSearchInput) {
                    managerSearchInput.value = '';
                }
                if (managerSortSelect) {
                    managerSortSelect.value = 'updated_desc';
                }
                managerFilterKeyword = '';
                managerSortBy = 'updated_desc';
                setManagerInlineStatus('');
                if (typeof managerOverlay._setHudOverlayInteractivity === 'function') {
                    managerOverlay._setHudOverlayInteractivity(true);
                }
                managerOverlay.style.display = 'flex';
                await loadManagerDocuments();
            });

            fileInput.addEventListener('change', async () => {
                const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
                fileInput.value = '';
                if (!file) return;
                await uploadKnowledgeFile(file);
            });

            managerUploadInput.addEventListener('change', async () => {
                const file = managerUploadInput.files && managerUploadInput.files[0] ? managerUploadInput.files[0] : null;
                managerUploadInput.value = '';
                if (!file) return;
                await uploadKnowledgeFile(file, managerCurrentFolder || '');
                await loadManagerDocuments();
            });

            // 供聊天发送逻辑调用：开启后直接走 knowledge_base:ask
            window.nekoKnowledgeBaseDirect = {
                isEnabled: function () { return !!kbState.enabled; },
                hasDocument: function () { return !!kbState.documentName; },
                getDocumentName: function () { return kbState.documentName || ''; },
                askDirect: async function (questionText) {
                    const result = await runPluginEntry('ask', { question: questionText, top_k: 4 });
                    return result && result.data ? result.data : null;
                }
            };

            sidePanel.appendChild(kbModeBtn);
            sidePanel.appendChild(uploadBtn);
            sidePanel.appendChild(manageBtn);
            sidePanel.appendChild(kbDocHint);
            sidePanel.appendChild(fileInput);
            sidePanel.appendChild(managerUploadInput);
            document.body.appendChild(sidePanel);
            this._attachSidePanelHover(toggleItem, sidePanel);
        }
    });

    // 添加适配中的按钮（不可选）
    const adaptingItems = [
        { labelKey: 'settings.toggles.moltbotAdapting', fallback: 'moltbot（开发中）' }
    ];

    adaptingItems.forEach(item => {
        const adaptingItem = document.createElement('div');
        Object.assign(adaptingItem.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 8px',
            borderRadius: '6px',
            fontSize: '13px',
            whiteSpace: 'nowrap',
            opacity: '0.5',
            cursor: 'not-allowed',
            color: '#666'
        });

        const indicator = document.createElement('div');
        Object.assign(indicator.style, {
            width: '20px',
            height: '20px',
            borderRadius: '50%',
            border: '2px solid #ccc',
            backgroundColor: 'transparent',
            flexShrink: '0'
        });

        const label = document.createElement('span');
        label.textContent = window.t ? window.t(item.labelKey) : item.fallback;
        label.setAttribute('data-i18n', item.labelKey);
        label.style.userSelect = 'none';
        label.style.fontSize = '13px';
        label.style.color = '#999';

        adaptingItem.appendChild(indicator);
        adaptingItem.appendChild(label);
        popup.appendChild(adaptingItem);
    });
};

// 创建 Agent 任务 HUD（屏幕正中右侧）
window.AgentHUD.createAgentTaskHUD = function () {
    // 如果已存在则不重复创建
    if (document.getElementById('agent-task-hud')) {
        return document.getElementById('agent-task-hud');
    }

    if (this._cleanupDragging) {
        this._cleanupDragging();
        this._cleanupDragging = null;
    }

    // 初始化显示器边界缓存
    updateDisplayBounds();

    const hud = document.createElement('div');
    hud.id = 'agent-task-hud';

    // 获取保存的位置或使用默认位置
    const savedPos = localStorage.getItem('agent-task-hud-position');
    let position = { top: '50%', right: '20px', transform: 'translateY(-50%)' };

    if (savedPos) {
        try {
            const parsed = JSON.parse(savedPos);
            position = {
                top: parsed.top || '50%',
                left: parsed.left || null,
                right: parsed.right || '20px',
                transform: parsed.transform || 'translateY(-50%)'
            };
        } catch (e) {
            console.warn('Failed to parse saved position:', e);
        }
    }

    Object.assign(hud.style, {
        position: 'fixed',
        width: '320px',
        maxHeight: '60vh',
        background: 'var(--neko-popup-bg, rgba(255, 255, 255, 0.65))',
        backdropFilter: 'saturate(180%) blur(20px)',
        WebkitBackdropFilter: 'saturate(180%) blur(20px)',
        borderRadius: '8px',
        padding: '0',
        border: 'var(--neko-popup-border, 1px solid rgba(255, 255, 255, 0.18))',
        boxShadow: 'var(--neko-popup-shadow, 0 2px 4px rgba(0,0,0,0.04), 0 8px 16px rgba(0,0,0,0.08), 0 16px 32px rgba(0,0,0,0.04))',
        color: 'var(--neko-popup-text, #333)',
        fontFamily: "'Segoe UI', 'SF Pro Display', -apple-system, sans-serif",
        fontSize: '13px',
        zIndex: '9999',
        display: 'none',
        flexDirection: 'column',
        gap: '12px',
        pointerEvents: 'auto',
        overflowY: 'auto',
        transition: 'opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1), transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease, width 0.4s cubic-bezier(0.16, 1, 0.3, 1), padding 0.4s ease, max-height 0.4s ease',
        cursor: 'move',
        userSelect: 'none',
        willChange: 'transform, width',
        contain: 'layout style paint'
    });

    // 应用保存的位置
    if (position.top) hud.style.top = position.top;
    if (position.left) hud.style.left = position.left;
    if (position.right) hud.style.right = position.right;
    if (position.transform) hud.style.transform = position.transform;

    // HUD 标题栏
    const header = document.createElement('div');
    Object.assign(header.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        margin: '0',
        backgroundColor: 'var(--neko-hud-header-bg, rgba(255, 255, 255, 0.85))',
        borderTopLeftRadius: '8px',
        borderTopRightRadius: '8px',
        borderBottom: '1px solid var(--neko-popup-separator, rgba(0, 0, 0, 0.08))',
        touchAction: 'none',
        transition: 'padding 0.4s ease, margin 0.4s ease, border-color 0.4s ease, border-radius 0.4s ease, background-color 0.4s ease'
    });

    const title = document.createElement('div');
    title.id = 'agent-task-hud-title';
    title.innerHTML = `<span style="color: var(--neko-popup-accent, #2a7bc4); margin-right: 8px;">⚡</span>${window.t ? window.t('agent.taskHud.title') : 'Agent 任务'}`;
    Object.assign(title.style, {
        fontWeight: '600',
        fontSize: '15px',
        color: 'var(--neko-popup-text, #333)',
        transition: 'width 0.3s ease, opacity 0.3s ease',
        overflow: 'hidden',
        whiteSpace: 'nowrap'
    });

    // 统计信息
    const stats = document.createElement('div');
    stats.id = 'agent-task-hud-stats';
    Object.assign(stats.style, {
        display: 'flex',
        gap: '12px',
        fontSize: '11px'
    });
    stats.innerHTML = `
        <span style="color: var(--neko-popup-accent, #2a7bc4);" title="${window.t ? window.t('agent.taskHud.running') : '运行中'}">● <span id="hud-running-count">0</span></span>
        <span style="color: var(--neko-popup-text-sub, #666);" title="${window.t ? window.t('agent.taskHud.queued') : '队列中'}">◐ <span id="hud-queued-count">0</span></span>
    `;

    // 右侧容器（stats + minimize）
    const headerRight = document.createElement('div');
    Object.assign(headerRight.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexShrink: '0'
    });

    // 最小化按钮
    const minimizeBtn = document.createElement('div');
    minimizeBtn.id = 'agent-task-hud-minimize';
    minimizeBtn.innerHTML = '▼';
    Object.assign(minimizeBtn.style, {
        width: '22px',
        height: '22px',
        borderRadius: '6px',
        background: 'var(--neko-popup-accent-bg, rgba(42, 123, 196, 0.12))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '10px',
        fontWeight: 'bold',
        color: 'var(--neko-popup-accent, #2a7bc4)',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        flexShrink: '0'
    });
    minimizeBtn.title = window.t ? window.t('agent.taskHud.minimize') : '折叠/展开';

    // 终止按钮
    const cancelBtn = document.createElement('div');
    cancelBtn.id = 'agent-task-hud-cancel';
    cancelBtn.innerHTML = '✕';
    Object.assign(cancelBtn.style, {
        width: '22px',
        height: '22px',
        borderRadius: '6px',
        background: 'var(--neko-popup-error-bg, rgba(220, 53, 69, 0.12))',
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '11px',
        fontWeight: 'bold',
        color: 'var(--neko-popup-error, #dc3545)',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        flexShrink: '0'
    });
    cancelBtn.title = window.t ? window.t('agent.taskHud.cancelAll') : '终止所有任务';
    cancelBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const msg = window.t ? window.t('agent.taskHud.cancelConfirm') : '确定要终止所有正在进行的任务吗？';
        const title = window.t ? window.t('agent.taskHud.cancelAll') : '终止所有任务';
        const confirmed = await window.showConfirm(msg, title, { danger: true });
        if (!confirmed) return;
        try {
            cancelBtn.style.opacity = '0.5';
            cancelBtn.style.pointerEvents = 'none';
            await fetch('/api/agent/admin/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'end_all' })
            });
        } catch (err) {
            console.error('[AgentHUD] Cancel all tasks failed:', err);
        } finally {
            cancelBtn.style.opacity = '1';
            cancelBtn.style.pointerEvents = 'auto';
        }
    });

    headerRight.appendChild(stats);
    headerRight.appendChild(cancelBtn);
    headerRight.appendChild(minimizeBtn);
    header.appendChild(title);
    header.appendChild(headerRight);
    hud.appendChild(header);

    // 任务列表容器
    const taskList = document.createElement('div');
    taskList.id = 'agent-task-list';
    Object.assign(taskList.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '0 16px 16px 16px',
        maxHeight: 'calc(60vh - 80px)',
        overflowY: 'auto',
        transition: 'max-height 0.3s ease, opacity 0.3s ease, padding 0.3s ease',
        contain: 'layout style'
    });

    // 整体折叠逻辑 (key v2: reset stale collapsed state)
    const hudCollapsedKey = 'agent-task-hud-collapsed-v2';
    const applyHudCollapsed = (collapsed) => {
        if (!collapsed && hud.style.display !== 'none') {
            // Check edge collision for smooth unfolding direction towards the left
            const rect = hud.getBoundingClientRect();
            if (hud.style.left && hud.style.left !== 'auto') {
                const currentLeft = parseFloat(hud.style.left) || rect.left;
                if (currentLeft + 320 > window.innerWidth) {
                    // It will overflow right. Convert left anchor to right anchor
                    const currentRight = window.innerWidth - rect.right;
                    if (window.innerWidth - currentRight - 320 > 0) {
                        hud.style.right = currentRight + 'px';
                        hud.style.left = 'auto'; // let it expand to the left
                    } else {
                        hud.style.left = '0px';
                        hud.style.right = 'auto';
                    }
                }
            }
        }

        if (collapsed) {
            hud.style.width = 'auto';
            hud.style.gap = '0'; 
            
            header.style.padding = '12px 16px';
            header.style.backgroundColor = 'var(--neko-hud-header-bg, rgba(255, 255, 255, 0.85))';
            header.style.borderBottom = 'none';
            header.style.justifyContent = 'center';
            header.style.borderRadius = '8px'; // round all corners
            
            title.style.display = 'none';
            stats.style.display = 'flex';
            taskList.style.display = 'none'; 
            taskList.style.opacity = '0';
            minimizeBtn.style.transform = 'rotate(-90deg)';
        } else {
            hud.style.width = '320px';
            hud.style.gap = '12px'; 
            
            header.style.padding = '12px 16px';
            header.style.backgroundColor = 'var(--neko-hud-header-bg, rgba(255, 255, 255, 0.85))';
            header.style.borderBottom = '1px solid var(--neko-popup-separator, rgba(0, 0, 0, 0.08))';
            header.style.justifyContent = 'space-between';
            header.style.borderRadius = '8px 8px 0 0'; // round only top corners
            
            title.style.display = '';
            stats.style.display = 'flex';
            taskList.style.display = 'flex'; 
            taskList.style.maxHeight = 'calc(60vh - 80px)';
            taskList.style.opacity = '1';
            taskList.style.overflowY = 'auto';
            minimizeBtn.style.transform = 'rotate(0deg)';
        }
    };

    // Default: expanded
    let hudCollapsed = false;
    try { hudCollapsed = localStorage.getItem(hudCollapsedKey) === 'true'; } catch (_) { }
    applyHudCollapsed(hudCollapsed);

    minimizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hudCollapsed = !hudCollapsed;
        applyHudCollapsed(hudCollapsed);
        try { localStorage.setItem(hudCollapsedKey, String(hudCollapsed)); } catch (_) { }
    });

    // 空状态提示
    const emptyState = document.createElement('div');
    emptyState.id = 'agent-task-empty';

    // 空状态容器
    const emptyContent = document.createElement('div');
    emptyContent.textContent = window.t ? window.t('agent.taskHud.noTasks') : '暂无活动任务';
    Object.assign(emptyContent.style, {
        textAlign: 'center',
        color: 'var(--neko-popup-text-sub, #64748b)',
        padding: '20px',
        fontSize: '12px',
        transition: 'all 0.3s ease'
    });

    // 设置空状态容器样式
    Object.assign(emptyState.style, {
        position: 'relative',
        transition: 'all 0.3s ease'
    });

    emptyState.appendChild(emptyContent);
    taskList.appendChild(emptyState);

    hud.appendChild(taskList);

    document.body.appendChild(hud);

    // 添加拖拽功能
    this._setupDragging(hud);

    return hud;
};

// 设置空状态折叠功能 (已移除, 之前的 empty-state triangle 不再使用)
window.AgentHUD._setupCollapseFunctionality = function (emptyState, collapseButton, emptyContent) {
    // Legacy function, kept for signature compatibility if referenced
};

// 显示任务 HUD
window.AgentHUD.showAgentTaskHUD = function () {
    console.log('[AgentHUD][TimeoutTrace] showAgentTaskHUD called. Current timeout ID:', this._hideTimeout);
    
    // 清除任何正在进行的隐藏动画定时器，防止闪现后立刻消失
    if (this._hideTimeout) {
        console.log('[AgentHUD][TimeoutTrace] Clearing timeout ID:', this._hideTimeout);
        clearTimeout(this._hideTimeout);
        this._hideTimeout = null;
    }

    let hud = document.getElementById('agent-task-hud');
    if (!hud) {
        hud = this.createAgentTaskHUD();
    }
    hud.style.display = 'flex';
    hud.style.opacity = '1';
    const savedPos = localStorage.getItem('agent-task-hud-position');
    if (savedPos) {
        try {
            const parsed = JSON.parse(savedPos);
            if (parsed.top) hud.style.top = parsed.top;
            if (parsed.left) hud.style.left = parsed.left;
            if (parsed.right) hud.style.right = parsed.right;
            if (parsed.transform) hud.style.transform = parsed.transform;
        } catch (e) {
            hud.style.transform = 'translateY(-50%) translateX(0)';
        }
    } else {
        hud.style.transform = 'translateY(-50%) translateX(0)';
    }
};

// 隐藏任务 HUD
window.AgentHUD.hideAgentTaskHUD = function () {
    console.log('[AgentHUD] hideAgentTaskHUD called');
    let hud = document.getElementById('agent-task-hud');
    if (!hud) {
        console.log('[AgentHUD] HUD element not found, creating it first to hide it properly');
        hud = this.createAgentTaskHUD();
    }
    
    console.log('[AgentHUD] HUD element found, starting fade out');
    hud.style.opacity = '0';
    const savedPos = localStorage.getItem('agent-task-hud-position');
    if (!savedPos) {
        hud.style.transform = 'translateY(-50%) translateX(20px)';
    }

    // 如果之前有正在等待的隐藏定时器，先清理掉
    if (this._hideTimeout) {
        console.log('[AgentHUD][TimeoutTrace] hideAgentTaskHUD clearing previous timeout ID:', this._hideTimeout);
        clearTimeout(this._hideTimeout);
    }

    this._hideTimeout = setTimeout(() => {
        console.log('[AgentHUD][TimeoutTrace] HUD element display set to none. Timeout ID was:', this._hideTimeout);
        hud.style.display = 'none';
        this._hideTimeout = null;
    }, 300);
    console.log('[AgentHUD][TimeoutTrace] hideAgentTaskHUD set new timeout ID:', this._hideTimeout);
};

// 更新任务 HUD 内容
window.AgentHUD.updateAgentTaskHUD = function (tasksData) {
    // Cache latest snapshot so deferred re-render won't use stale closure data.
    this._latestTasksData = tasksData;

    // RAF throttle: coalesce rapid-fire WebSocket updates into a single frame
    if (this._updateRafId) return;
    this._updateRafId = requestAnimationFrame(() => {
        this._updateRafId = null;
        this._doUpdateAgentTaskHUD();
    });
};

// Internal: actual HUD update logic (called via RAF throttle)
window.AgentHUD._doUpdateAgentTaskHUD = function () {
    const tasksData = this._latestTasksData;
    if (!tasksData) return;

    const taskList = document.getElementById('agent-task-list');
    const emptyState = document.getElementById('agent-task-empty');
    const runningCount = document.getElementById('hud-running-count');
    const queuedCount = document.getElementById('hud-queued-count');
    const cancelBtn = document.getElementById('agent-task-hud-cancel');

    if (!taskList) {
        // HUD not yet created — create it now so incoming tasks can render
        if (typeof window.AgentHUD.createAgentTaskHUD === 'function') {
            window.AgentHUD.createAgentTaskHUD();
        }
        const retryList = document.getElementById('agent-task-list');
        if (!retryList) return;
        // Re-call with the now-created HUD
        return this._doUpdateAgentTaskHUD();
    }

    // 更新统计数据
    if (runningCount) runningCount.textContent = tasksData.running_count || 0;
    if (queuedCount) queuedCount.textContent = tasksData.queued_count || 0;

    // Show running/queued tasks + recently completed/failed tasks (linger 10s)
    if (!this._taskFirstSeen) this._taskFirstSeen = {};
    if (!this._taskStatusById) this._taskStatusById = {};
    if (!this._taskTerminalAt) this._taskTerminalAt = {};
    const now = Date.now();
    const MIN_DISPLAY_MS = 10000; // completed/failed tasks linger for 10 seconds

    // Track first-seen and terminal-at timestamps
    (tasksData.tasks || []).forEach(t => {
        if (!t.id) return;
        if (!this._taskFirstSeen[t.id]) this._taskFirstSeen[t.id] = now;
        this._taskStatusById[t.id] = t.status;
        // Record when a task first transitions to terminal status
        const isTerminal = t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled';
        if (isTerminal && !this._taskTerminalAt[t.id]) {
            this._taskTerminalAt[t.id] = now;
        }
    });

    // Show running/queued tasks + terminal tasks still within linger window
    const activeTasks = (tasksData.tasks || []).filter(t => {
        if (t.status === 'running' || t.status === 'queued') return true;
        const termAt = this._taskTerminalAt[t.id];
        if (termAt && (now - termAt) < MIN_DISPLAY_MS) return true;
        return false;
    });

    // Schedule a deferred re-render to clean up lingering cards after they expire
    const lingeringTasks = activeTasks.filter(t =>
        t.status !== 'running' && t.status !== 'queued'
    );
    if (lingeringTasks.length > 0) {
        // Reset timer so newly arrived terminal tasks get a full linger window
        if (this._lingerTimer) clearTimeout(this._lingerTimer);
        this._lingerTimer = setTimeout(() => {
            this._lingerTimer = null;
            if (window._agentTaskMap) {
                const snapshot = {
                    tasks: Array.from(window._agentTaskMap.values()),
                    running_count: 0,
                    queued_count: 0
                };
                snapshot.tasks.forEach(t => {
                    if (t.status === 'running') snapshot.running_count++;
                    if (t.status === 'queued') snapshot.queued_count++;
                });
                window.AgentHUD.updateAgentTaskHUD(snapshot);
            }
        }, MIN_DISPLAY_MS);
    }

    // Auto-show HUD when there are active tasks (handles race with checkAndToggleTaskHUD)
    if (activeTasks.length > 0) {
        const hud = document.getElementById('agent-task-hud');
        if (hud && (hud.style.display === 'none' || hud.style.opacity === '0')) {
            if (typeof window.AgentHUD.showAgentTaskHUD === 'function') {
                window.AgentHUD.showAgentTaskHUD();
            }
        }
    }

    // Clean up old cache entries (older than 30s since terminal or first seen)
    for (const tid in this._taskFirstSeen) {
        const terminalAt = this._taskTerminalAt[tid];
        const cleanupBase = terminalAt || this._taskFirstSeen[tid];
        if (!cleanupBase || now - cleanupBase <= 30000) continue;
        delete this._taskFirstSeen[tid];
        delete this._taskStatusById[tid];
        delete this._taskTerminalAt[tid];
    }

    if (cancelBtn) {
        const hasCancelable = activeTasks.some(t => t.status === 'running' || t.status === 'queued');
        cancelBtn.style.display = hasCancelable ? 'flex' : 'none';
    }

    // 显示/隐藏空状态（保留折叠状态）
    if (emptyState) {
        if (activeTasks.length === 0) {
            // 没有任务时显示空状态
            emptyState.style.display = 'block';
            emptyState.style.visibility = 'visible';
        } else {
            // 有任务时隐藏空状态，但保留折叠状态
            emptyState.style.display = 'none';
            emptyState.style.visibility = 'hidden';
        }
    }

    // 排序：前台任务（computer_use / mcp）优先，插件任务沉底
    const _taskSortPriority = (t) => {
        if (t.type === 'computer_use' || t.type === 'browser_use') return 0;
        if (t.type === 'mcp') return 1;
        // user_plugin / plugin_direct → 沉底
        return 2;
    };
    activeTasks.sort((a, b) => _taskSortPriority(a) - _taskSortPriority(b));

    // --- Differential DOM update: avoid full rebuild to prevent backdrop-filter recomposite flicker ---
    const activeIds = new Set(activeTasks.map(t => t.id));
    const existingCards = taskList.querySelectorAll('.task-card');
    const existingById = new Map();
    existingCards.forEach(card => {
        const tid = card.dataset.taskId;
        if (tid && activeIds.has(tid)) {
            existingById.set(tid, card);
        } else {
            card.remove(); // remove cards no longer active
        }
    });

    // Build the desired card order, reusing/updating existing cards
    const fragment = document.createDocumentFragment();
    activeTasks.forEach(task => {
        const existing = existingById.get(task.id);
        if (existing) {
            const node = this._updateTaskCard(existing, task);
            fragment.appendChild(node || existing);
        } else {
            const card = this._createTaskCard(task);
            fragment.appendChild(card);
        }
    });

    // Re-append empty state first (it should stay at top), then task cards
    if (emptyState && emptyState.parentNode === taskList) {
        taskList.insertBefore(fragment, emptyState.nextSibling);
    } else {
        taskList.appendChild(fragment);
    }
};

// 差异更新已有任务卡片（避免全量 DOM 重建触发 backdrop-filter 重合成导致模型闪烁）
window.AgentHUD._updateTaskCard = function (card, task) {
    const isRunning = task.status === 'running';
    const isCompleted = task.status === 'completed';
    const isFailed = task.status === 'failed';
    const isCancelled = task.status === 'cancelled';
    const isTerminal = isCompleted || isFailed || isCancelled;

    // Update start_time data attribute
    if (task.start_time) card.dataset.startTime = task.start_time;

    // Compute status visuals
    let statusColor, statusText, cardBg, cardBorder;
    if (isCompleted) {
        statusColor = 'var(--neko-popup-success, #16a34a)';
        statusText = window.t ? window.t('agent.taskHud.statusCompleted') : '已完成';
        cardBg = 'var(--neko-popup-success-bg, rgba(22, 163, 74, 0.06))';
        cardBorder = 'var(--neko-popup-success-border, rgba(22, 163, 74, 0.2))';
    } else if (isFailed) {
        statusColor = 'var(--neko-popup-error, #dc2626)';
        statusText = window.t ? window.t('agent.taskHud.statusFailed') : '失败';
        cardBg = 'var(--neko-popup-error-bg, rgba(220, 38, 38, 0.06))';
        cardBorder = 'var(--neko-popup-error-border, rgba(220, 38, 38, 0.2))';
    } else if (isCancelled) {
        statusColor = 'var(--neko-popup-text-sub, #666)';
        statusText = window.t ? window.t('agent.taskHud.statusCancelled') : '已取消';
        cardBg = 'var(--neko-popup-bg, rgba(249, 249, 249, 0.6))';
        cardBorder = 'var(--neko-popup-border-color, rgba(0, 0, 0, 0.06))';
    } else if (isRunning) {
        statusColor = 'var(--neko-popup-accent, #2a7bc4)';
        statusText = window.t ? window.t('agent.taskHud.statusRunning') : '运行中';
        cardBg = 'var(--neko-popup-accent-bg, rgba(42, 123, 196, 0.08))';
        cardBorder = 'var(--neko-popup-accent-border, rgba(42, 123, 196, 0.25))';
    } else {
        statusColor = 'var(--neko-popup-text-sub, #666)';
        statusText = window.t ? window.t('agent.taskHud.statusQueued') : '队列中';
        cardBg = 'var(--neko-popup-bg, rgba(249, 249, 249, 0.6))';
        cardBorder = 'var(--neko-popup-border-color, rgba(0, 0, 0, 0.06))';
    }

    // Use semantic state key to avoid comparing CSS var() strings against resolved style values
    const stateKey = isCancelled ? 'cancelled' : isCompleted ? 'completed' : isFailed ? 'failed' : isRunning ? 'running' : 'queued';
    if (card.dataset.cardState !== stateKey) {
        card.dataset.cardState = stateKey;
        card.style.background = cardBg;
        card.style.border = `1px solid ${cardBorder}`;
        card.style.opacity = isTerminal ? '0.6' : '1';
    }

    // Update status badge text & color (keyed by same state)
    const badge = card.querySelector('.task-status-badge');
    if (badge && badge.dataset.statusState !== stateKey) {
        badge.dataset.statusState = stateKey;
        badge.textContent = statusText;
        badge.style.color = statusColor;
        const badgeBg = isCompleted ? 'var(--neko-popup-success-bg, rgba(22, 163, 74, 0.1))' : isFailed ? 'var(--neko-popup-error-bg, rgba(220, 38, 38, 0.1))' : isRunning ? 'var(--neko-popup-accent-bg, rgba(42, 123, 196, 0.12))' : 'var(--neko-popup-bg, rgba(0, 0, 0, 0.05))';
        badge.style.background = badgeBg;
    }

    // Update header marginBottom (running tasks have extra space for progress row)
    const headerDiv = card.firstElementChild;
    if (headerDiv) {
        const expectedMB = isRunning ? '6px' : '0';
        if (headerDiv.style.marginBottom !== expectedMB) headerDiv.style.marginBottom = expectedMB;
    }

    // Hide per-card cancel button for terminal tasks
    const cardCancelBtn = card.querySelector('.task-card-cancel');
    if (cardCancelBtn) {
        const cancelDisplay = isTerminal ? 'none' : 'flex';
        if (cardCancelBtn.style.display !== cancelDisplay) cardCancelBtn.style.display = cancelDisplay;
    }

    // Handle progress row: add if now running but missing, remove if no longer running
    const progressRow = card.querySelector('.task-progress-row');
    if (isRunning && !progressRow) {
        // Status just changed to running — rebuild the card cleanly
        const newCard = this._createTaskCard(task);
        const parent = card.parentNode;
        if (parent) parent.replaceChild(newCard, card);
        return newCard;
    } else if (!isRunning && progressRow) {
        // No longer running — remove progress row
        progressRow.remove();
    }

    // Update running timer inline so it stays current between setInterval ticks
    if (isRunning && task.start_time) {
        const timeEl = card.querySelector('[id^="task-time-"]');
        if (timeEl) {
            const startTime = new Date(task.start_time);
            const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            timeEl.textContent = `\u23f1\ufe0f ${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
    }

    // Update progress bar and step counter for running tasks
    if (isRunning && progressRow) {
        const fill = progressRow.querySelector('.task-progress-fill');
        if (fill) {
            const hasDeterminateProgress = typeof task.progress === 'number' && task.progress >= 0;
            if (hasDeterminateProgress) {
                const pct = Math.min(100, Math.max(0, Math.round(task.progress * 100)));
                const newWidth = pct + '%';
                if (fill.style.width !== newWidth) fill.style.width = newWidth;
                // Switch from indeterminate animation to determinate if needed
                if (fill.style.animation) {
                    fill.style.animation = '';
                    fill.style.transition = 'width 0.3s ease';
                }
            } else {
                // Revert to indeterminate state
                if (!fill.style.animation || fill.style.width !== '30%') {
                    fill.style.width = '30%';
                    fill.style.transition = '';
                    fill.style.animation = 'taskProgress 1.5s ease-in-out infinite';
                }
            }
        }
        const stepEl = progressRow.querySelector('.task-progress-step');
        if (typeof task.step === 'number' && typeof task.step_total === 'number' && task.step_total > 0) {
            const stepText = `${task.step}/${task.step_total}`;
            if (stepEl) {
                if (stepEl.textContent !== stepText) stepEl.textContent = stepText;
            } else {
                // Step counter appeared after card was created — append it
                const newStep = document.createElement('span');
                newStep.className = 'task-progress-step';
                newStep.textContent = stepText;
                Object.assign(newStep.style, {
                    color: 'var(--neko-popup-text-sub, #999)',
                    fontSize: '10px',
                    flexShrink: '0'
                });
                progressRow.appendChild(newStep);
            }
        } else if (stepEl) {
            // Step info no longer available — remove stale element
            stepEl.remove();
        }
    }
};

// 创建单个任务卡片
window.AgentHUD._createTaskCard = function (task) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.taskId = task.id;
    if (task.start_time) {
        card.dataset.startTime = task.start_time;
    }

    const isRunning = task.status === 'running';
    const isCompleted = task.status === 'completed';
    const isFailed = task.status === 'failed';
    const isCancelled = task.status === 'cancelled';
    const isTerminal = isCompleted || isFailed || isCancelled;

    let statusColor, statusText, cardBg, cardBorder;
    if (isCompleted) {
        statusColor = 'var(--neko-popup-success, #16a34a)';
        statusText = window.t ? window.t('agent.taskHud.statusCompleted') : '已完成';
        cardBg = 'var(--neko-popup-success-bg, rgba(22, 163, 74, 0.06))';
        cardBorder = 'var(--neko-popup-success-border, rgba(22, 163, 74, 0.2))';
    } else if (isFailed) {
        statusColor = 'var(--neko-popup-error, #dc2626)';
        statusText = window.t ? window.t('agent.taskHud.statusFailed') : '失败';
        cardBg = 'var(--neko-popup-error-bg, rgba(220, 38, 38, 0.06))';
        cardBorder = 'var(--neko-popup-error-border, rgba(220, 38, 38, 0.2))';
    } else if (isCancelled) {
        statusColor = 'var(--neko-popup-text-sub, #666)';
        statusText = window.t ? window.t('agent.taskHud.statusCancelled') : '已取消';
        cardBg = 'var(--neko-popup-bg, rgba(249, 249, 249, 0.6))';
        cardBorder = 'var(--neko-popup-border-color, rgba(0, 0, 0, 0.06))';
    } else if (isRunning) {
        statusColor = 'var(--neko-popup-accent, #2a7bc4)';
        statusText = window.t ? window.t('agent.taskHud.statusRunning') : '运行中';
        cardBg = 'var(--neko-popup-accent-bg, rgba(42, 123, 196, 0.08))';
        cardBorder = 'var(--neko-popup-accent-border, rgba(42, 123, 196, 0.25))';
    } else {
        statusColor = 'var(--neko-popup-text-sub, #666)';
        statusText = window.t ? window.t('agent.taskHud.statusQueued') : '队列中';
        cardBg = 'var(--neko-popup-bg, rgba(249, 249, 249, 0.6))';
        cardBorder = 'var(--neko-popup-border-color, rgba(0, 0, 0, 0.06))';
    }

    Object.assign(card.style, {
        background: cardBg,
        borderRadius: '8px',
        padding: '10px 12px',
        border: `1px solid ${cardBorder}`,
        transition: 'all 0.2s ease',
        opacity: isTerminal ? '0.6' : '1'
    });

    // === 第一行：图标 + 名称 + 状态徽章 + 取消按钮 ===
    const header = document.createElement('div');
    Object.assign(header.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: isRunning ? '6px' : '0'
    });

    // 任务类型图标和名称
    const rawTypeName = task.type || task.source || 'unknown';
    const params = task.params || {};

    // 根据类型确定图标
    let typeIcon;
    if (rawTypeName === 'user_plugin' || rawTypeName === 'plugin_direct') {
        typeIcon = '🧩';
    } else if (rawTypeName === 'computer_use') {
        typeIcon = '🖱️';
    } else if (rawTypeName === 'browser_use') {
        typeIcon = '🌐';
    } else if (rawTypeName === 'mcp') {
        typeIcon = '🔌';
    } else {
        typeIcon = '⚙️';
    }

    // 根据类型确定名称
    let typeName = rawTypeName;
    if (rawTypeName === 'user_plugin' || rawTypeName === 'plugin_direct') {
        // 优先级：plugin_name > plugin_id > 翻译文本
        typeName = params.plugin_name || params.plugin_id || (window.t ? window.t('agent.taskHud.typeUserPlugin') : '用户插件');
    } else if (rawTypeName === 'computer_use') {
        typeName = window.t ? window.t('agent.taskHud.typeComputerUse') : '电脑控制';
    } else if (rawTypeName === 'browser_use') {
        typeName = window.t ? window.t('agent.taskHud.typeBrowserUse') : '浏览器控制';
    } else if (rawTypeName === 'mcp') {
        typeName = window.t ? window.t('agent.taskHud.typeMCP') : 'MCP工具';
    }

    const typeLabel = document.createElement('span');
    typeLabel.style.whiteSpace = 'nowrap';
    typeLabel.style.overflow = 'hidden';
    typeLabel.style.textOverflow = 'ellipsis';
    typeLabel.style.minWidth = '0';

    // 使用 textContent 防止 XSS（避免 plugin_name 中的 HTML 被解析）
    const iconSpan = document.createElement('span');
    iconSpan.textContent = typeIcon + ' ';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = typeName;
    Object.assign(nameSpan.style, {
        color: 'var(--neko-popup-text-sub, #666)',
        fontSize: '12px',
        fontWeight: '500'
    });
    typeLabel.appendChild(iconSpan);
    typeLabel.appendChild(nameSpan);

    const statusBadge = document.createElement('span');
    statusBadge.className = 'task-status-badge';
    statusBadge.textContent = statusText;
    Object.assign(statusBadge.style, {
        color: statusColor,
        fontSize: '11px',
        fontWeight: '500',
        padding: '1px 8px',
        background: isCompleted ? 'var(--neko-popup-success-bg, rgba(22, 163, 74, 0.1))' : isFailed ? 'var(--neko-popup-error-bg, rgba(220, 38, 38, 0.1))' : isRunning ? 'var(--neko-popup-accent-bg, rgba(42, 123, 196, 0.12))' : 'var(--neko-popup-bg, rgba(0, 0, 0, 0.05))',
        borderRadius: '10px',
        flexShrink: '0'
    });

    const headerLeft = document.createElement('div');
    Object.assign(headerLeft.style, { display: 'flex', alignItems: 'center', gap: '6px', minWidth: '0', flex: '1', overflow: 'hidden' });
    headerLeft.appendChild(typeLabel);
    headerLeft.appendChild(statusBadge);

    const taskCancelBtn = document.createElement('div');
    taskCancelBtn.className = 'task-card-cancel';
    taskCancelBtn.innerHTML = '✕';
    Object.assign(taskCancelBtn.style, {
        width: '18px',
        height: '18px',
        borderRadius: '4px',
        background: 'var(--neko-hud-subtle-bg, rgba(0, 0, 0, 0.06))',
        display: isTerminal ? 'none' : 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '10px',
        color: 'var(--neko-popup-text-sub, #999)',
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        flexShrink: '0',
        marginLeft: '6px'
    });
    taskCancelBtn.title = window.t ? window.t('agent.taskHud.cancelAll') : '终止任务';
    taskCancelBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        taskCancelBtn.style.opacity = '0.4';
        taskCancelBtn.style.pointerEvents = 'none';
        try {
            await fetch(`/api/agent/tasks/${encodeURIComponent(task.id)}/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (err) {
            console.error('[AgentHUD] Cancel task failed:', err);
        }
    });

    header.appendChild(headerLeft);
    header.appendChild(taskCancelBtn);
    card.appendChild(header);

    // === 描述行：显示任务具体内容（如"15分钟后 起来活动"） ===
    const rawDesc = params.description || params.instruction || '';
    const descText = rawDesc ? window.AgentHUD._shortenDesc(rawDesc) : '';
    if (descText) {
        const descRow = document.createElement('div');
        descRow.textContent = descText;
        if (rawDesc !== descText) descRow.title = rawDesc; // hover 显示完整内容
        Object.assign(descRow.style, {
            color: 'var(--neko-popup-text-sub, #888)',
            fontSize: '11px',
            lineHeight: '1.3',
            marginTop: '3px',
            marginBottom: isRunning ? '3px' : '0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
        });
        card.appendChild(descRow);
    }

    // === 第二行：倒计时 + 进度条（仅运行中任务） ===
    if (isRunning) {
        const secondRow = document.createElement('div');
        secondRow.className = 'task-progress-row';
        Object.assign(secondRow.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
        });

        // 倒计时
        if (task.start_time) {
            const timeSpan = document.createElement('span');
            const startTime = new Date(task.start_time);
            const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;

            timeSpan.id = `task-time-${task.id}`;
            timeSpan.textContent = `⏱️ ${minutes}:${seconds.toString().padStart(2, '0')}`;
            Object.assign(timeSpan.style, {
                color: 'var(--neko-popup-text-sub, #888)',
                fontSize: '11px',
                flexShrink: '0',
                whiteSpace: 'nowrap'
            });
            secondRow.appendChild(timeSpan);
        }

        // 进度条
        const hasDeterminateProgress = typeof task.progress === 'number' && task.progress >= 0;
        const progressBar = document.createElement('div');
        Object.assign(progressBar.style, {
            flex: '1',
            height: '3px',
            background: 'var(--neko-popup-accent-bg, rgba(42, 123, 196, 0.15))',
            borderRadius: '2px',
            overflow: 'hidden'
        });

        const progressFill = document.createElement('div');
        progressFill.className = 'task-progress-fill';
        if (hasDeterminateProgress) {
            const pct = Math.min(100, Math.max(0, Math.round(task.progress * 100)));
            Object.assign(progressFill.style, {
                height: '100%',
                width: pct + '%',
                background: 'linear-gradient(90deg, var(--neko-popup-accent, #2a7bc4), #66b5ff)',
                borderRadius: '2px',
                transition: 'width 0.3s ease'
            });
        } else {
            Object.assign(progressFill.style, {
                height: '100%',
                width: '30%',
                background: 'linear-gradient(90deg, var(--neko-popup-accent, #2a7bc4), #66b5ff)',
                borderRadius: '2px',
                animation: 'taskProgress 1.5s ease-in-out infinite'
            });
        }
        progressBar.appendChild(progressFill);
        secondRow.appendChild(progressBar);

        // Step counter (e.g. "2/3") — 紧凑显示在进度条右侧
        if (typeof task.step === 'number' && typeof task.step_total === 'number' && task.step_total > 0) {
            const stepSpan = document.createElement('span');
            stepSpan.className = 'task-progress-step';
            stepSpan.textContent = `${task.step}/${task.step_total}`;
            Object.assign(stepSpan.style, {
                color: 'var(--neko-popup-text-sub, #999)',
                fontSize: '10px',
                flexShrink: '0'
            });
            secondRow.appendChild(stepSpan);
        }

        card.appendChild(secondRow);
    }

    return card;
};

// 设置HUD全局拖拽功能
window.AgentHUD._setupDragging = function (hud) {
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    // 高性能拖拽函数
    const performDrag = (clientX, clientY) => {
        if (!isDragging) return;

        // 使用requestAnimationFrame确保流畅动画
        requestAnimationFrame(() => {
            // 计算新位置
            const newX = clientX - dragOffsetX;
            const newY = clientY - dragOffsetY;

            // 获取HUD尺寸和窗口尺寸
            const hudRect = hud.getBoundingClientRect();
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;

            // 边界检查 - 确保HUD不会超出窗口
            const constrainedX = Math.max(0, Math.min(newX, windowWidth - hudRect.width));
            const constrainedY = Math.max(0, Math.min(newY, windowHeight - hudRect.height));

            // 使用transform进行高性能定位
            hud.style.left = constrainedX + 'px';
            hud.style.top = constrainedY + 'px';
            hud.style.right = 'auto';
            hud.style.transform = 'none';
        });
    };

    // 鼠标按下事件 - 全局可拖动
    const handleMouseDown = (e) => {
        // 排除内部可交互元素
        const interactiveSelectors = ['button', 'input', 'textarea', 'select', 'a', '.task-card', '#agent-task-hud-minimize', '#agent-task-hud-cancel', '.task-card-cancel', '.collapse-button'];
        const isInteractive = e.target.closest(interactiveSelectors.join(','));

        if (isInteractive) return;

        isDragging = true;

        // 视觉反馈
        hud.style.cursor = 'grabbing';
        hud.style.boxShadow = '0 12px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.2)';
        hud.style.opacity = '0.95';
        hud.style.transition = 'none'; // 拖拽时禁用过渡动画

        const rect = hud.getBoundingClientRect();
        // 计算鼠标相对于HUD的偏移
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;

        e.preventDefault();
        e.stopPropagation();
    };

    // 鼠标移动事件 - 高性能处理
    const handleMouseMove = (e) => {
        if (!isDragging) return;

        // 使用节流优化性能
        performDrag(e.clientX, e.clientY);

        e.preventDefault();
        e.stopPropagation();
    };

    // 鼠标释放事件
    const handleMouseUp = (e) => {
        if (!isDragging) return;

        isDragging = false;

        // 恢复视觉状态
        hud.style.cursor = 'move';
        hud.style.boxShadow = 'var(--neko-popup-shadow, 0 2px 4px rgba(0,0,0,0.04), 0 8px 16px rgba(0,0,0,0.08), 0 16px 32px rgba(0,0,0,0.04))';
        hud.style.opacity = '1';
        hud.style.transition = 'opacity 0.3s ease, transform 0.3s ease, box-shadow 0.2s ease, width 0.3s ease, padding 0.3s ease, max-height 0.3s ease';

        // 最终位置校准（多屏幕支持）
        requestAnimationFrame(() => {
            const rect = hud.getBoundingClientRect();

            // 使用缓存的屏幕边界进行限制
            if (!cachedDisplayHUD) {
                console.warn('cachedDisplayHUD not initialized, skipping bounds check');
                return;
            }
            const displayLeft = cachedDisplayHUD.x;
            const displayTop = cachedDisplayHUD.y;
            const displayRight = cachedDisplayHUD.x + cachedDisplayHUD.width;
            const displayBottom = cachedDisplayHUD.y + cachedDisplayHUD.height;

            // 确保位置在当前屏幕内
            let finalLeft = parseFloat(hud.style.left) || 0;
            let finalTop = parseFloat(hud.style.top) || 0;

            finalLeft = Math.max(displayLeft, Math.min(finalLeft, displayRight - rect.width));
            finalTop = Math.max(displayTop, Math.min(finalTop, displayBottom - rect.height));

            hud.style.left = finalLeft + 'px';
            hud.style.top = finalTop + 'px';

            // 保存位置到localStorage
            const position = {
                left: hud.style.left,
                top: hud.style.top,
                right: hud.style.right,
                transform: hud.style.transform
            };

            try {
                localStorage.setItem('agent-task-hud-position', JSON.stringify(position));
            } catch (error) {
                console.warn('Failed to save position to localStorage:', error);
            }
        });

        e.preventDefault();
        e.stopPropagation();
    };

    // 绑定事件监听器 - 全局拖拽
    hud.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // 防止在拖拽时选中文本
    hud.addEventListener('dragstart', (e) => e.preventDefault());

    // 触摸事件支持（移动设备）- 全局拖拽
    let touchDragging = false;

    // 触摸开始
    const handleTouchStart = (e) => {
        // 排除内部可交互元素
        const interactiveSelectors = ['button', 'input', 'textarea', 'select', 'a', '.task-card', '#agent-task-hud-minimize', '#agent-task-hud-cancel', '.task-card-cancel', '.collapse-button'];
        const isInteractive = e.target.closest(interactiveSelectors.join(','));

        if (isInteractive) return;

        touchDragging = true;
        isDragging = true;  // 让performDrag函数能正常工作

        // 视觉反馈
        hud.style.boxShadow = '0 12px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.2)';
        hud.style.opacity = '0.95';
        hud.style.transition = 'none';

        const touch = e.touches[0];
        const rect = hud.getBoundingClientRect();
        // 使用与鼠标事件相同的偏移量变量喵
        dragOffsetX = touch.clientX - rect.left;
        dragOffsetY = touch.clientY - rect.top;

        e.preventDefault();
    };

    // 触摸移动
    const handleTouchMove = (e) => {
        if (!touchDragging) return;

        const touch = e.touches[0];
        performDrag(touch.clientX, touch.clientY);

        e.preventDefault();
    };

    // 触摸结束
    const handleTouchEnd = (e) => {
        if (!touchDragging) return;

        touchDragging = false;
        isDragging = false;  // 确保performDrag函数停止工作

        // 恢复视觉状态
        hud.style.boxShadow = 'var(--neko-popup-shadow, 0 2px 4px rgba(0,0,0,0.04), 0 8px 16px rgba(0,0,0,0.08), 0 16px 32px rgba(0,0,0,0.04))';
        hud.style.opacity = '1';
        hud.style.transition = 'opacity 0.3s ease, transform 0.3s ease, box-shadow 0.2s ease, width 0.3s ease, padding 0.3s ease, max-height 0.3s ease';

        // 最终位置校准（多屏幕支持）
        requestAnimationFrame(() => {
            const rect = hud.getBoundingClientRect();

            // 使用缓存的屏幕边界进行限制
            if (!cachedDisplayHUD) {
                console.warn('cachedDisplayHUD not initialized, skipping bounds check');
                return;
            }
            const displayLeft = cachedDisplayHUD.x;
            const displayTop = cachedDisplayHUD.y;
            const displayRight = cachedDisplayHUD.x + cachedDisplayHUD.width;
            const displayBottom = cachedDisplayHUD.y + cachedDisplayHUD.height;

            // 确保位置在当前屏幕内
            let finalLeft = parseFloat(hud.style.left) || 0;
            let finalTop = parseFloat(hud.style.top) || 0;

            finalLeft = Math.max(displayLeft, Math.min(finalLeft, displayRight - rect.width));
            finalTop = Math.max(displayTop, Math.min(finalTop, displayBottom - rect.height));

            hud.style.left = finalLeft + 'px';
            hud.style.top = finalTop + 'px';

            // 保存位置到localStorage
            const position = {
                left: hud.style.left,
                top: hud.style.top,
                right: hud.style.right,
                transform: hud.style.transform
            };

            try {
                localStorage.setItem('agent-task-hud-position', JSON.stringify(position));
            } catch (error) {
                console.warn('Failed to save position to localStorage:', error);
            }
        });

        e.preventDefault();
    };

    // 绑定触摸事件
    hud.addEventListener('touchstart', handleTouchStart, { passive: false });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd, { passive: false });

    // 窗口大小变化时重新校准位置（多屏幕支持）
    const handleResize = async () => {
        if (isDragging || touchDragging) return;

        // 更新屏幕信息
        const rect = hud.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        await updateDisplayBounds(centerX, centerY);

        requestAnimationFrame(() => {
            const rect = hud.getBoundingClientRect();

            // 使用缓存的屏幕边界进行限制
            if (!cachedDisplayHUD) {
                console.warn('cachedDisplayHUD not initialized, skipping bounds check');
                return;
            }
            const displayLeft = cachedDisplayHUD.x;
            const displayTop = cachedDisplayHUD.y;
            const displayRight = cachedDisplayHUD.x + cachedDisplayHUD.width;
            const displayBottom = cachedDisplayHUD.y + cachedDisplayHUD.height;

            // 如果HUD超出当前屏幕，调整到可见位置
            if (rect.left < displayLeft || rect.top < displayTop ||
                rect.right > displayRight || rect.bottom > displayBottom) {

                let newLeft = parseFloat(hud.style.left) || 0;
                let newTop = parseFloat(hud.style.top) || 0;

                newLeft = Math.max(displayLeft, Math.min(newLeft, displayRight - rect.width));
                newTop = Math.max(displayTop, Math.min(newTop, displayBottom - rect.height));

                hud.style.left = newLeft + 'px';
                hud.style.top = newTop + 'px';

                // 更新保存的位置
                const position = {
                    left: hud.style.left,
                    top: hud.style.top,
                    right: hud.style.right,
                    transform: hud.style.transform
                };

                try {
                    localStorage.setItem('agent-task-hud-position', JSON.stringify(position));
                } catch (error) {
                    console.warn('Failed to save position to localStorage:', error);
                }
            }
        });
    };

    window.addEventListener('resize', handleResize);

    // 清理函数
    this._cleanupDragging = () => {
        hud.removeEventListener('mousedown', handleMouseDown);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        hud.removeEventListener('touchstart', handleTouchStart);
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
        window.removeEventListener('resize', handleResize);
    };
};

// 添加任务进度动画样式
(function () {
    if (document.getElementById('agent-task-hud-styles')) return;

    const style = document.createElement('style');
    style.id = 'agent-task-hud-styles';
    style.textContent = `
        @keyframes taskProgress {
            0% { transform: translateX(-100%); }
            50% { transform: translateX(200%); }
            100% { transform: translateX(-100%); }
        }
        
        /* 请她回来按钮呼吸特效 */
        @keyframes returnButtonBreathing {
            0%, 100% {
                box-shadow: 0 0 8px rgba(68, 183, 254, 0.6), 0 2px 4px rgba(0, 0, 0, 0.04), 0 8px 16px rgba(0, 0, 0, 0.08);
            }
            50% {
                box-shadow: 0 0 18px rgba(68, 183, 254, 1), 0 2px 4px rgba(0, 0, 0, 0.04), 0 8px 16px rgba(0, 0, 0, 0.08);
            }
        }
        
        #live2d-btn-return {
            animation: returnButtonBreathing 2s ease-in-out infinite;
        }
        
        #live2d-btn-return:hover {
            animation: none;
        }
        
        #agent-task-hud::-webkit-scrollbar {
            width: 4px;
        }
        
        #agent-task-hud::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.03);
            border-radius: 2px;
        }
        
        #agent-task-hud::-webkit-scrollbar-thumb {
            background: rgba(0, 0, 0, 0.12);
            border-radius: 2px;
        }
        
        #agent-task-list::-webkit-scrollbar {
            width: 4px;
        }
        
        #agent-task-list::-webkit-scrollbar-track {
            background: transparent;
        }
        
        #agent-task-list::-webkit-scrollbar-thumb {
            background: rgba(0, 0, 0, 0.1);
            border-radius: 2px;
        }
        
        .task-card:hover {
            background: rgba(68, 183, 254, 0.12) !important;
            transform: translateX(-2px);
        }
        
        .task-card-cancel:hover {
            background: rgba(220, 53, 69, 0.15) !important;
            color: #dc3545 !important;
            transform: scale(1.15);
        }
        
        .task-card-cancel:active {
            transform: scale(0.9);
        }
        
        #agent-task-hud-minimize:hover {
            background: rgba(68, 183, 254, 0.25);
            transform: scale(1.1);
        }
        
        #agent-task-hud-minimize:active {
            transform: scale(0.95);
        }
        
        #agent-task-hud-cancel:hover {
            background: rgba(220, 53, 69, 0.25);
            transform: scale(1.1);
        }
        
        #agent-task-hud-cancel:active {
            transform: scale(0.95);
        }
        
        /* 折叠功能样式 */
        #agent-task-empty {
            position: relative;
            transition: all 0.3s ease;
            overflow: hidden;
        }
        
        #agent-task-empty > div:first-child {
            transition: all 0.3s ease;
            opacity: 1;
            height: auto;
            padding: 20px;
            margin: 0;
        }
        
        #agent-task-empty.collapsed > div:first-child {
            opacity: 0;
            height: 0;
            padding: 0;
            margin: 0;
        }
        
        .collapse-button {
            position: absolute;
            top: 8px;
            right: 8px;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background: rgba(68, 183, 254, 0.12);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            color: #999;
            cursor: pointer;
            transition: all 0.2s ease;
            z-index: 1;
            user-select: none;
            -webkit-user-select: none;
            -moz-user-select: none;
            -ms-user-select: none;
        }
        
        .collapse-button:hover {
            background: rgba(68, 183, 254, 0.25);
            transform: scale(1.1);
        }
        
        .collapse-button:active {
            transform: scale(0.95);
        }
        
        .collapse-button.collapsed {
            background: rgba(68, 183, 254, 0.18);
            color: #888;
        }
        
        /* 移动设备优化 */
        @media (max-width: 768px) {
            .collapse-button {
                width: 24px;
                height: 24px;
                font-size: 12px;
                top: 6px;
                right: 6px;
            }
            
            .collapse-button:hover {
                transform: scale(1.05);
            }
        }
    `;
    document.head.appendChild(style);
})();
