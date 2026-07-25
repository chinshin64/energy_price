#!/usr/bin/env node
/**
 * Full webpack runtime loader for wsgsig signer.
 * Extracts ALL modules from APPAPPAPP + wsgsig app-service.js,
 * runs a real __webpack_require__ runtime, then calls getSign.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const BASE = path.join(__dirname, '../data/wxapkg/decompiled/wxaf35009675aa0b2a');
const FILES = [
  // appservice.app.js has the REAL core-js runtime (module 11 = export fn, not route strings)
  // Load it FIRST so its definitions take precedence.
  path.join(BASE, 'APPAPPAPP/appservice.app.js'),
  path.join(BASE, 'APPAPPAPP/app-service.js'),
  path.join(BASE, '_wsgsig_/wsgsig/appservice.app.js'),
  path.join(BASE, '_wsgsig_/wsgsig/app-service.js'),
];

// Extract NUMBER:function(...){...} from source, with balanced brace matching
// Later definitions OVERRIDE earlier ones (webpack chunk semantics).
function extractModules(code, modules) {
  const re = /(\d{2,5}):function\(/g;
  let m;
  while (m = re.exec(code)) {
    const id = parseInt(m[1]);
    const fnStart = m.index + m[0].length - 1; // '(' position
    let pos = fnStart;
    if (code[pos] !== '(') continue;
    // skip param list
    let depth = 1;
    pos++;
    while (depth > 0 && pos < code.length) {
      if (code[pos] === '(') depth++;
      else if (code[pos] === ')') depth--;
      pos++;
    }
    // skip to '{'
    while (pos < code.length && code[pos] !== '{') pos++;
    if (code[pos] !== '{') continue;
    depth = 1;
    const bodyStart = pos + 1;
    pos++;
    while (depth > 0 && pos < code.length) {
      const ch = code[pos];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        pos++;
        while (pos < code.length && code[pos] !== quote) {
          if (code[pos] === '\\') pos++;
          pos++;
        }
      }
      pos++;
    }
    const bodyEnd = pos;
    modules[id] = code.substring(m.index, bodyEnd);
  }
  return modules;
}

function main() {
  const modules = {};
  for (const f of FILES) {
    try {
      const code = fs.readFileSync(f, 'utf8');
      extractModules(code, modules);
    } catch (e) {
      console.error('Failed to read', f, e.message);
    }
  }
  const moduleIds = Object.keys(modules).map(Number).sort((a, b) => a - b);
  console.log('Total modules loaded:', moduleIds.length);

  // Build sandbox with full globals
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    JSON, Array, Object, String, Number, Boolean,
    Error, TypeError, RangeError, SyntaxError, ReferenceError,
    RegExp, Map, Set, WeakMap, WeakSet, Promise, Symbol,
    Uint8Array, Int8Array, Uint16Array, Int16Array,
    Uint32Array, Int32Array, Float32Array, Float64Array,
    ArrayBuffer, DataView, Buffer,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 12; 22041216C) AppleWebKit/537.36' },
    document: { createElement: () => ({}), querySelectorAll: () => [], getElementById: () => null },
    XMLHttpRequest: function () { return { open() {}, send() {}, setRequestHeader() {} }; },
    fetch: function () { return Promise.resolve({ json: () => Promise.resolve({}) }); },
    crypto: crypto.webcrypto || crypto,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextEncoder, TextDecoder,
    URL, URLSearchParams,
    // WeChat mini program stubs
    wx: {
      getSystemInfoSync: () => ({
        platform: 'android', system: 'Android 12', brand: 'Xiaomi',
        model: '22041216C', SDKVersion: '3.3.5', version: '8.0.40',
        screenWidth: 1080, screenHeight: 2400, pixelRatio: 2.75,
        language: 'zh_CN', statusBarHeight: 24,
      }),
      getStorageSync: () => '',
      setStorageSync: () => {},
      request: () => {},
    },
    location: { href: '', hostname: '' },
    performance: { now: () => Date.now() },
    process: { env: {} },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__se = undefined;
  sandbox.__ua = undefined;
  sandbox.__ca = undefined;

  // Webpack runtime: __webpack_require__
  const moduleCache = {};
  let loadErrors = {};

  function webpackRequire(id) {
    if (moduleCache[id]) return moduleCache[id].exports;
    const mod = { exports: {}, id };
    moduleCache[id] = mod;
    Object.defineProperty(mod, 'id', { value: id, enumerable: false });
    if (!modules[id]) {
      // Module not found - return empty exports (graceful)
      return mod.exports;
    }
    const nFunc = function (reqId) {
      return webpackRequire(reqId);
    };
    // webpack helper functions
    nFunc.n = function (m) {
      return m && m.__esModule ? m.default : m;
    };
    nFunc.r = function (exports) {
      if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
      }
      Object.defineProperty(exports, '__esModule', { value: true });
    };
    nFunc.d = function (exports, definition) {
      for (const key in definition) {
        if (Object.prototype.hasOwnProperty.call(definition, key) &&
            !Object.prototype.hasOwnProperty.call(exports, key)) {
          Object.defineProperty(exports, key, {
            enumerable: true, get: definition[key],
          });
        }
      }
    };
    nFunc.hmd = function (e) { return e; };
    nFunc.o = function (a, b) {
      return Object.prototype.hasOwnProperty.call(a, b);
    };
    nFunc.t = function (e) { return e; };
    nFunc.g = (function () {
      if (typeof globalThis === 'object') return globalThis;
      try { return this || new Function('return this')(); }
      catch (e) { if (typeof window === 'object') return window; }
    })();
    nFunc.oo = function (exports, definition) {
      for (const key in definition) {
        nFunc.o(exports, key) && Object.defineProperty(exports, key, {
          enumerable: true, get: definition[key],
        });
      }
    };

    // Compile and run the module function.
    // modules[id] is "NUMBER:function(...){...}" - wrap and evaluate to get the fn.
    const fnBody = modules[id];
    // Strip leading "NUMBER:" to get "function(...){...}", then wrap in parens.
    const colonIdx = fnBody.indexOf(':');
    const fnSrc = '(' + fnBody.substring(colonIdx + 1) + ')';

    try {
      const ctx = vm.createContext(sandbox);
      const fn = vm.runInContext(fnSrc, ctx, {
        filename: 'module_' + id + '.js',
        timeout: 15000,
      });
      fn(mod, mod.exports, nFunc);
    } catch (err) {
      loadErrors[id] = err.message;
      // console.error('Module', id, 'error:', err.message?.substring(0, 150));
    }
    return mod.exports;
  }
  // expose in sandbox for nested requires
  sandbox.__webpack_require__ = webpackRequire;
  sandbox.require = function (id) {
    if (id === 'crypto-js') return webpackRequire(639);
    return webpackRequire(id);
  };

  // Load module 2582 (the signer) - patch to expose se/ua for diagnostics
  const orig2582 = modules[2582];
  modules[2582] = orig2582.replace(
    'ua=new ca,ba=!1;',
    'ua=new ca,ba=!1;globalThis.__se=se;globalThis.__ua=ua;globalThis.__ca=ca;'
  );
  console.log('Loading module 2582...');
  const signerExports = webpackRequire(2582);
  // Restore original (so cache isn't polluted for re-runs)
  modules[2582] = orig2582;
  const exportKeys = Object.keys(signerExports);
  console.log('Module 2582 exports:', exportKeys);

  // Diagnostic: decode se() accessor values
  const se = sandbox.__se;
  const uaInst = sandbox.__ua;
  const caClass = sandbox.__ca;
  // Try to find ua via the signerExports.default (ka) closure - inspect ca.prototype
  if (uaInst) {
    const proto = Object.getPrototypeOf(uaInst);
    console.log('ua proto methods:', Object.getOwnPropertyNames(proto).join(', '));
    console.log('ua own props:', Object.keys(uaInst).join(', '));
  } else {
    console.log('ua instance not exposed; trying to find ca prototype...');
    // The ca prototype methods are ga.prototype.X - ga is the VM class
    // Let's list all properties on the signer module's scope via a different approach
  }
  if (typeof se === 'function') {
    console.log('=== Decoded se() values ===');
    for (const i of [506, 633, 453, 814, 324, 371, 752, 727, 734, 267, 371]) {
      let v; try { v = se(i); } catch (e) { v = 'ERR:' + e.message; }
      console.log('  se(' + i + ') =', JSON.stringify(v));
    }
  } else {
    console.log('se not available (typeof:', typeof se, ')');
  }
  if (uaInst) {
    const proto = Object.getPrototypeOf(uaInst);
    console.log('ua proto methods:', Object.getOwnPropertyNames(proto).join(', '));
    console.log('ua own props:', Object.keys(uaInst).join(', '));
  }
  if (Object.keys(loadErrors).length > 0) {
    console.log('Module load errors:', Object.keys(loadErrors).length, '(showing first 10)');
    console.log('  2582 error:', loadErrors[2582] || 'none');
    for (const [id, msg] of Object.entries(loadErrors).slice(0, 10)) {
      console.log('  module', id, ':', msg.substring(0, 120));
    }
  }

  if (signerExports.getSign) {
    console.log('getSign available');
    if (signerExports.initSign) {
      try {
        signerExports.initSign({
          appId: 'wx06cb940499986937',
          appKey: 'test_key',
          version: '02',
        });
        console.log('initSign OK');
      } catch (err) {
        console.error('initSign error:', err.message?.substring(0, 200));
      }
    }
    // Diagnostic: expose internal se accessor and ua instance by patching module
    // We re-run module 2582 with a patched tail to grab se & ua.
    try {
      const patchedSrc = modules[2582];
      const colonIdx = patchedSrc.indexOf(':');
      const fnSrc = '(' + patchedSrc.substring(colonIdx + 1) + ')';
      // Inject exposure before the last closing brace
      const diagSrc = fnSrc.replace(/}\s*$/, ';this.__se=se;this.__ua=ua;this.__ca=ca;}');
      const diagSandbox = Object.assign({}, sandbox);
      diagSandbox.window = diagSandbox; diagSandbox.self = diagSandbox; diagSandbox.global = diagSandbox;
      const diagFn = vm.runInNewContext(diagSrc, diagSandbox, { filename: 'diag.js', timeout: 15000 });
      const diagExports = {};
      diagFn({}, diagExports, sandbox.__webpack_require__);
      const se = diagExports.__se;
      const ua = diagExports.__ua;
      if (typeof se === 'function') {
        const idxList = [506, 633, 453, 814, 324, 371, 752, 727, 734];
        const decoded = {};
        for (const i of idxList) decoded[i] = se(i);
        console.log('Decoded se() values:', JSON.stringify(decoded));
      }
      if (ua) {
        const proto = Object.getPrototypeOf(ua);
        const protoKeys = Object.keys(proto);
        console.log('ua proto methods (first 30):', protoKeys.slice(0, 30).join(', '));
      }
    } catch (diagErr) {
      console.log('Diagnostic failed:', diagErr.message?.substring(0, 150));
    }
    // Test getSign with 66.har sample params
    const testRequest = {
      url: 'https://energy.xiaojukeji.com/station-api/homepage/stationList?lat=30.5&lng=114.3&pageNo=1&pageSize=10',
      method: 'POST',
      data: { lat: 30.5, lng: 114.3, pageNo: 1, pageSize: 10 },
    };
    try {
      const sign = signerExports.getSign(testRequest);
      console.log('Generated sign:', sign);
      console.log('Sign length:', sign ? sign.length : 0);
      console.log('Sign prefix:', sign ? sign.substring(0, 10) : '');
    } catch (err) {
      console.error('getSign error:', err.message?.substring(0, 300));
      console.error('Stack:', err.stack?.substring(0, 500));
    }
  } else {
    console.log('getSign NOT found. Exports:', exportKeys);
  }
}

main();
