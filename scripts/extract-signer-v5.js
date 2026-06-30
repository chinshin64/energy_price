#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '../data/wxapkg/decompiled/wxaf35009675aa0b2a/APPAPPAPP/app-service.js');
const WSGSIG = path.join(__dirname, '../data/wxapkg/decompiled/wxaf35009675aa0b2a/_wsgsig_/wsgsig/app-service.js');

function extractModules(code) {
    const modules = {};
    const re = /(\d+):function\(([a-z]),([a-z]),([a-z])\)\{/g;
    let m;
    while (m = re.exec(code)) {
        const id = parseInt(m[1]), params = [m[2],m[3],m[4]];
        const bs = m.index + m[0].length;
        let d=1, p=bs, inS=false, sC='', es=false;
        while (d>0 && p<code.length) {
            const c = code[p];
            if (es) { es=false; p++; continue; }
            if (c==='\\') { es=true; p++; continue; }
            if (inS) { if (c===sC) inS=false; p++; continue; }
            if (c==='"' || c==="'" || c==='`') { inS=true; sC=c; p++; continue; }
            if (c==='{') d++;
            if (c==='}') d--;
            p++;
        }
        modules[id] = { params, body: code.substring(bs, p-1) };
    }
    return modules;
}

function main() {
    const appM = extractModules(fs.readFileSync(APP, 'utf8'));
    const wsgsigM = extractModules(fs.readFileSync(WSGSIG, 'utf8'));
    const all = {...appM, ...wsgsigM};
    console.log('Modules:', Object.keys(all).length);

    const cache = {};
    function req(id) {
        if (cache[id]) return cache[id].exports;
        const mod = {exports:{}};
        cache[id] = mod;
        if (!all[id]) return mod.exports;
        try {
            const {params, body} = all[id];
            const fn = new Function(params[0], params[1], params[2], body);
            const n = i => req(i);
            // 关键修复：n.n必须返回一个函数（getter），不是对象
            n.n = m => {
                const g = m && m.__esModule ? () => m.default : () => m;
                g.a = g;
                return g;
            };
            n.r = e => Object.defineProperty(e, '__esModule', {value:true});
            n.d = (e, d) => { for (const k in d) if (!e.hasOwnProperty(k)) Object.defineProperty(e, k, {enumerable:true, get:d[k]}); };
            n.hmd = e => e;
            n.o = (a,b) => Object.prototype.hasOwnProperty.call(a,b);
            n.t = e => e;
            fn(mod, mod.exports, n);
        } catch(e) {
            if ([2582,526,527,554,232,230,334].includes(id))
                console.error('  M'+id+':', e.message?.substring(0,100));
        }
        return mod.exports;
    }

    console.log('Loading 2582...');
    const s = req(2582);
    console.log('Exports:', Object.keys(s));

    if (s.initSign) {
        try { s.initSign({appId:'wx06cb940499986937',appKey:'test',version:'02'}); console.log('initSign OK'); }
        catch(e) { console.error('initSign:', e.message?.substring(0,200)); }
    }
    if (s.getSign) {
        try {
            const sign = s.getSign({url:'https://energy.xiaojukeji.com/station-api/homepage/stationList',method:'POST',data:{lat:30.5,lng:114.3,pageNo:1,pageSize:10}});
            console.log('getSign:', sign?.substring(0,80));
            console.log('  prefix:', sign?.substring(0,5), 'len:', sign?.length);
        } catch(e) { console.error('getSign:', e.message); console.error(e.stack?.substring(0,500)); }
    }
}
main();
