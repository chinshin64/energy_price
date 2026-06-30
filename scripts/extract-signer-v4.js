#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const APP_SERVICE = path.join(__dirname, '../data/wxapkg/decompiled/wxaf35009675aa0b2a/APPAPPAPP/app-service.js');
const WSGSIG_SERVICE = path.join(__dirname, '../data/wxapkg/decompiled/wxaf35009675aa0b2a/_wsgsig_/wsgsig/app-service.js');

function extractModules(code) {
    const modules = {};
    // 匹配各种参数名格式: function(e,a,n) 或 function(t,e,n) 等
    const re = /(\d+):function\([a-z],[a-z],[a-z]\)\{/g;
    let m;
    while (m = re.exec(code)) {
        const moduleId = parseInt(m[1]);
        const startPos = m.index + m[0].length;
        let depth = 1;
        let pos = startPos;
        let inString = false;
        let stringChar = '';
        let escaped = false;
        while (depth > 0 && pos < code.length) {
            const ch = code[pos];
            if (escaped) { escaped = false; pos++; continue; }
            if (ch === '\\') { escaped = true; pos++; continue; }
            if (inString) {
                if (ch === stringChar) inString = false;
                pos++;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') {
                inString = true;
                stringChar = ch;
                pos++;
                continue;
            }
            if (ch === '{') depth++;
            if (ch === '}') depth--;
            pos++;
        }
        modules[moduleId] = code.substring(m.index, pos);
    }
    return modules;
}

function main() {
    console.log('Loading main package (1.4MB)...');
    const appCode = fs.readFileSync(APP_SERVICE, 'utf8');
    const appModules = extractModules(appCode);
    console.log('Main package modules:', Object.keys(appModules).length);
    
    console.log('Loading wsgsig package...');
    const wsgsigCode = fs.readFileSync(WSGSIG_SERVICE, 'utf8');
    const wsgsigModules = extractModules(wsgsigCode);
    console.log('wsgsig package modules:', Object.keys(wsgsigModules).length);
    
    // 合并（wsgsig覆盖主包）
    const allModules = { ...appModules, ...wsgsigModules };
    console.log('Total merged modules:', Object.keys(allModules).length);
    
    // 创建webpack运行时
    const moduleCache = {};
    function webpackRequire(id) {
        if (moduleCache[id]) return moduleCache[id].exports;
        const mod = { exports: {} };
        moduleCache[id] = mod;
        
        if (!allModules[id]) return mod.exports;
        
        try {
            const def = allModules[id];
            const fnMatch = def.match(/function\([a-z],[a-z],[a-z]\)/);
            if (!fnMatch) return mod.exports;
            const fnStart = def.indexOf(fnMatch[0]);
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
            // 只打印关键模块的错误
            if ([2582, 526, 527, 554, 232, 230].includes(id)) {
                console.error(`Module ${id} error:`, err.message?.substring(0, 100));
            }
        }
        
        return mod.exports;
    }
    
    // 运行签名模块
    console.log('\nLoading module 2582 (wsgsig)...');
    const signerExports = webpackRequire(2582);
    console.log('Module 2582 exports:', Object.keys(signerExports));
    
    if (signerExports.initSign && signerExports.getSign) {
        try {
            signerExports.initSign({
                appId: 'wx06cb940499986937',
                appKey: 'test_key_placeholder',
                version: '02'
            });
            console.log('✓ initSign called');
        } catch (err) {
            console.error('initSign error:', err.message?.substring(0, 200));
        }
        
        try {
            const sign = signerExports.getSign({
                url: 'https://energy.xiaojukeji.com/station-api/homepage/stationList',
                method: 'POST',
                data: { lat: 30.5, lng: 114.3, pageNo: 1, pageSize: 10 }
            });
            console.log('✓ getSign result:', sign);
            console.log('  prefix:', sign?.substring(0, 5));
            console.log('  length:', sign?.length);
        } catch (err) {
            console.error('getSign error:', err.message?.substring(0, 300));
        }
    }
}

main();
