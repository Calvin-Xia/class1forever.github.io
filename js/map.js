/**
 * @fileoverview 蹭饭地图核心模块
 *
 * 公开地图数据通过 Cloudflare Pages Functions 从 KV 读取。
 * 公开访客只看到省市聚合统计，班内明细需要服务端口令会话后按地区拉取。
 */

const isTouchDevice = (function() {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
        return true;
    }
    if (window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches) {
        return true;
    }
    return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
})();

const AppState = {
    chart: null,
    publicData: null,
    provinces: {},
    activeProvince: null,
    detailsCache: new Map(),
    detailRequestVersion: 0,
    detailAccess: false,
    detailModeAvailable: false,
    detailModeEnabled: false,
    detailsHint: '',
    pendingPoint: null
};

const ui = {
    loading: document.getElementById('map-loading'),
    error: document.getElementById('cdn-error'),
    errorTitle: document.getElementById('cdn-error-title'),
    errorMessage: document.getElementById('cdn-error-message'),
    note: document.getElementById('interaction-note'),
    detailsButton: document.getElementById('details-btn'),
    authOverlay: document.getElementById('auth-overlay'),
    authClose: document.getElementById('auth-close'),
    authForm: document.getElementById('auth-form'),
    authInput: document.getElementById('auth-passphrase'),
    authFeedback: document.getElementById('auth-feedback'),
    authSubmit: document.getElementById('auth-submit'),
    authHint: document.getElementById('auth-hint')
};

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function hideMapLoading() {
    if (ui.loading) {
        ui.loading.style.display = 'none';
    }
}

function showProvinceLoading(provinceName) {
    if (!ui.loading) {
        return;
    }
    var text = ui.loading.querySelector('.map-loading__text');
    if (text && provinceName) {
        text.textContent = '正在加载 ' + provinceName + ' 地图...';
    }
    ui.loading.style.display = 'flex';
}

const ProvinceMapLoader = (function() {
    const pending = {};

    function isLoaded(filename) {
        return Boolean(filename && Highcharts.maps['cn/' + filename]);
    }

    function load(filename) {
        if (isLoaded(filename)) {
            return Promise.resolve();
        }
        if (pending[filename]) {
            return pending[filename];
        }
        pending[filename] = new Promise(function(resolve, reject) {
            const script = document.createElement('script');
            script.src = 'js/province/' + filename + '.js';
            script.onload = function() {
                delete pending[filename];
                resolve();
            };
            script.onerror = function() {
                delete pending[filename];
                reject(new Error('Failed to load province map: ' + filename));
            };
            document.body.appendChild(script);
        });
        return pending[filename];
    }

    return {
        isLoaded: isLoaded,
        load: load
    };
})();

const PUBLIC_CACHE_KEY = 'class1forever:public:v1';

function readPublicCache() {
    try {
        const raw = localStorage.getItem(PUBLIC_CACHE_KEY);
        if (!raw) {
            return null;
        }
        const cached = JSON.parse(raw);
        if (!cached || typeof cached !== 'object' || typeof cached.generatedAt !== 'string') {
            return null;
        }
        if (!cached.provinces || !cached.stats) {
            return null;
        }
        return cached;
    } catch (_error) {
        return null;
    }
}

function writePublicCache(data) {
    try {
        localStorage.setItem(PUBLIC_CACHE_KEY, JSON.stringify(data));
    } catch (_error) {
        // Storage may be unavailable (private mode / quota); cache is best-effort.
    }
}

function applyPublicData(data) {
    AppState.publicData = data;
    AppState.detailAccess = Boolean(data.detailAccess);
    AppState.detailModeAvailable = Boolean(data.detailModeAvailable);
    AppState.detailsHint = typeof data.detailsHint === 'string' ? data.detailsHint : '';
}

function showFatalError(message, title) {
    if (ui.errorTitle) {
        ui.errorTitle.textContent = title || '地图加载失败';
    }
    if (ui.errorMessage) {
        ui.errorMessage.textContent = message;
    }
    if (ui.error) {
        ui.error.style.display = 'flex';
    }
    hideMapLoading();
}

function normalizeApiErrorMessage(error, fallback) {
    if (error && error.payload && typeof error.payload.message === 'string' && error.payload.message) {
        return error.payload.message;
    }
    if (error && typeof error.message === 'string' && error.message) {
        return error.message;
    }
    return fallback;
}

