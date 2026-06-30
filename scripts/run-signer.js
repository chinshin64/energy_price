#!/usr/bin/env node
/**
 * 在Node.js沙箱中运行wsgsig签名模块
 * 提取getSign和initSign函数
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const MODULE_PATH = path.join(__dirname, '../data/wxapkg/signer_module.js');

function runSigner() {
    const moduleCode = fs.readFileSync(MODULE_PATH, 'utf8');
    
    // 模拟webpack n()函数和其他依赖
    const mockModule = function(v) {
        // 简单mock - 返回一个代理对象，访问任何属性都返回自身
        const handler = {
            get(target, prop) {
                if (prop === '__esModule') return true;
                if (prop === 'default') return mockFn;
                if (prop === 'n') return (m) => m;
                if (prop === 'a') return (m) => m;
                return mockFn;
            },
            apply(target, thisArg, args) {
                return mockFn;
            }
        };
        const mockFn = new Proxy(function(){return mockFn}, handler);
        return mockFn;
    };
    
    // 创建沙箱上下文
    const sandbox = {
        console,
        require: (id) => {
            if (id === 'crypto-js' || id === 'crypto') {
                // 返回CryptoJS mock
                return createCryptoJSMock();
            }
            return mockModule();
        },
        module: { exports: {} },
        exports: {},
        process: { env: {} },
        Buffer,
        // 模拟微信小程序环境
        wx: {
            getSystemInfoSync: () => ({
                platform: 'android',
                system: 'Android 12',
                brand: 'Xiaomi',
                model: '22041216C',
                SDKVersion: '3.3.5',
            }),
        },
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
        ArrayBuffer,
        DataView,
    };
    
    // 用webpack的require方式模拟
    // n函数需要返回n.n等
    const nFunc = function(id) {
        return mockModule(id);
    };
    nFunc.n = function(m) {
        return m && m.__esModule ? m : { default: m };
    };
    nFunc.r = function(exports) {
        Object.defineProperty(exports, '__esModule', { value: true });
    };
    nFunc.d = function(exports, definition) {
        for (const key in definition) {
            if (definition.hasOwnProperty(key) && !exports.hasOwnProperty(key)) {
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
    
    // 替换模块代码中的n()调用
    // 签名模块代码是: {"use strict";n.r(a),n.d(a,{...});...}
    // 需要用wrapper function包装: function(e,a,n){...}
    
    const wrappedCode = '(function(e, a, n) {' + moduleCode + '})';
    
    try {
        const fn = vm.runInNewContext(wrappedCode, sandbox, {
            filename: 'signer_module.js',
            timeout: 10000,
        });
        
        const a = {};
        fn({}, a, nFunc);
        
        console.log('Module loaded successfully!');
        console.log('Exports:', Object.keys(a));
        
        if (a.getSign) {
            console.log('getSign function found!');
            // 测试签名生成
            const testRequest = {
                url: 'https://energy.xiaojukeji.com/station-api/homepage/stationList',
                method: 'POST',
                data: { lat: 30.5, lng: 114.3, pageNo: 1, pageSize: 10 }
            };
            
            // 需要先初始化
            if (a.initSign) {
                console.log('initSign function found!');
                a.initSign({
                    appId: 'test',
                    appKey: 'test',
                    version: '02'
                });
            }
            
            const sign = a.getSign(testRequest);
            console.log('Generated sign:', sign);
        }
    } catch (err) {
        console.error('Error running module:', err.message);
        console.error('Stack:', err.stack?.substring(0, 500));
    }
}

function createCryptoJSMock() {
    // CryptoJS的AES-CBC实现
    return {
        AES: {
            encrypt: function(message, key, cfg) {
                const iv = cfg?.iv;
                const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
                let encrypted = cipher.update(message, 'utf8', 'base64');
                encrypted += cipher.final('base64');
                return { toString: () => encrypted };
            },
            decrypt: function(ciphertext, key, cfg) {
                const iv = cfg?.iv;
                const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
                let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
                decrypted += decipher.final('utf8');
                return { toString: () => decrypted };
            }
        },
        enc: {
            Utf8: { parse: (s) => Buffer.from(s, 'utf8') },
            Base64: { parse: (s) => Buffer.from(s, 'base64') },
            Hex: { parse: (s) => Buffer.from(s, 'hex') },
        },
        mode: { CBC: 'cbc', ECB: 'ecb' },
        pad: { PKcs7: 'pkcs7', NoPadding: 'nopadding' },
        lib: {
            WordArray: {
                create: (words, sigBytes) => ({ words, sigBytes })
            }
        }
    };
}

runSigner();
