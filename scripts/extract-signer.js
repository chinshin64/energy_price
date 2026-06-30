#!/usr/bin/env node
/**
 * 从反编译的wsgsig wxapkg代码中提取签名函数
 * 核心思路：直接运行JS代码，提取getSign/initSign函数
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE_PATH = path.join(__dirname, '../data/wxapkg/decompiled/wxaf35009675aa0b2a/_wsgsig_/wsgsig/app-service.js');

function extractSigner() {
    const rawCode = fs.readFileSync(CODE_PATH, 'utf8');
    
    // 找到签名模块的边界 - 搜索 getSign 导出位置
    // webpack模块格式: 2582:function(e,a,n){...}
    const getSignIdx = rawCode.indexOf('getSign:function(){return ka}');
    if (getSignIdx < 0) {
        throw new Error('getSign export not found');
    }
    
    // 向前找模块边界
    const moduleStart = rawCode.lastIndexOf('{', rawCode.lastIndexOf('function', getSignIdx));
    
    // 找到module.exports所在位置
    const moduleExportsIdx = rawCode.indexOf('module.exports=n(2582)', getSignIdx);
    if (moduleExportsIdx < 0) {
        // 可能格式不同，搜索另一种
        console.log('Searching for alternative module.exports pattern...');
    }
    
    // 策略：直接运行完整文件，在沙箱中捕获exports
    // 需要模拟webpack环境
    const modules = {};
    const moduleCache = {};
    
    function mockRequire(id) {
        if (moduleCache[id]) return moduleCache[id].exports;
        const mod = { exports: {} };
        moduleCache[id] = mod;
        
        // 对于wsgsig模块（2582），我们需要它的完整代码
        // 对于其他模块，返回空对象或mock
        if (id === 2582) {
            // 这是签名模块 - 但我们不能直接运行它
            return mod.exports;
        }
        
        // 返回通用mock - 包含常用方法
        const mock = function() { return mock; };
        mock.n = function(m) { return m && m.__esModule ? m : { default: m, ...m }; };
        mock.a = function(m) { return m; };
        mock.default = mock;
        Object.assign(mock, {
            __esModule: true,
            default: mock,
        });
        return mock;
    }
    
    // 更实际的方案：截取签名核心代码段
    // 从 "2582:function" 或从 getSign 位置向前搜索
    
    console.log('Code length:', rawCode.length);
    console.log('getSign at:', getSignIdx);
    console.log('var ne at:', rawCode.indexOf('var ne='));
    
    // 输出getSign附近的代码片段，供手动分析
    const start = Math.max(0, getSignIdx - 5000);
    const end = Math.min(rawCode.length, getSignIdx + 10000);
    
    // 找到包含ne数组的完整定义
    const neIdx = rawCode.indexOf('var ne=');
    if (neIdx > 0) {
        // ne数组从这里开始，找到闭合的]
        let bracketCount = 0;
        let neEnd = neIdx;
        for (let i = neIdx + 7; i < rawCode.length; i++) {
            if (rawCode[i] === '[') bracketCount++;
            if (rawCode[i] === ']') {
                bracketCount--;
                if (bracketCount === 0) {
                    neEnd = i + 1;
                    break;
                }
            }
        }
        console.log('\nne array: from', neIdx, 'to', neEnd, 'length:', neEnd - neIdx);
        
        // 提取ne数组
        const neCode = rawCode.substring(neIdx, neEnd);
        fs.writeFileSync(path.join(__dirname, '../data/wxapkg/ne_array.js'), 'var ne = ' + neCode + ';', 'utf8');
        console.log('ne array saved to data/wxapkg/ne_array.js');
    }
    
    // 提取se函数
    // se函数通常在ne数组之前定义
    const seFuncPattern = /function\s+se\s*\(/;
    const seMatch = rawCode.match(seFuncPattern);
    if (seMatch) {
        console.log('se function found at:', seMatch.index);
    } else {
        // 可能是变量赋值形式
        const seVarPattern = /(?:var |,)\s*se\s*=\s*function/;
        const seVarMatch = rawCode.match(seVarPattern);
        if (seVarMatch) {
            console.log('se function (var) found at:', seVarMatch.index);
        }
    }
    
    // 在ne之前搜索function se
    if (neIdx > 0) {
        const beforeNe = rawCode.substring(Math.max(0, neIdx - 3000), neIdx);
        const seFuncInBefore = beforeNe.match(/function\s+se\s*\([^)]*\)\s*\{/);
        if (seFuncInBefore) {
            console.log('se function found before ne at offset:', Math.max(0, neIdx - 3000) + seFuncInBefore.index);
        }
        
        // 也搜索赋值形式
        const seAssignInBefore = beforeNe.match(/(?:var |,\s*)se\s*=\s*function/);
        if (seAssignInBefore) {
            console.log('se= function found before ne at offset:', Math.max(0, neIdx - 3000) + seAssignInBefore.index);
        }
    }
}

extractSigner();
