#!/usr/bin/env node
/**
 * 从wxapkg反编译代码中提取wsgsig签名函数
 * 策略：合并主包(APPAPPAPP)和wsgsig子包的webpack模块，建立完整运行时
 */
const fs = require('fs');
const path = require('path');

const APP_SERVICE = path.join(__dirname, '../data/wxapkg/decompiled/wxaf35009675aa0b2a/APPAPPAPP/app-service.js');
const WSGSIG_SERVICE = path.join(__dirname, '../data/wxapkg/decompiled/wxaf35009675aa0b2a/_wsgsig_/wsgsig/app-service.js');
const OUTPUT = path.join(__dirname, '../backend/services/wsgsig-signer.js');

function extractModules(code) {
    const modules = {};
    const re = /(\d+):function\(e,a,n\)\{/g;
    let m;
    while (m = re.exec(code)) {
        const moduleId = parseInt(m[1]);
        const startPos = m.index + m[0].length;
        let depth = 1;
        let pos = startPos;
        while (depth > 0 && pos < code.length) {
            if (code[pos] === '{') depth++;
            if (code[pos] === '}') depth--;
            if (code[pos] === '"' || code[pos] === "'") {
                // 跳过字符串
                const quote = code[pos];
                pos++;
                while (pos < code.length && code[pos] !== quote) {
                    if (code[pos] === '\\') pos++;
                    pos++;
                }
            }
            pos++;
        }
        modules[moduleId] = code.substring(m.index, pos);
    }
    return modules;
}

function main() {
    console.log('Loading main package...');
    const appCode = fs.readFileSync(APP_SERVICE, 'utf8');
    const appModules = extractModules(appCode);
    console.log('Main package modules:', Object.keys(appModules).length);
    
    console.log('Loading wsgsig package...');
    const wsgsigCode = fs.readFileSync(WSGSIG_SERVICE, 'utf8');
    const wsgsigModules = extractModules(wsgsigCode);
    console.log('wsgsig package modules:', Object.keys(wsgsigModules).length);
    
    // 合并模块（wsgsig的覆盖主包的）
    const allModules = { ...appModules, ...wsgsigModules };
    console.log('Total merged modules:', Object.keys(allModules).length);
    
    // 确认关键模块存在
    const requiredIds = [2582, 2599, 554, 546, 538, 550, 526, 536, 528, 520, 522, 230, 232, 534, 540, 542, 544, 558, 560, 532, 568, 562, 574, 575, 600];
    for (const id of requiredIds) {
        if (!allModules[id]) {
            console.warn('Missing module:', id);
        }
    }
    
    // 创建webpack运行时
    const moduleCache = {};
    function webpackRequire(id) {
        if (moduleCache[id]) return moduleCache[id].exports;
        const mod = { exports: {} };
        moduleCache[id] = mod;
        
        if (!allModules[id]) {
            // 模块不存在，返回空对象
            mod.exports = function(){};
            return mod.exports;
        }
        
        try {
            // 提取模块函数体
            const def = allModules[id];
            const fnStart = def.indexOf('function(e,a,n)');
            const bodyStart = def.indexOf('{', fnStart) + 1;
            const bodyEnd = def.lastIndexOf('}');
            const body = def.substring(bodyStart, bodyEnd);
            
            const fn = new Function('e', 'a', 'n', body);
            const nFunc = function(reqId) { return webpackRequire(reqId); };
            nFunc.n = function(m) { return m && m.__esModule ? m : { default: m }; };
            nFunc.r = function(exports) { Object.defineProperty(exports, '__esModule', { value: true }); };
            nFunc.d = function(exports, definition) {
                for (const key in definition) {
                    if (!exports.hasOwnProperty(key)) {
                        Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
                    }
                }
            };
            nFunc.hmd = function(e) { return e; };
            nFunc.o = function(a, b) { return Object.prototype.hasOwnProperty.call(a, b); };
            nFunc.t = function(e) { return e; };
            
            fn(mod, mod.exports, nFunc);
        } catch (err) {
            console.error(`Module ${id} error:`, err.message?.substring(0, 150));
        }
        
        return mod.exports;
    }
    
    // 运行签名模块
    console.log('\nLoading module 2582 (wsgsig)...');
    const signerExports = webpackRequire(2582);
    console.log('Module 2582 exports:', Object.keys(signerExports));
    
    if (signerExports.getSign) {
        console.log('✓ getSign function available');
    }
    if (signerExports.initSign) {
        console.log('✓ initSign function available');
    }
    
    // 测试签名
    if (signerExports.initSign && signerExports.getSign) {
        try {
            signerExports.initSign({
                appId: 'wx06cb940499986937',
                appKey: 'test_key_placeholder',
                version: '02'
            });
            console.log('✓ initSign called successfully');
        } catch (err) {
            console.error('initSign error:', err.message?.substring(0, 200));
        }
        
        try {
            const sign = signerExports.getSign({
                url: 'https://energy.xiaojukeji.com/station-api/homepage/stationList',
                method: 'POST',
                data: { lat: 30.5, lng: 114.3, pageNo: 1, pageSize: 10 }
            });
            console.log('Generated sign:', sign);
            console.log('Sign prefix:', sign?.substring(0, 5));
            console.log('Sign length:', sign?.length);
        } catch (err) {
            console.error('getSign error:', err.message?.substring(0, 300));
        }
    }
}

main();
