#!/usr/bin/env node
/**
 * 从完整app-service.js中提取签名函数
 * 策略：用vm沙箱模拟webpack环境，运行完整代码
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_SERVICE = path.join(__dirname, '../data/wxapkg/decompiled/wxaf35009675aa0b2a/_wsgsig_/wsgsig/app-service.js');

function main() {
    const rawCode = fs.readFileSync(APP_SERVICE, 'utf8');
    
    // webpack模块结构：一个IIFE，包含所有模块定义
    // 格式：(function(modules){...})([模块0, 模块1, ..., 模块2582, ...])
    // 或 {0:function(e,a,n){...}, 2582:function(e,a,n){...}}
    
    // 策略：从signer_module.js中提取签名代码，提供完善的mock
    const signerCode = fs.readFileSync(path.join(__dirname, '../data/wxapkg/signer_module.js'), 'utf8');
    
    // 核心问题：n()函数返回的mock需要能被当作原始值使用
    // 让我们直接mock所有需要的模块为正确的值
    
    // 分析签名模块实际用到的n()返回值
    // 关键引用：
    // var t=n(2599),h=n.n(t)  - 可能是数组fill或工具函数
    // var r=n(554),s=n.n(r)  - 可能是对象操作
    // ...
    
    // 更简单的策略：直接在签名模块代码中，把n(XXX)替换成内联实现
    // 但这太复杂了。
    
    // 最实用的策略：提供__webpack_require__的完整实现
    // 从app-service.js中提取所有模块定义，然后运行webpack runtime
    
    console.log('Attempting to run with full webpack runtime...');
    
    // 搜索webpack模块定义
    // app-service.js中每个模块格式: N:function(e,a,n){...}
    // 用正则提取所有模块
    
    const moduleRe = /(\d+):function\(e,a,n\)\{/g;
    const allModules = {};
    let m;
    let count = 0;
    while (m = moduleRe.exec(rawCode)) {
        const moduleId = parseInt(m[1]);
        const startPos = m.index + m[0].length;
        // 需要找到对应的闭合大括号
        let depth = 1;
        let pos = startPos;
        while (depth > 0 && pos < rawCode.length) {
            if (rawCode[pos] === '{') depth++;
            if (rawCode[pos] === '}') depth--;
            pos++;
        }
        allModules[moduleId] = rawCode.substring(m.index, pos);
        count++;
        if (count % 100 === 0) process.stdout.write('.');
    }
    console.log('\nExtracted', count, 'modules');
    console.log('Has module 2582:', !!allModules[2582]);
    
    // 保存模块映射
    fs.writeFileSync(
        path.join(__dirname, '../data/wxapkg/webpack_modules.json'),
        JSON.stringify(Object.keys(allModules).map(Number).sort((a,b) => a-b)),
        'utf8'
    );
    console.log('Module IDs saved');
    
    // 创建webpack运行时
    const moduleIds = Object.keys(allModules).map(Number);
    const moduleDefs = {};
    for (const id of moduleIds) {
        // 提取函数体
        const def = allModules[id];
        const fnStart = def.indexOf('function(e,a,n)');
        if (fnStart >= 0) {
            const bodyStart = def.indexOf('{', fnStart) + 1;
            const bodyEnd = def.lastIndexOf('}');
            moduleDefs[id] = def.substring(bodyStart, bodyEnd);
        }
    }
    
    console.log('Module defs parsed:', Object.keys(moduleDefs).length);
    
    // 运行模块2582
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Date,
        Math,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        JSON,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Error,
        TypeError,
        RangeError,
        RegExp,
        Map,
        Set,
        Promise,
        Symbol,
        Uint8Array,
        Int8Array,
        Float64Array,
        ArrayBuffer,
        DataView,
        Buffer,
        navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 12; 22041216C) AppleWebKit/537.36' },
        document: { createElement: () => ({}), querySelectorAll: () => [] },
        window: {},
        self: {},
        global: {},
        XMLHttpRequest: function() {},
        fetch: function() {},
        crypto: require('crypto'),
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.global = sandbox;
    
    // 创建webpack require
    const moduleCache = {};
    function webpackRequire(id) {
        if (moduleCache[id]) return moduleCache[id].exports;
        const mod = { exports: {} };
        moduleCache[id] = mod;
        
        if (!moduleDefs[id]) {
            // 模块不存在，返回空mock
            return mod.exports;
        }
        
        try {
            const fn = new vm.Function('e', 'a', 'n', moduleDefs[id]);
            const nFunc = function(reqId) {
                return webpackRequire(reqId);
            };
            nFunc.n = function(m) {
                return m && m.__esModule ? m : { default: m };
            };
            nFunc.r = function(exports) {
                Object.defineProperty(exports, '__esModule', { value: true });
            };
            nFunc.d = function(exports, definition) {
                for (const key in definition) {
                    if (!exports.hasOwnProperty(key)) {
                        Object.defineProperty(exports, key, {
                            enumerable: true,
                            get: definition[key]
                        });
                    }
                }
            };
            nFunc.hmd = function(e) { return e; };
            nFunc.o = function(a, b) { return Object.prototype.hasOwnProperty.call(a, b); };
            nFunc.t = function(e) { return e; };
            
            fn(mod, mod.exports, nFunc);
        } catch (err) {
            console.error(`Module ${id} error:`, err.message?.substring(0, 100));
        }
        
        return mod.exports;
    }
    
    // 运行签名模块
    console.log('Loading module 2582...');
    const signerExports = webpackRequire(2582);
    console.log('Module 2582 exports:', Object.keys(signerExports));
    
    if (signerExports.getSign) {
        console.log('✓ getSign function available');
    }
    if (signerExports.initSign) {
        console.log('✓ initSign function available');
        
        // 初始化签名器
        try {
            signerExports.initSign({
                appId: 'wx06cb940499986937',
                appKey: 'test_key',
                version: '02'
            });
            console.log('✓ initSign called');
        } catch (err) {
            console.error('initSign error:', err.message?.substring(0, 200));
        }
    }
    
    if (signerExports.getSign) {
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
