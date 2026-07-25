class WechatPageStateDetector {
    detect(captureResult = {}, options = {}) {
        const rows = this.normalizeRows(captureResult.ocrRows || []);
        const targetCity = String(options.targetCity || '').trim();
        const stationSearchHeaderRows = rows.filter(row => this.matchesAny(row.text, [
            /搜索场站/
        ]));
        const stationRows = rows.filter(row => this.isStationTitle(row.text, options.platform));
        const stationTargetRows = stationRows.length > 0
            ? stationRows
            : rows.filter(row => this.isStationCardCandidate(row, options.platform));
        const homeRows = rows.filter(row => this.matchesAny(row.text, [
            /常用/,
            /附近/,
            /地图/,
            /停车减免/,
            /可用充电余额/,
            /即插即充/,
            /超充/,
            /筛选/,
            /扫码充电/,
            /首页/
        ]));
        const listControlRows = rows.filter(row => this.matchesAny(row.text, [
            /列表/,
            /综合排序/,
            /智能推荐/,
            /距离最近/,
            /最近使用/,
            /全部场站/,
            /全部公桩/,
            /充电速度/,
            /快慢充/,
            /MIP站/,
            /筛选/,
            /快充/,
            /超充/,
            /慢充/,
            /停车费/,
            /停车减免/
        ]));
        const searchRows = rows.filter(row => this.matchesAny(row.text, [
            /搜索城市/,
            /输入城市/,
            /请输入.*城市/,
            /城市中文名/,
            /城市名/,
            /选择城市/,
            /切换城市/,
            /当前城市/,
            /热门城市/,
            /城市列表/,
            /历史搜索/
        ]));
        const detailRows = rows.filter(row => this.matchesAny(row.text, [
            /场站详情/,
            /场站环境/,
            /位置概览/,
            /扫码充电/,
            /导航/,
            /单站权益/,
            /停车减免/,
            /停车/,
            /服务费/,
            /距离您/,
            /收藏享单站权益/,
            /可用优惠券/
        ]));
        const locationRows = rows.filter(row => this.matchesAny(row.text, [
            /定位权限未开启/,
            /默认定位到/,
            /去授权/,
            /开启定位/,
            /授权定位/,
            /当前位置/,
            /定位服务/
        ]));
        const humanVerificationRows = rows.filter(row => this.matchesAny(row.text, [
            /拖动.*滑块/,
            /滑块.*验证/,
            /完成拼图/,
            /向右滑动/,
            /拼图/,
            /安全验证/
        ]));
        const loginRows = rows.filter(row => this.matchesAny(row.text, [
            /登录/,
            /注册/,
            /手机号/,
            /验证码/,
            /服务协议/,
            /用户协议/,
            /个人信息/,
            /隐私/
        ]));
        const emptySearchRows = rows.filter(row => this.matchesAny(row.text, [
            /不太明白/,
            /换个描述/,
            /没有.*结果/,
            /没有.*搜索/,
            /未找到/
        ]));
        const networkRows = rows.filter(row => this.matchesAny(row.text, [
            /信号.*不好/,
            /刷新试试/,
            /网络.*异常/,
            /网络.*错误/,
            /加载失败/,
            /重新加载/,
            /^刷新$/,
            /^重试$/
        ]));
        const marketingRows = rows.filter(row => this.matchesAny(row.text, [
            /优惠/,
            /活动/,
            /福利/,
            /红包/,
            /券/,
            /领券/,
            /好券/,
            /抽奖/,
            /签到/,
            /充值/,
            /权益/,
            /开通会员/,
            /立即领取/,
            /立即参与/,
            /去看看/,
            /去完成/,
            /广告/
        ]));
        const priceExplainRows = rows.filter(row => this.matchesAny(row.text, [
            /价格说明/,
            /滴滴站点价/,
            /跨时段计费/,
            /^电费$/,
            /^服务费$/
        ]));
        const searchFieldTarget = this.pickSearchField(rows);
        const closeTarget = this.pickTarget(rows, row => this.matchesAny(row.text, [
            /关闭/,
            /跳过/,
            /暂不/,
            /暂不.*登录/,
            /暂不.*授权/,
            /不登录/,
            /跳过登录/,
            /先逛逛/,
            /以后再说/,
            /稍后再说/,
            /拒绝/,
            /知道了/,
            /我知道了/,
            /取消/,
            /否/,
            /^×$/,
            /^x$/i
        ]));
        const searchActionTarget = this.pickTarget(rows, row => this.matchesAny(row.text, [
            /^搜索$/,
            /搜索$/
        ]) && row.x > 0.72 && row.y > 0.78);
        const backTarget = this.pickTarget(rows, row => this.matchesAny(row.text, [
            /^<$/,
            /^‹$/,
            /^返回$/,
            /返回/,
            /返回首页/,
            /返回上一页/
        ]));
        const refreshTarget = this.pickTarget(rows, row => this.matchesAny(row.text, [
            /^刷新$/,
            /^重试$/,
            /重新加载/,
            /刷新试试/
        ]));
        const searchTarget = this.pickTarget(searchRows);
        const searchTrigger = this.pickTarget(rows, row =>
            this.isTopSearchTriggerCandidate(row)
        );
        const cityOption = this.isLikelyCityName(targetCity) ? this.pickCityOption(rows, targetCity) : null;
        const cityEntry = this.pickTarget(rows, row => this.isCityEntryCandidate(row, targetCity));
        const citySelector = this.pickTarget(rows, row => this.isSearchPageCitySelector(row));
        const stationOption = targetCity
            ? this.pickTarget(rows, row => this.isStationSearchResultCandidate(row, targetCity))
            : null;
        const nearbySearchAction = stationOption
            ? this.pickSiblingTarget(rows, stationOption, row =>
                this.matchesAny(row.text, [/查找附近场站/]) && row.x > 0.65
            )
            : null;
        const listButton = this.pickTarget(rows, row => /^列表$/.test(String(row.text || '').trim()));
        const mapButton = this.pickTarget(rows, row => this.matchesAny(row.text, [
            /地图/
        ]) && row.x < 0.28 && row.y > 0.55);
        const enableLocationButton = this.pickTarget(rows, row => this.matchesAny(row.text, [
            /^开启定位$/,
            /开启定位/
        ]));

        let state = 'unknown';
        let label = '未知页面';

        const mapLabelRows = rows.filter(row => this.isMapAdministrativeText(row.text));
        const isMapView = stationRows.length === 0
            && mapLabelRows.length >= 6
            && rows.some(row => this.matchesAny(row.text, [/目的地/, /渤海/, /东海/, /南海/]));
        const isListPage = !isMapView && (listControlRows.length >= 3 || stationRows.length > 0);
        const isLoginPrompt = !isListPage && (
            loginRows.length >= 2
            || (loginRows.length >= 1 && closeTarget)
            || (loginRows.length >= 1 && stationRows.length === 0 && listControlRows.length < 2 && homeRows.length < 2)
        );
        const isMarketingPage = (
            marketingRows.length > 0 && (closeTarget || backTarget)
        ) || (
            marketingRows.length >= 2 && stationRows.length === 0 && listControlRows.length < 2
        );

        const isMediaDetailPage = rows.some(row => this.matchesAny(row.text, [/场站环境/]))
            && rows.some(row => this.matchesAny(row.text, [/位置概览/]));

        const isDetailPage = isMediaDetailPage || this.isDetailPage(detailRows, rows);

        if (priceExplainRows.length >= 2 && closeTarget) {
            state = 'popup';
            label = '价格说明弹窗';
        } else if (humanVerificationRows.length > 0) {
            state = 'human-verification';
            label = '安全验证页';
        } else if (isDetailPage) {
            state = 'station-detail';
            label = '场站详情页';
        } else if (isMapView) {
            state = 'map-view';
            label = '地图页';
        } else if (isListPage) {
            state = 'station-list';
            label = '场站列表页';
        } else if (isLoginPrompt) {
            state = 'login-prompt';
            label = '登录弹窗页';
        } else if (emptySearchRows.length > 0) {
            state = 'empty-search';
            label = '搜索无结果页';
        } else if (networkRows.length > 0 && stationRows.length === 0 && listControlRows.length < 2) {
            state = 'network-error';
            label = '网络异常页';
        } else if (stationSearchHeaderRows.length > 0) {
            state = 'station-search';
            label = '场站搜索页';
        } else if (searchRows.length > 0 || (cityOption && stationRows.length === 0 && listControlRows.length < 2)) {
            state = 'city-search';
            label = '城市搜索页';
        } else if (locationRows.length > 0 && stationRows.length === 0 && listControlRows.length < 2) {
            state = 'popup';
            label = '定位授权弹窗';
        } else if (locationRows.length > 0 && homeRows.length >= 4 && stationRows.length === 0) {
            state = 'location-home';
            label = '定位首页';
        } else if (isMarketingPage) {
            state = 'marketing';
            label = '营销活动页';
        } else if (closeTarget) {
            state = 'popup';
            label = '弹窗页';
        }

        return {
            state,
            label,
            stationCount: stationTargetRows.length,
            detailCount: detailRows.length,
            listControlCount: listControlRows.length,
            searchCount: searchRows.length,
            stationSearchCount: stationSearchHeaderRows.length,
            marketingCount: marketingRows.length,
            loginCount: loginRows.length,
            humanVerificationCount: humanVerificationRows.length,
            emptySearchCount: emptySearchRows.length,
            networkErrorCount: networkRows.length,
            locationPrompt: locationRows.length > 0
                ? {
                    enabled: true,
                    text: locationRows.map(row => row.text).join(' | ')
                }
                : null,
            targets: {
                close: this.toTarget(closeTarget, 'close'),
                back: this.toTarget(backTarget, 'back'),
                refresh: this.toTarget(refreshTarget, 'refresh'),
                searchBox: this.toTarget(searchTarget, 'search'),
                searchInput: this.toTarget(searchFieldTarget, 'search-input'),
                searchAction: this.toTarget(searchActionTarget, 'search-action'),
                searchTrigger: this.toTarget(searchTrigger, 'search-trigger'),
                cityOption: this.toTarget(cityOption, 'city-option'),
                cityEntry: this.toTarget(cityEntry, 'city-entry'),
                citySelector: this.toTarget(citySelector, 'city-selector'),
                stationOption: this.toTarget(stationOption, 'station-option'),
                nearbySearchAction: this.toTarget(nearbySearchAction, 'nearby-search-action'),
                listButton: this.toTarget(listButton, 'list-button'),
                mapButton: this.toTarget(mapButton, 'map-button'),
                enableLocationButton: this.toTarget(enableLocationButton, 'enable-location'),
                firstStation: this.toTarget(this.pickTarget(stationTargetRows), 'first-station'),
                locationAuthorize: this.toTarget(
                    this.pickTarget(rows, row => this.matchesAny(row.text, [/去授权/, /开启定位/])),
                    'location-authorize'
                )
            }
        };
    }

    normalizeRows(rows = []) {
        if (!Array.isArray(rows)) {
            return [];
        }

        return rows
            .map(row => ({
                text: String(row.text || '').trim(),
                confidence: Number(row.confidence || 0),
                x: Number(row.boundingBox?.x ?? row.x ?? 0),
                y: Number(row.boundingBox?.y ?? row.y ?? 0),
                width: Number(row.boundingBox?.width ?? row.width ?? 0),
                height: Number(row.boundingBox?.height ?? row.height ?? 0)
            }))
            .filter(row => row.text);
    }

    normalizeText(value) {
        return String(value || '')
            .trim()
            .replace(/\s+/g, '')
            .toLowerCase();
    }

    matchesAny(text, patterns = []) {
        return patterns.some(pattern => pattern.test(String(text || '')));
    }

    isStationTitle(text, platform) {
        const compact = this.normalizeText(text);
        if (!compact || compact.length < 4 || compact.length > 40) {
            return false;
        }

        if (platform === 'tuanyou') {
            return /(加油站|油站)/.test(compact) && !/(评价|详情|导航|筛选|油号)/.test(compact);
        }

        return (
            /(充电站|充电中心|充电广场|充电桩|超充站|快充站|极充站|电站)/.test(compact)
            || /(?:小桔|开迈斯|特来电|星星充电|云快充|新电途|广汽|BMW|奥迪|蔚来).*站/i.test(compact)
        ) && !/(附近充电站|评价|详情|筛选|营销|授权|搜索)/.test(compact);
    }

    isDetailPage(detailRows = [], rows = []) {
        const strongDetailRows = rows.filter(row => this.matchesAny(row.text, [
            /扫码充电/,
            /导航/,
            /单站权益/,
            /收藏享单站权益/,
            /可用优惠券/,
            /服务费/,
            /距离您/
        ]));

        if (strongDetailRows.length >= 2) {
            return true;
        }

        return rows.some(row => this.matchesAny(row.text, [/扫码充电/, /单站权益/, /收藏享单站权益/, /可用优惠券/]))
            && rows.some(row => this.matchesAny(row.text, [/导航/, /距离您/, /服务费/]));
    }

    isStationCardCandidate(row, platform) {
        const text = String(row?.text || '').trim();
        if (!text) {
            return false;
        }

        if (!(row.x >= 0.08 && row.x <= 0.72 && row.y >= 0.15 && row.y <= 0.78)) {
            return false;
        }

        if (this.isControlText(text) || this.looksLikePriceOrCount(text)) {
            return false;
        }
        if (this.isMapAdministrativeText(text)) {
            return false;
        }

        const compact = this.normalizeText(text);
        if (compact.length < 3 || compact.length > 24) {
            return false;
        }

        if (platform === 'tuanyou') {
            return /[\u4e00-\u9fa5]{3,}/.test(text);
        }

        return /[\u4e00-\u9fa5]{3,}/.test(text);
    }

    isMapAdministrativeText(text) {
        const compact = this.normalizeText(text);
        if (!compact) return false;
        return this.matchesAny(compact, [
            /^(北京市|上海市|天津市|重庆市)$/,
            /^(内蒙古|广西|宁夏|新疆|西藏)?[\u4e00-\u9fa5]{1,8}(省|自治区|特别行政区)$/,
            /^(河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾)省$/,
            /^(渤海|东海|南海|黄海)$/,
            /^目的地$/
        ]);
    }

    isControlText(text) {
        return this.matchesAny(text, [
            /列表/,
            /综合排序/,
            /低价优先/,
            /距离最近/,
            /全部场站/,
            /充电速度/,
            /筛选/,
            /快充/,
            /慢充/,
            /超充/,
            /停车减免/,
            /可用充电余额/,
            /即插即充/,
            /定位/,
            /去授权/,
            /开启定位/,
            /首页/,
            /我的/,
            /附近/,
            /地图/,
            /服务费/,
            /权益/,
            /收藏/,
            /好站/,
            /导航/,
            /会员/,
            /休息室/,
            /搜索/,
            /领取/,
            /领券/,
            /好券/,
            /红包/,
            /活动/,
            /广告/,
            /淘宝/,
            /登录/,
            /注册/,
            /授权/,
            /拼图/,
            /滑块/,
            /信号.*不好/,
            /刷新试试/,
            /网络.*异常/,
            /网络.*错误/,
            /加载失败/,
            /^刷新$/,
            /^重试$/
        ]);
    }

    looksLikePriceOrCount(text) {
        return this.matchesAny(text, [
            /[¥￥]\d+(?:\.\d{1,4})?/,
            /(快|慢|超|闲)\s*\d+\s*\/\s*\d+/,
            /\d+\s*(m|km|分钟|小时)/,
            /停车减免/,
            /刚刚有人充过/,
            /\d+分钟前有人充过/,
            /近期最大\d+kW/i
        ]);
    }

    isCityEntryCandidate(row, targetCity) {
        const text = String(row?.text || '').trim();
        if (!text) {
            return false;
        }

        if (/^附近$/.test(text) && row.y > 0.8 && row.x < 0.18) {
            return true;
        }

        // 允许两种位置：搜索页底部(y>0.7) 或搜索页顶部城市名(y<0.3)
        const isBottomEntry = row.y > 0.7 && row.x < 0.4;
        const isTopCityName = row.y < 0.3 && row.x < 0.4 && /市[、，,.]?$/.test(text);
        if (!isBottomEntry && !isTopCityName) {
            return false;
        }

        if (this.matchesAny(text, [
            /附近/,
            /筛选/,
            /推荐/,
            /地图/,
            /首页/,
            /我的/,
            /消息/,
            /订单/,
            /权益/,
            /停车/,
            /减免/,
            /优惠/,
            /服务费/,
            /扫码/,
            /导航/,
            /会员/,
            /红包/
        ])) {
            return false;
        }

        if (this.matchesAny(text, [/切换城市/, /选择城市/, /当前城市/, /定位城市/, /城市/])) {
            return true;
        }

        const normalizedTargetCity = this.normalizeCity(targetCity);
        const normalizedText = this.normalizeCity(text);
        if (normalizedTargetCity && normalizedText && normalizedTargetCity === normalizedText) {
            return true;
        }

        return /^[\u4e00-\u9fa5]{2,6}市$/.test(text);
    }

    isTopSearchTriggerCandidate(row) {
        const text = String(row?.text || '').trim();
        return row.y > 0.82
            && row.x > 0.16
            && row.x < 0.82
            && row.width > 0.14
            && this.matchesAny(text, [
                /搜索/,
                /请输入/,
                /输入/,
                /查找/,
                /场站/,
                /充电站/
            ])
            && !this.matchesAny(row.text, [
                /场站详情/,
                /收藏/,
                /好站/,
                /领券/,
                /好券/,
                /优惠/,
                /活动/,
                /福利/,
                /权益/,
                /广告/,
                /列表/,
                /首页/,
                /我的/,
                /筛选/,
                /全部场站/,
                /综合排序/,
                /充电速度/,
                /去授权/,
                /开启定位/,
                /地图/
            ]);
    }

    pickSearchField(rows) {
        return this.pickTarget(rows, row => {
            const text = String(row.text || '').trim();
            if (!text) {
                return false;
            }

            if (this.isControlText(text) || this.looksLikePriceOrCount(text)) {
                return false;
            }

            const inTopSearchBar = row.y > 0.82 && row.x > 0.16 && row.x < 0.82;
            const inHomeSearchBar = row.y > 0.56 && row.y < 0.72 && row.x > 0.18 && row.x < 0.82;
            const looksLikeSearchHint = this.matchesAny(text, [
                /搜索/,
                /请输入/,
                /输入/,
                /查找/,
                /场站/,
                /城市/
            ]);
            const hasReadableContent = /[\u4e00-\u9fa5a-z0-9]/i.test(text);
            return hasReadableContent && row.width > 0.08 && (inTopSearchBar || (inHomeSearchBar && looksLikeSearchHint));
        });
    }

    isSearchPageCitySelector(row) {
        const isCityNamePattern = this.matchesAny(row.text, [
            /市/,
            /当前城市/,
            /定位城市/
        ]);
        if (!isCityNamePattern) return false;
        // 搜索页底部城市选择器（y > 0.82）
        if (row.x < 0.26 && row.y > 0.82) return true;
        // 搜索页顶部城市名如"杭州市、"（y < 0.3，x < 0.4），可点击切换城市
        if (row.x < 0.4 && row.y < 0.3 && /市[、，,.]?$/.test(row.text)) return true;
        return false;
    }

    isStationSearchResultCandidate(row, targetText) {
        const text = String(row?.text || '').trim();
        if (!text || !targetText) {
            return false;
        }

        if (row.x > 0.56 || row.y > 0.84 || row.y < 0.18) {
            return false;
        }

        const normalizedText = this.normalizeText(text);
        const normalizedTarget = this.normalizeText(targetText);
        if (!normalizedText || !normalizedTarget) {
            return false;
        }

        return normalizedText === normalizedTarget
            || normalizedText.includes(normalizedTarget)
            || normalizedTarget.includes(normalizedText);
    }

    pickSiblingTarget(rows, anchorRow, predicate) {
        if (!anchorRow) {
            return null;
        }

        return rows
            .filter(row => predicate(row) && Math.abs(row.y - anchorRow.y) < 0.045)
            .sort((left, right) => Math.abs(left.y - anchorRow.y) - Math.abs(right.y - anchorRow.y))[0] || null;
    }

    pickTarget(rows, predicate = null) {
        const candidates = (predicate ? rows.filter(predicate) : rows)
            .sort((left, right) => {
                if (Math.abs(right.y - left.y) > 0.02) {
                    return right.y - left.y;
                }
                return left.x - right.x;
            });

        return candidates[0] || null;
    }

    pickCityOption(rows, targetCity) {
        const normalizedTarget = this.normalizeCity(targetCity);
        if (!normalizedTarget) {
            return null;
        }

        const candidates = rows.filter(row => {
            if (row.y > 0.82 && row.x > 0.2) {
                return false;
            }
            if (this.matchesAny(row.text, [/请输入/, /搜索/, /城市中文名/, /拼音/])) {
                return false;
            }
            return this.normalizeCity(row.text).includes(normalizedTarget);
        });

        const exact = candidates.find(row => this.normalizeCity(row.text) === normalizedTarget);
        if (exact) {
            return exact;
        }

        return candidates[0] || null;
    }

    normalizeCity(value) {
        return this.normalizeText(value).replace(/省|市|自治区|特别行政区/g, '');
    }

    isLikelyCityName(value) {
        const text = String(value || '').trim();
        if (!text) {
            return false;
        }

        if (/(站|机场|航站楼|停车场|枢纽|广场|中心|园区|大厦|酒店|商场|时代|医院|写字楼)/.test(text)) {
            return false;
        }

        return /^[\u4e00-\u9fa5]{2,6}(市|区|县|自治州|特别行政区)?$/.test(text);
    }

    toTarget(row, label) {
        if (!row) {
            return null;
        }

        return {
            label,
            text: row.text,
            x: row.x,
            y: row.y,
            width: row.width,
            height: row.height,
            confidence: row.confidence
        };
    }
}

module.exports = WechatPageStateDetector;