async function fetchJson(url, init) {
    const requestInit = Object.assign({
        credentials: 'same-origin'
    }, init || {});

    const response = await fetch(url, requestInit);
    let payload = null;

    try {
        payload = await response.json();
    } catch (_error) {
        payload = null;
    }

    if (!response.ok) {
        const error = new Error(payload && payload.message ? payload.message : `Request failed with status ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

function fitChartToBounds(chart) {
    if (!chart) {
        return;
    }

    if (chart.mapView) {
        window.setTimeout(function() {
            chart.mapView.fitToBounds(undefined, undefined, true);
        }, 50);
        return;
    }

    if (chart.mapZoom) {
        window.setTimeout(function() {
            chart.mapZoom();
        }, 50);
    }
}

function getPointCount(point) {
    return Number(point && point.value ? point.value : 0);
}

function normalizeRegionToken(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim();
    if (!normalized || normalized === 'null' || normalized === 'undefined') {
        return null;
    }

    return normalized;
}

function getSeriesProvinceName(point) {
    return normalizeRegionToken(
        point &&
        point.series &&
        point.series.userOptions &&
        point.series.userOptions.provinceName
    );
}

function getActiveProvinceName() {
    return normalizeRegionToken(AppState.activeProvince);
}

function getPointRegion(point) {
    const activeProvinceName = getActiveProvinceName();
    const seriesProvinceName = getSeriesProvinceName(point);
    const pointName = normalizeRegionToken(point && point.name);
    const province = normalizeRegionToken(point && point.province) ||
        seriesProvinceName ||
        activeProvinceName ||
        pointName;
    let city = normalizeRegionToken(point && point.city);

    if (!city) {
        if (activeProvinceName && pointName && pointName !== activeProvinceName) {
            city = pointName;
        } else if (seriesProvinceName && pointName && pointName !== seriesProvinceName) {
            city = pointName;
        }
    }

    return {
        province: province,
        city: city
    };
}

function getRegionKey(region) {
    return region.city ? `${region.province}::${region.city}` : `${region.province}::*`;
}

function getPublicHint() {
    if (!AppState.detailModeAvailable) {
        return '仅展示公开人数。';
    }

    if (!AppState.detailAccess) {
        return '公开页仅显示人数。';
    }

    if (AppState.detailModeEnabled) {
        return '详情模式已开启。';
    }

    return '已确认，可以查看详情。';
}

function renderPublicCard(point, options) {
    const cardOptions = options || {};
    const count = getPointCount(point);
    const region = getPointRegion(point);
    const metaHtml = region.city
        ? `<div class="tooltip__meta"><strong>${escapeHtml(region.province)}</strong> · 城市公开人数</div>`
        : `<div class="tooltip__meta">覆盖城市 <strong>${Number(point.cityCount || 0)}</strong> 座</div>`;
    const emptyHtml = count === 0 && !cardOptions.hideEmpty && !cardOptions.callout
        ? '<div class="tooltip__empty">当前公开数据中暂无记录。</div>'
        : '';
    const hint = cardOptions.compact || cardOptions.hideHint ? '' : getPublicHint();
    const hintHtml = hint ? `<div class="tooltip__hint">${escapeHtml(hint)}</div>` : '';
    const calloutHtml = cardOptions.callout
        ? `<div class="tooltip__callout">${escapeHtml(cardOptions.callout)}</div>`
        : '';

    return `
        <div class="tooltip">
            <div class="series">公开概况</div>
            <div class="profile">
                <div class="name">${escapeHtml(point.name)}</div>
                <div class="value">${count}人</div>
            </div>
            ${metaHtml}
            ${emptyHtml}
            ${hintHtml}
            ${calloutHtml}
        </div>
    `;
}

function renderLoadingCard(point) {
    return `
        <div class="tooltip">
            <div class="series">同学信息</div>
            <div class="profile">
                <div class="name">${escapeHtml(point.name)}</div>
                <div class="value">读取中</div>
            </div>
            <div class="tooltip__callout">正在加载这个地区的同学信息，请稍候。</div>
        </div>
    `;
}

function renderDetailCard(payload) {
    const metaHtml = payload.city
        ? `<div class="tooltip__meta"><strong>${escapeHtml(payload.province)}</strong> · ${escapeHtml(payload.city)}</div>`
        : '<div class="tooltip__meta">省内班内明细</div>';

    const listHtml = payload.people.length > 0
        ? `
            <div class="list">
                ${payload.people.map(function(person) {
                    return `
                        <div class="pinfo">
                            <div class="pname">${escapeHtml(person.name)}</div>
                            <div class="city">${escapeHtml(person.city)}</div>
                            <div class="school">${escapeHtml(person.school)}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        `
        : '<div class="tooltip__empty">该地区暂无已登记的班内明细。</div>';

    return `
        <div class="tooltip">
            <div class="series">同学信息</div>
            <div class="profile">
                <div class="name">${escapeHtml(payload.city || payload.province)}</div>
                <div class="value">${Number(payload.count || 0)}人</div>
            </div>
            ${metaHtml}
            ${listHtml}
        </div>
    `;
}

const BottomSheet = (function() {
    const elements = {
        overlay: document.getElementById('bs-overlay'),
        sheet: document.getElementById('bottom-sheet'),
        content: document.getElementById('bs-content'),
        primaryButton: document.getElementById('bs-primary-btn'),
        drilldownButton: document.getElementById('bs-drilldown-btn')
    };

    let currentPoint = null;
    let currentMode = 'public';

    function isActive() {
        return Boolean(elements.sheet && elements.sheet.classList.contains('active'));
    }

    function updateButtons() {
        if (!currentPoint) {
            elements.primaryButton.hidden = true;
            elements.drilldownButton.hidden = true;
            return;
        }

        if (!AppState.detailModeAvailable) {
            elements.primaryButton.hidden = true;
        } else {
            elements.primaryButton.hidden = false;
            if (!AppState.detailAccess) {
                elements.primaryButton.textContent = '输入口令后查看';
            } else if (!AppState.detailModeEnabled) {
                elements.primaryButton.textContent = '查看同学信息';
            } else if (currentMode === 'detail') {
                elements.primaryButton.textContent = '重新加载';
            } else {
                elements.primaryButton.textContent = '查看同学信息';
            }
        }

        if (currentPoint.drilldown) {
            elements.drilldownButton.hidden = false;
            elements.drilldownButton.textContent = `进入 ${currentPoint.name} 地图详情`;
        } else {
            elements.drilldownButton.hidden = true;
        }
    }

    function open() {
        elements.sheet.classList.add('active');
        elements.overlay.classList.add('active');
    }

    function close() {
        elements.sheet.classList.remove('active');
        elements.overlay.classList.remove('active');
        currentMode = 'public';
    }

    function showPublic(point, options) {
        currentPoint = point;
        currentMode = 'public';
        elements.content.innerHTML = renderPublicCard(point, options);
        updateButtons();
        open();
    }

    function showLoading(point) {
        currentPoint = point;
        currentMode = 'loading';
        elements.content.innerHTML = renderLoadingCard(point);
        updateButtons();
        open();
    }

    function showDetail(point, payload) {
        currentPoint = point;
        currentMode = 'detail';
        elements.content.innerHTML = renderDetailCard(payload);
        updateButtons();
        open();
    }

    function hideSensitive() {
        if (!isActive() || !currentPoint) {
            return;
        }

        if (currentMode === 'detail' || currentMode === 'loading') {
            showPublic(currentPoint);
        }
    }

    async function handlePrimaryClick() {
        if (!currentPoint || !AppState.detailModeAvailable) {
            return;
        }

        if (!AppState.detailAccess) {
            AppState.pendingPoint = currentPoint;
            openAuthModal('输入口令后可查看这个地区的同学信息。');
            return;
        }

        AppState.detailModeEnabled = true;
        updateDetailsButton();
        updateInteractionNote();
        await showDetailSheetForPoint(currentPoint, currentMode === 'detail');
    }

    function handleDrilldownClick() {
        if (currentPoint && currentPoint.drilldown) {
            drilldownPoint(currentPoint);
        }
    }

    function init() {
        elements.overlay.addEventListener('click', close);
        elements.primaryButton.addEventListener('click', function() {
            handlePrimaryClick().catch(function(error) {
                console.error('Bottom sheet primary action failed:', error);
            });
        });
        elements.drilldownButton.addEventListener('click', handleDrilldownClick);
    }

    return {
        init,
        isActive,
        close,
        showPublic,
        showLoading,
        showDetail,
        hideSensitive,
        getCurrentPoint: function() {
            return currentPoint;
        }
    };
})();

function setAuthFeedback(message, variant) {
    ui.authFeedback.textContent = message || '';
    if (variant === 'error' || variant === 'success') {
        ui.authFeedback.setAttribute('data-variant', variant);
    } else {
        ui.authFeedback.removeAttribute('data-variant');
    }
}

function openAuthModal(message) {
    ui.authOverlay.hidden = false;
    ui.authHint.textContent = AppState.detailsHint
        ? `口令提示：${AppState.detailsHint}`
        : '如忘记口令，请联系老师或同学。';
    setAuthFeedback(message || '', null);
    window.setTimeout(function() {
        ui.authInput.focus();
    }, 0);
}

function closeAuthModal() {
    ui.authOverlay.hidden = true;
    ui.authForm.reset();
    setAuthFeedback('', null);
    AppState.pendingPoint = null;
}

async function handleAuthSubmit(event) {
    event.preventDefault();

    const passphrase = ui.authInput.value.trim();
    if (!passphrase) {
        setAuthFeedback('请输入口令。', 'error');
        ui.authInput.focus();
        return;
    }

    ui.authSubmit.disabled = true;
    setAuthFeedback('正在确认口令...', null);

    try {
        await fetchJson('/api/auth/details', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify({ passphrase: passphrase })
        });

        const pendingPoint = AppState.pendingPoint;
        AppState.detailAccess = true;
        AppState.detailModeEnabled = true;
        updateDetailsButton();
        updateInteractionNote();
        closeAuthModal();

        if (pendingPoint) {
            await showDetailSheetForPoint(pendingPoint, true);
        }
    } catch (error) {
        let message = normalizeApiErrorMessage(error, '暂时无法确认口令，请稍后再试。');
        if (
            error &&
            error.payload &&
            typeof error.payload.remainingAttempts === 'number' &&
            error.status === 401
        ) {
            message += ` 剩余 ${error.payload.remainingAttempts} 次尝试。`;
        }
        setAuthFeedback(message, 'error');
    } finally {
        ui.authSubmit.disabled = false;
    }
}

async function clearDetailSession() {
    try {
        await fetchJson('/api/auth/logout', {
            method: 'POST'
        });
    } catch (error) {
        console.warn('Failed to clear detail session:', error);
    }
}

function revokeDetailAccess(message) {
    AppState.detailAccess = false;
    AppState.detailModeEnabled = false;
    AppState.detailsCache.clear();
    updateDetailsButton();
    updateInteractionNote();
    BottomSheet.hideSensitive();

    clearDetailSession().catch(function(error) {
        console.warn('Failed to clear detail session:', error);
    });

    if (message) {
        AppState.pendingPoint = BottomSheet.getCurrentPoint();
        openAuthModal(message);
    }
}

async function fetchRegionDetails(point, forceRefresh) {
    const region = getPointRegion(point);
    if (!region.province) {
        throw new Error('这个地区暂时打不开，请重新点一次。');
    }
    const cacheKey = getRegionKey(region);

    if (!forceRefresh && AppState.detailsCache.has(cacheKey)) {
        return AppState.detailsCache.get(cacheKey);
    }

    const params = new URLSearchParams({ province: region.province });
    if (region.city) {
        params.set('city', region.city);
    }

    const payload = await fetchJson(`/api/map/details?${params.toString()}`);
    AppState.detailsCache.set(cacheKey, payload);
    return payload;
}

async function showDetailSheetForPoint(point, forceRefresh) {
    AppState.detailRequestVersion += 1;
    const requestVersion = AppState.detailRequestVersion;
    BottomSheet.showLoading(point);

    try {
        const payload = await fetchRegionDetails(point, forceRefresh);
        if (requestVersion !== AppState.detailRequestVersion) {
            return;
        }
        BottomSheet.showDetail(point, payload);
    } catch (error) {
        if (requestVersion !== AppState.detailRequestVersion) {
            return;
        }
        if (error && error.status === 401) {
            BottomSheet.showPublic(point, {
                callout: '已退出查看，请重新输入口令。',
                hideHint: true,
                hideEmpty: true
            });
            AppState.pendingPoint = point;
            revokeDetailAccess('已退出查看，请重新输入口令。');
            return;
        }

        console.error('Failed to load region details:', error);
        BottomSheet.showPublic(point, {
            callout: normalizeApiErrorMessage(error, '这个地区暂时打不开，请稍后再试。'),
            hideHint: true,
            hideEmpty: true
        });
    }
}

function doRawDrilldown(point) {
    if (typeof point.doDrilldown === 'function') {
        point.doDrilldown();
        return;
    }

    point._isDrillingDown = true;
    point.firePointEvent('click');
    point._isDrillingDown = false;
}

function drilldownPoint(point) {
    AppState.detailRequestVersion += 1;
    BottomSheet.close();

    if (point.drilldown && point._provinceFile && !ProvinceMapLoader.isLoaded(point._provinceFile)) {
        if (point._provinceLoading) {
            return;
        }
        point._provinceLoading = true;
        showProvinceLoading(point.name);
        ensureProvinceMap(point.name).then(function() {
            point._provinceLoading = false;
            hideMapLoading();
            doRawDrilldown(point);
        }).catch(function(error) {
            point._provinceLoading = false;
            hideMapLoading();
            console.error('Failed to load province map:', error);
            BottomSheet.showPublic(point, {
                callout: '省级地图加载失败，请重试。',
                hideHint: true,
                hideEmpty: true
            });
        });
        return;
    }

    doRawDrilldown(point);
}

function updateDetailsButton() {
    if (!ui.detailsButton) {
        return;
    }

    if (!AppState.detailModeAvailable) {
        ui.detailsButton.hidden = true;
        return;
    }

    ui.detailsButton.hidden = false;
    ui.detailsButton.dataset.active = AppState.detailModeEnabled ? 'true' : 'false';
    ui.detailsButton.textContent = AppState.detailModeEnabled ? '退出查看' : '同学信息';
    ui.detailsButton.setAttribute(
        'aria-label',
        AppState.detailAccess
            ? (AppState.detailModeEnabled ? '退出查看' : '开启查看')
            : '输入口令后开启查看'
    );
}

function updateInteractionNote() {
    if (!ui.note) {
        return;
    }

    if (!AppState.publicData) {
        ui.note.textContent = '地图公开数据加载中...';
        return;
    }

    const stats = AppState.publicData.stats || {};
    const prefix = `当前共覆盖 ${Number(stats.provinces || 0)} 个省级区域、${Number(stats.cities || 0)} 座城市，共 ${Number(stats.total || 0)} 位同学。`;

    if (!AppState.detailModeAvailable) {
        ui.note.textContent = `${prefix} 现在先看看各地人数。`;
        return;
    }

    if (!AppState.detailAccess) {
        ui.note.textContent = `${prefix} 地图上先看人数，输入口令后可查看各地同学信息。`;
        return;
    }

    if (AppState.detailModeEnabled) {
        ui.note.textContent = `${prefix} 现在可以点地区查看同学信息；想继续进入省内地图，请用下方按钮。`;
        return;
    }

    ui.note.textContent = `${prefix} 已确认口令，点击“同学信息”即可查看各地区的同学信息。`;
}

function toggleDetailMode() {
    if (!AppState.detailModeAvailable) {
        return;
    }

    if (!AppState.detailAccess) {
        AppState.pendingPoint = null;
        openAuthModal('输入口令后即可查看同学信息。');
        return;
    }

    if (AppState.detailModeEnabled) {
        // 退出查看 = 结束口令会话：清除 Cookie 与本地缓存，再次查看需重新输入口令。
        AppState.detailModeEnabled = false;
        AppState.detailAccess = false;
        AppState.detailsCache.clear();
        updateDetailsButton();
        updateInteractionNote();
        BottomSheet.hideSensitive();
        clearDetailSession().catch(function(error) {
            console.warn('Failed to clear detail session:', error);
        });
        return;
    }

    AppState.detailModeEnabled = true;
    updateDetailsButton();
    updateInteractionNote();

    const currentPoint = BottomSheet.getCurrentPoint();
    if (BottomSheet.isActive() && currentPoint) {
        showDetailSheetForPoint(currentPoint, false).catch(function(error) {
            console.error('Failed to refresh detail sheet after enabling detail mode:', error);
        });
    }
}

function handlePointClick(event) {
    if (this._isDrillingDown) {
        return true;
    }

    const shouldOpenSheet = isTouchDevice || AppState.detailModeEnabled || !this.drilldown;
    if (!shouldOpenSheet) {
        if (this._provinceFile && !ProvinceMapLoader.isLoaded(this._provinceFile)) {
            if (this._provinceLoading) {
                return false;
            }
            if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
            }
            const point = this;
            point._provinceLoading = true;
            showProvinceLoading(point.name);
            ensureProvinceMap(point.name).then(function() {
                point._provinceLoading = false;
                hideMapLoading();
                doRawDrilldown(point);
            }).catch(function(error) {
                point._provinceLoading = false;
                hideMapLoading();
                console.error('Failed to load province map:', error);
                BottomSheet.showPublic(point, {
                    callout: '省级地图加载失败，请重试。',
                    hideHint: true,
                    hideEmpty: true
                });
            });
            return false;
        }
        return true;
    }

    if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
    }

    if (AppState.detailModeEnabled && AppState.detailAccess) {
        showDetailSheetForPoint(this, false).catch(function(error) {
            console.error('Failed to show detail sheet for point:', error);
        });
        return false;
    }

    BottomSheet.showPublic(this);
    return false;
}

function buildProvinceIndex(dataset) {
    const provinceData = Highcharts.geojson(Highcharts.maps['cn/china']);
    const provinces = {};
    const publicProvinces = (dataset && dataset.provinces) || {};

    Highcharts.each(provinceData, function(point) {
        const provinceSummary = publicProvinces[point.name] || { count: 0, cities: {} };
        point.value = Number(provinceSummary.count || 0);
        point.province = point.name;
        point.city = null;
        point.cityCount = Object.keys(provinceSummary.cities || {}).length;
        point.drilldown = null;
        point._provinceFile = null;
        point._provinceLoading = false;

        provinces[point.name] = {
            name: point.name,
            pointData: point,
            cityCount: point.cityCount,
            cities: {},
            file: null
        };
    });

    Object.keys(provinces).forEach(function(provinceName) {
        const province = provinces[provinceName];
        const filename = province.pointData.properties && province.pointData.properties.filename;
        if (!filename) {
            return;
        }

        province.file = filename;
        province.pointData._provinceFile = filename;
        province.pointData.drilldown = provinceName;

        if (Highcharts.maps[`cn/${filename}`]) {
            buildProvinceSubData(province);
        }
    });

    AppState.provinces = provinces;
    return provinceData;
}

function buildProvinceSubData(province) {
    const provinceName = province.name;
    const filename = province.file;
    if (!filename || !Highcharts.maps[`cn/${filename}`]) {
        return;
    }

    const publicProvince = (AppState.publicData && AppState.publicData.provinces && AppState.publicData.provinces[provinceName]) || {};
    const citySummary = publicProvince.cities || {};
    const subData = Highcharts.geojson(Highcharts.maps[`cn/${filename}`]);
    province.cities = {};
    Highcharts.each(subData, function(cityPoint) {
        cityPoint.value = Number(citySummary[cityPoint.name] || 0);
        cityPoint.province = provinceName;
        cityPoint.city = cityPoint.name;
        province.cities[cityPoint.name] = cityPoint;
    });

    province.subData = subData;
    if (AppState.drilldownSeries && AppState.drilldownSeries[provinceName]) {
        AppState.drilldownSeries[provinceName].data = subData;
    }
}

async function ensureProvinceMap(provinceName) {
    const province = AppState.provinces[provinceName];
    if (!province || !province.file) {
        throw new Error('这个省份暂时打不开，请重新点一次。');
    }
    if (ProvinceMapLoader.isLoaded(province.file)) {
        return;
    }
    await ProvinceMapLoader.load(province.file);
    buildProvinceSubData(province);
    syncDrilldownSeries();
}

function syncDrilldownSeries() {
    if (!AppState.chart || !AppState.chart.options || !AppState.chart.options.drilldown) {
        return;
    }
    const loaded = [];
    Object.keys(AppState.drilldownSeries || {}).forEach(function(provinceName) {
        const province = AppState.provinces[provinceName];
        if (province && province.subData) {
            loaded.push(AppState.drilldownSeries[provinceName]);
        }
    });
    AppState.chart.options.drilldown.series = loaded;
}

function makeDrilldownSeries() {
    const series = [];
    AppState.drilldownSeries = {};

    Object.keys(AppState.provinces).forEach(function(provinceName) {
        const province = AppState.provinces[provinceName];
        if (!province.file) {
            return;
        }

        const seriesOptions = {
            id: province.name,
            name: province.name,
            provinceName: province.name,
            data: province.subData || [],
            borderColor: '#e0d8cc',
            borderWidth: 1,
            states: {
                hover: {
                    borderColor: '#c4704b',
                    borderWidth: 2,
                    brightness: 0.1
                }
            },
            dataLabels: {
                enabled: true,
                format: '{point.name}',
                style: {
                    color: '#5c5650',
                    fontFamily: "'Nunito', sans-serif",
                    fontSize: '11px',
                    fontWeight: '600',
                    textOutline: 'none'
                }
            }
        };

        AppState.drilldownSeries[provinceName] = seriesOptions;
        if (province.subData) {
            series.push(seriesOptions);
        }
    });

    return series;
}

function buildMapOptions(provinceData) {
    return {
        chart: {
            backgroundColor: 'transparent',
            style: {
                fontFamily: "'Nunito', sans-serif"
            },
            events: {
                load: function() {
                    hideMapLoading();
                },
                drilldown: function(e) {
                    if (!e || !e.seriesOptions) {
                        return;
                    }
                    AppState.activeProvince = normalizeRegionToken(e && e.point && e.point.name);
                    BottomSheet.close();
                    this.setTitle(null, { text: e.point.name });
                    fitChartToBounds(this);
                },
                drillup: function() {
                    AppState.activeProvince = null;
                    BottomSheet.close();
                    this.setTitle(null, { text: '中国' });
                    fitChartToBounds(this);
                },
                mouseOut: function() {
                    if (this.tooltip) {
                        this.tooltip.hide(0);
                    }
                }
            }
        },
        title: {
            text: '蹭饭地图',
            style: {
                color: '#2d2a26',
                fontSize: '28px',
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontWeight: '400',
                letterSpacing: '0.05em'
            },
            margin: 20
        },
        subtitle: {
            text: '中国',
            floating: true,
            y: 50,
            style: {
                fontSize: '16px',
                color: '#5c5650',
                fontFamily: "'Nunito', sans-serif"
            }
        },
        plotOptions: {
            series: {
                point: {
                    events: {
                        click: handlePointClick
                    }
                }
            }
        },
        tooltip: {
            enabled: !isTouchDevice,
            useHTML: true,
            backgroundColor: 'transparent',
            borderWidth: 0,
            borderRadius: 0,
            padding: 0,
            shadow: false,
            followPointer: false,
            showDelay: 250,
            hideDelay: 250,
            style: {
                pointerEvents: 'auto'
            },
            formatter: function() {
                return renderPublicCard(this.point, {
                    compact: true
                });
            },
            positioner: function(labelWidth, labelHeight, point) {
                const chart = this.chart;
                const pointX = point.plotX || 0;
                const pointY = point.plotY || 0;
                const offsetX = 3;
                const offsetY = 3;
                let tooltipX = pointX + chart.plotLeft + offsetX;
                let tooltipY = pointY + chart.plotTop + offsetY;

                if (tooltipX + labelWidth > chart.chartWidth - 10) {
                    tooltipX = pointX + chart.plotLeft - labelWidth - offsetX;
                }
                if (tooltipY + labelHeight > chart.chartHeight - 10) {
                    tooltipY = pointY + chart.plotTop - labelHeight - offsetY;
                }
                if (tooltipX < 10) {
                    tooltipX = 10;
                }
                if (tooltipY < 10) {
                    tooltipY = pointY + chart.plotTop + offsetY;
                }

                return {
                    x: tooltipX,
                    y: tooltipY
                };
            }
        },
        colorAxis: {
            min: 0,
            max: 15,
            type: 'linear',
            minColor: '#f5efe6',
            maxColor: '#a85a3a',
            stops: [
                [0, '#f5efe6'],
                [0.167, '#e8c4a8'],
                [0.333, '#d9a87c'],
                [0.5, '#c4704b'],
                [0.75, '#b56540'],
                [1, '#a85a3a']
            ]
        },
        legend: {
            enabled: true,
            layout: 'horizontal',
            align: 'center',
            verticalAlign: 'bottom',
            itemStyle: {
                color: '#5c5650',
                fontFamily: "'Nunito', sans-serif",
                fontSize: '12px'
            }
        },
        series: [{
            data: provinceData,
            name: '各省人数',
            joinBy: 'name',
            borderColor: '#e0d8cc',
            borderWidth: 1,
            states: {
                hover: {
                    borderColor: '#c4704b',
                    borderWidth: 2,
                    brightness: 0.1
                }
            },
            tooltip: {
                pointFormat: '{point.name}: {point.value}'
            }
        }],
        drilldown: {
            activeDataLabelStyle: {
                color: '#2d2a26',
                textDecoration: 'none',
                textShadow: 'none',
                fontFamily: "'Nunito', sans-serif",
                fontWeight: '600'
            },
            drillUpButton: {
                relativeTo: 'spacingBox',
                position: {
                    x: 0,
                    y: 60
                },
                theme: {
                    fill: '#faf7f2',
                    'stroke-width': 1,
                    stroke: '#c4704b',
                    r: 6,
                    style: {
                        color: '#2d2a26',
                        fontFamily: "'Nunito', sans-serif",
                        fontWeight: '600'
                    },
                    states: {
                        hover: {
                            fill: '#c4704b',
                            style: {
                                color: '#ffffff'
                            }
                        }
                    }
                }
            },
            series: makeDrilldownSeries()
        },
        mapNavigation: {
            enabled: true,
            buttonOptions: {
                verticalAlign: 'bottom',
                theme: {
                    fill: '#faf7f2',
                    'stroke-width': 1,
                    stroke: '#e0d8cc',
                    r: 6,
                    style: {
                        color: '#5c5650'
                    },
                    states: {
                        hover: {
                            fill: '#e8a87c',
                            style: {
                                color: '#2d2a26'
                            }
                        }
                    }
                }
            }
        },
        credits: {
            enabled: false
        }
    };
}

function initMap(provinceData) {
    AppState.chart = new Highcharts.Map('map', buildMapOptions(provinceData));
    syncDrilldownSeries();
}

function renderMapFromData(publicData) {
    const provinceData = buildProvinceIndex(publicData);
    initMap(provinceData);
    updateDetailsButton();
    updateInteractionNote();
    hideMapLoading();
}

function refreshChartFromData(publicData) {
    const provinceData = buildProvinceIndex(publicData);
    const chart = AppState.chart;
    if (chart && chart.series && chart.series[0]) {
        chart.series[0].setData(provinceData, true, true);
    }
    syncDrilldownSeries();
    updateDetailsButton();
    updateInteractionNote();
}

async function loadApp() {
    const cached = readPublicCache();
    let renderedFromCache = false;

    if (cached) {
        try {
            applyPublicData(cached);
            renderMapFromData(cached);
            renderedFromCache = true;
        } catch (error) {
            console.warn('Failed to render cached map data:', error);
        }
    }

    try {
        const fresh = await fetchJson('/api/map/public');
        writePublicCache(fresh);
        if (renderedFromCache) {
            const cacheIsStale = !cached || cached.generatedAt !== fresh.generatedAt;
            applyPublicData(fresh);
            if (cacheIsStale) {
                refreshChartFromData(fresh);
            } else {
                updateDetailsButton();
                updateInteractionNote();
            }
        } else {
            applyPublicData(fresh);
            renderMapFromData(fresh);
        }
    } catch (error) {
        if (renderedFromCache) {
            console.warn('Failed to refresh public map data:', error);
            return;
        }
        console.error('Failed to initialize map application:', error);
        showFatalError(normalizeApiErrorMessage(error, '无法加载地图数据，请稍后重试。'));
    }
}

function setupStaticUi() {
    updateDetailsButton();
    updateInteractionNote();

    if (ui.detailsButton) {
        ui.detailsButton.addEventListener('click', toggleDetailMode);
    }

    if (ui.authForm) {
        ui.authForm.addEventListener('submit', function(event) {
            handleAuthSubmit(event).catch(function(error) {
                console.error('Auth submit failed:', error);
                setAuthFeedback('暂时无法确认口令，请稍后再试。', 'error');
            });
        });
    }

    if (ui.authClose) {
        ui.authClose.addEventListener('click', closeAuthModal);
    }

    if (ui.authOverlay) {
        ui.authOverlay.addEventListener('click', function(event) {
            if (event.target === ui.authOverlay) {
                closeAuthModal();
            }
        });
    }

    document.addEventListener('keydown', function(event) {
        if (event.key !== 'Escape') {
            return;
        }

        if (ui.authOverlay && !ui.authOverlay.hidden) {
            closeAuthModal();
            return;
        }

        if (BottomSheet.isActive()) {
            BottomSheet.close();
        }
    });
}

const ShareManager = (function() {
    function calculateStats() {
        const stats = (AppState.publicData && AppState.publicData.stats) || {};
        return {
            total: Number(stats.total || 0),
            provinces: Number(stats.provinces || 0),
            cities: Number(stats.cities || 0)
        };
    }

    function svgToImage(svgString) {
        return new Promise(function(resolve, reject) {
            const img = new Image();
            const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);

            img.onload = function() {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = function(error) {
                URL.revokeObjectURL(url);
                reject(error);
            };
            img.src = url;
        });
    }

    function roundRect(ctx, x, y, width, height, radius, fill, stroke, corners) {
        const cornerValues = corners || [radius, radius, radius, radius];
        const tl = cornerValues[0];
        const tr = cornerValues[1];
        const br = cornerValues[2];
        const bl = cornerValues[3];

        ctx.beginPath();
        ctx.moveTo(x + tl, y);
        ctx.lineTo(x + width - tr, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + tr);
        ctx.lineTo(x + width, y + height - br);
        ctx.quadraticCurveTo(x + width, y + height, x + width - br, y + height);
        ctx.lineTo(x + bl, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - bl);
        ctx.lineTo(x, y + tl);
        ctx.quadraticCurveTo(x, y, x + tl, y);
        ctx.closePath();

        if (fill) {
            ctx.fill();
        }
        if (stroke) {
            ctx.stroke();
        }
    }

    async function generateImage() {
        const chart = AppState.chart || Highcharts.charts[0];
        if (!chart) {
            throw new Error('地图尚未加载完成');
        }

        const stats = calculateStats();
        const svg = chart.getSVG({
            chart: {
                width: 1200,
                height: 800,
                backgroundColor: '#f5efe6'
            }
        });
        const mapImg = await svgToImage(svg);

        const canvas = document.createElement('canvas');
        canvas.width = 1200;
        canvas.height = 1100;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#faf7f2';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const gradient = ctx.createLinearGradient(0, 0, canvas.width, 150);
        gradient.addColorStop(0, '#e8a87c');
        gradient.addColorStop(1, '#c4704b');
        ctx.fillStyle = gradient;
        roundRect(ctx, 0, 0, canvas.width, 150, 24, true, false);

        ctx.fillStyle = '#ffffff';
        ctx.font = '42px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('金鹰1班蹭饭地图', canvas.width / 2, 55);

        ctx.font = '18px Arial, sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fillText('探索各地同学的足迹', canvas.width / 2, 105);

        ctx.drawImage(mapImg, 0, 150, 1200, 800);

        ctx.fillStyle = '#fffaf5';
        ctx.fillRect(0, 950, canvas.width, 100);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.fillStyle = '#c4704b';
        ctx.font = 'bold 36px Arial, sans-serif';
        ctx.fillText(String(stats.total), 200, 990);
        ctx.fillStyle = '#5c5650';
        ctx.font = '16px Arial, sans-serif';
        ctx.fillText('总人数', 200, 1020);

        ctx.fillStyle = '#c4704b';
        ctx.font = 'bold 36px Arial, sans-serif';
        ctx.fillText(String(stats.provinces), 600, 990);
        ctx.fillStyle = '#5c5650';
        ctx.font = '16px Arial, sans-serif';
        ctx.fillText('覆盖省份', 600, 1020);

        ctx.fillStyle = '#c4704b';
        ctx.font = 'bold 36px Arial, sans-serif';
        ctx.fillText(String(stats.cities), 1000, 990);
        ctx.fillStyle = '#5c5650';
        ctx.font = '16px Arial, sans-serif';
        ctx.fillText('覆盖城市', 1000, 1020);

        ctx.fillStyle = '#f5efe6';
        roundRect(ctx, 0, 1050, canvas.width, 50, 0, true, false, [0, 0, 24, 24]);

        ctx.fillStyle = '#5c5650';
        ctx.font = '14px Arial, sans-serif';
        ctx.fillText('万州二中 · 金鹰1班', canvas.width / 2, 1075);

        return new Promise(function(resolve, reject) {
            canvas.toBlob(function(blob) {
                if (blob) {
                    resolve(blob);
                    return;
                }
                reject(new Error('生成图片失败'));
            }, 'image/png', 0.95);
        });
    }

    function downloadImage(blob, filename) {
        const finalName = filename || `蹭饭地图_${new Date().toISOString().slice(0, 10)}.png`;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = finalName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    async function shareToSocial(blob) {
        downloadImage(blob);
        return true;
    }

    async function handleShare() {
        const button = document.getElementById('share-btn');
        if (!button) {
            return;
        }

        button.classList.add('loading');
        button.disabled = true;

        try {
            const blob = await generateImage();
            await shareToSocial(blob);
        } catch (error) {
            console.error('生成分享图片失败:', error);
            alert('生成分享图片失败，请稍后重试');
        } finally {
            button.classList.remove('loading');
            button.disabled = false;
        }
    }

    function init() {
        const button = document.getElementById('share-btn');
        if (button) {
            button.addEventListener('click', function() {
                handleShare().catch(function(error) {
                    console.error('Share action failed:', error);
                });
            });
        }
    }

    return {
        init,
        generateImage,
        downloadImage,
        shareToSocial
    };
})();

setupStaticUi();
BottomSheet.init();
ShareManager.init();
loadApp();





