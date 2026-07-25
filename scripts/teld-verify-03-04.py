#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TELD-03+04 补充验证: 设备对照 + 异常翻页"""
import base64,json,gzip,time,uuid,urllib.parse,urllib.request,ssl,os,subprocess,sys
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad,unpad
import certifi

K_BUS=b'ErYu78ijuVaM7Y0UqwvpO738uNC9ALF7';IV_BUS=b'Ol9mqvZ6ijnytr7O'
K_ENC=b'7fb498553e3c462988c3b9573692bd5f';IV_ENC=b'98d71fe589499967'

TES=r'''
const fs=require('fs'),vm=require('vm');
const code=fs.readFileSync(process.argv[1],'utf8');
const modules={},mc={};
function define(n,f){modules[n]=f;}
function mkReq(cur){return function(r){let x=r;if(r.startsWith('.')){let b=cur.split('/');b.pop();for(let p of r.split('/')){if(p==='.')continue;if(p==='..')b.pop();else b.push(p);}x=b.join('/');}const t=[x,x+'.js'];let f=null;for(let y of t){if(modules[y]){f=y;break;}}if(!f)for(let k of Object.keys(modules)){if(k===x||k.endsWith('/'+x)||x.endsWith(k)){f=k;break;}}if(!f){const s=r.split('/').pop();for(let k of Object.keys(modules)){if(k.split('/').pop()===s){f=k;break;}}if(!f)throw new Error('nf:'+r);}if(mc[f])return mc[f].exports;const m={exports:{}};mc[f]=m;try{modules[f](mkReq(f),m.exports,m);}catch(e){}return m.exports;};}
const sb={console,__wxAppData:{},__wxAppCode__:{},__WXML_GLOBAL__:{entrys:{},defines:{},modules:{},ops:[],wxs_nf_init:undefined,total_ops:0},__GWX_GLOBAL__:{},__vd_version_info__:{},Component:function(){return{};},definePlugin:function(){},requirePlugin:function(){},Behavior:function(){},Page:function(){},App:function(){},getApp:function(){return{};},getCurrentPages:function(){return[];},define,module:{exports:{}},exports:{},process:{env:{}},setTimeout,Buffer};
sb.globalThis=sb;sb.global=sb;sb.self=sb;sb.require=mkReq('__root__');
vm.createContext(sb);vm.runInContext(code,sb,{filename:'a.js',timeout:30000});
const m={exports:{}};
modules['utils/api/web/ajax/index.js'](mkReq('utils/api/web/ajax/index.js'),m.exports,m);
const tes=m.exports.exports.TESDecrypt;
process.stdout.write(tes(process.argv[2],process.argv[3]));
'''
def tes(sts):
    r=subprocess.run(['node','-e',TES,os.path.expanduser('~/teld-app-service.js'),'yBb6fQbbiHx3g6Me',str(sts)],capture_output=True,text=True,timeout=30)
    if r.returncode!=0: raise RuntimeError(r.stderr[:150])
    return r.stdout.strip()

def gen_uts(): ts=str(int(time.time()*1000))+'uts'; return ts,ts[:16]
def gen_uver(): return uuid.uuid4().hex[:16]
def enc_req(d):
    uts,uts16=gen_uts();uver=gen_uver()
    p=json.dumps(d,ensure_ascii=False,separators=(',',':')).encode()
    inner=AES.new(uts16.encode(),AES.MODE_CBC,uver.encode()).encrypt(pad(p,16))
    return {'UTS':uts,'UVER':uver,'Data':base64.b64encode(inner).decode(),'UUID':str(uuid.uuid4())}
def dec_resp(b64,atype='business'):
    k,iv=(K_BUS,IV_BUS) if atype=='business' else (K_ENC,IV_ENC)
    raw=base64.b64decode(b64)
    outer=json.loads(unpad(AES.new(k,AES.MODE_CBC,iv).decrypt(raw),16).decode())
    uts16=(outer['UTS']+'uts')[:16];uver=outer['UVER']
    inner=base64.b64decode(outer['Data'])
    mid=unpad(AES.new(uts16.encode(),AES.MODE_CBC,uver.encode()).decrypt(inner),16).decode()
    if mid[:4]=='H4sI': return json.loads(gzip.decompress(base64.b64decode(mid)).decode())
    return json.loads(mid)

UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger'
ctx=ssl.create_default_context(cafile=certifi.where())
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
urllib.request.install_opener(op)
os.environ['NO_PROXY']='*';os.environ['no_proxy']='*'
DEVICE='8c922d61-603d-8b95-1b4b-2561aef8e8a2'
RT=open(os.path.expanduser('~/teld_refresh.txt')).read().strip()

def invoke(sid,domain,params,token='',device=None):
    dev=device or DEVICE
    url=f'https://{domain}/api/invoke?SID={sid}'
    body=urllib.parse.urlencode(params).encode()
    rid=f'{dev}_{int(time.time()*1000)}_WX_SP'
    h={'Host':domain,'Teld-RequestID':rid,'TELDAppID':'','x-sps-v':'1.0','xweb_xhr':'1','Teld-RpcID':'0.1','Device':urllib.parse.quote(f'network=wifi&lat=31.2304&lng=121.4737&app_version=4.14.2&device_name=Mac15,7&client_version=4.14.2'),'AppVersion':'4.14.2','User-Agent':UA,'AppOS':'WX_SP','Content-Type':'application/x-www-form-urlencoded','Accept':'*/*','Referer':'https://servicewechat.com/wx8d32c1a71ecd965d/561/page-frame.html','X-Token':token}
    req=urllib.request.Request(url,data=body,headers=h,method='POST')
    try:
        with urllib.request.urlopen(req,context=ctx,timeout=15) as r: return r.status,r.read().decode()
    except urllib.error.HTTPError as e: return e.code,e.read().decode('utf-8','replace')
    except Exception as e: return 0,str(e)

print('='*60)
print('TELD-03+04 补充验证 | 执行节点: 172.28.170.239')
print(f'时间: {time.strftime("%Y-%m-%dT%H:%M:%S+08:00")}')
print('请求预算: 5')
print('='*60)

# 刷新 token
print('\n[准备] 刷新 AccessToken...')
payload=enc_req({'DeviceId':DEVICE,'DeviceType':'SP','ReqSource':10,'RefreshToken':RT})
sts=str(int(time.time()));sver=tes(sts)
body={'refreshToken':json.dumps(payload,ensure_ascii=False,separators=(',',':')),'TELDAppID':'','X-Token':'','STS':sts,'SVER':sver,'SSDI':DEVICE,'SCOI':'','SCOL':'','SRS':'SP'}
st,txt=invoke('CUS-WEBUI-ASRefreshToken','sgit1c.teld.cn',body)
token=''
if st==200:
    try:
        rj=json.loads(txt)
        if rj.get('state')=='1' and rj.get('data'):
            dec=dec_resp(rj['data'],atype='encryption')
            token=dec.get('AccessToken','')
            print(f'  AccessToken: {token[:30]}... ExpiresIn={dec.get("ExpiresIn")}')
    except Exception as e: print(f'  解密失败: {e}')
if not token:
    print('  未拿到token，终止'); sys.exit(1)

results=[]

# 请求1: 正常基线（上海第1页）
print('\n--- 请求 1/5: 正常基线 ---')
param={'pageNum':1,'itemNumPerPage':10,'locationFilterType':'1','lng':121.4737,'lat':31.2304,'sortType':'1','coordinateType':'gaode','keyword':'','source':'wxsp','locationFilterValue':50,'stationType':'2','tagInfo':[]}
enc=enc_req(param)
sts=str(int(time.time()));sver=tes(sts)
body={'param':json.dumps(enc,ensure_ascii=False,separators=(',',':')),'TELDAppID':'','X-Token':token,'STS':sts,'SVER':sver,'SSDI':DEVICE,'SCOI':'','SCOL':'','SRS':'SP'}
st,txt=invoke('AAPI-V0700-SCSC-SearchStation','sgh1c.teld.cn',body,token)
station_count=0; biz_state=None
if st==200:
    try:
        rj=json.loads(txt)
        biz_state=rj.get('state')
        if rj.get('data'):
            dec=dec_resp(rj['data']);stations=dec.get('stations',[]);station_count=len(stations)
    except Exception as e: pass
print(f'  HTTP {st} state={biz_state} stations={station_count}')
results.append({'step':1,'desc':'正常基线','http':st,'state':biz_state,'stations':station_count})

# 请求2: TELD-03 设备不匹配（换DeviceId）
print('\n--- 请求 2/5: TELD-03 设备不匹配 ---')
FAKE_DEVICE='00000000-0000-0000-0000-000000000000'
enc=enc_req(param)
sts=str(int(time.time()));sver=tes(sts)
body={'param':json.dumps(enc,ensure_ascii=False,separators=(',',':')),'TELDAppID':'','X-Token':token,'STS':sts,'SVER':sver,'SSDI':FAKE_DEVICE,'SCOI':'','SCOL':'','SRS':'SP'}
st,txt=invoke('AAPI-V0700-SCSC-SearchStation','sgh2c.teld.cn',body,token,device=FAKE_DEVICE)
station_count2=0; biz_state2=None
if st==200:
    try:
        rj=json.loads(txt)
        biz_state2=rj.get('state')
        if rj.get('data'):
            dec=dec_resp(rj['data']);stations=dec.get('stations',[]);station_count2=len(stations)
    except Exception as e: pass
print(f'  HTTP {st} state={biz_state2} stations={station_count2}')
results.append({'step':2,'desc':'设备不匹配','http':st,'state':biz_state2,'stations':station_count2})

# 请求3: TELD-03 无效token
print('\n--- 请求 3/5: TELD-03 无效token ---')
enc=enc_req(param)
sts=str(int(time.time()));sver=tes(sts)
body={'param':json.dumps(enc,ensure_ascii=False,separators=(',',':')),'TELDAppID':'','X-Token':'INVALID_TOKEN_TEST','STS':sts,'SVER':sver,'SSDI':DEVICE,'SCOI':'','SCOL':'','SRS':'SP'}
st,txt=invoke('AAPI-V0700-SCSC-SearchStation','sgit1c.teld.cn',body,'INVALID_TOKEN_TEST')
biz_state3=None;err_msg=None
if st==200:
    try:
        rj=json.loads(txt);biz_state3=rj.get('state');err_msg=rj.get('errmsg','')
    except: pass
print(f'  HTTP {st} state={biz_state3} err={err_msg}')
results.append({'step':3,'desc':'无效token','http':st,'state':biz_state3,'err':err_msg})

# 请求4: TELD-04 异常翻页（第100页）
print('\n--- 请求 4/5: TELD-04 异常翻页(第100页) ---')
param_deep={'pageNum':100,'itemNumPerPage':10,'locationFilterType':'1','lng':121.4737,'lat':31.2304,'sortType':'1','coordinateType':'gaode','keyword':'','source':'wxsp','locationFilterValue':50,'stationType':'2','tagInfo':[]}
enc=enc_req(param_deep)
sts=str(int(time.time()));sver=tes(sts)
body={'param':json.dumps(enc,ensure_ascii=False,separators=(',',':')),'TELDAppID':'','X-Token':token,'STS':sts,'SVER':sver,'SSDI':DEVICE,'SCOI':'','SCOL':'','SRS':'SP'}
st,txt=invoke('AAPI-V0700-SCSC-SearchStation','sgh1c.teld.cn',body,token)
station_count4=0; biz_state4=None
if st==200:
    try:
        rj=json.loads(txt);biz_state4=rj.get('state')
        if rj.get('data'):
            dec=dec_resp(rj['data']);stations=dec.get('stations',[]);station_count4=len(stations)
    except: pass
print(f'  HTTP {st} state={biz_state4} stations={station_count4}')
results.append({'step':4,'desc':'异常翻页(第100页)','http':st,'state':biz_state4,'stations':station_count4})

# 请求5: TELD-04 跨区域（北京远距离）
print('\n--- 请求 5/5: TELD-04 跨区域(北京) ---')
param_bj={'pageNum':1,'itemNumPerPage':10,'locationFilterType':'1','lng':116.4074,'lat':39.9042,'sortType':'1','coordinateType':'gaode','keyword':'','source':'wxsp','locationFilterValue':50,'stationType':'2','tagInfo':[]}
enc=enc_req(param_bj)
sts=str(int(time.time()));sver=tes(sts)
body={'param':json.dumps(enc,ensure_ascii=False,separators=(',',':')),'TELDAppID':'','X-Token':token,'STS':sts,'SVER':sver,'SSDI':DEVICE,'SCOI':'','SCOL':'','SRS':'SP'}
st,txt=invoke('AAPI-V0700-SCSC-SearchStation','sgh2c.teld.cn',body,token)
station_count5=0; biz_state5=None
if st==200:
    try:
        rj=json.loads(txt);biz_state5=rj.get('state')
        if rj.get('data'):
            dec=dec_resp(rj['data']);stations=dec.get('stations',[]);station_count5=len(stations)
    except: pass
print(f'  HTTP {st} state={biz_state5} stations={station_count5}')
results.append({'step':5,'desc':'跨区域(北京)','http':st,'state':biz_state5,'stations':station_count5})

# 汇总
print('\n'+'='*60)
print('验证汇总')
print('='*60)
bl=results[0]
for r in results:
    print(f'  [{r["step"]}] {r["desc"]}: HTTP={r["http"]} state={r.get("state")} stations={r.get("stations","")}')
print()
print(f'TELD-03 设备对照: ' + ('✅ 设备不匹配被识别' if results[1].get('state')!=bl.get('state') or results[1].get('stations')!=bl.get('stations') else '⚠️ 设备不匹配未被拒绝'))
print(f'TELD-03 无效token: ' + ('✅ 无效token被拒绝' if results[2].get('state')!=bl.get('state') else '⚠️ 无效token未被拒绝'))
print(f'TELD-04 异常翻页: ' + ('✅ 异常翻页被处置' if results[3].get('state')!=bl.get('state') else '⚠️ 异常翻页未被处置'))
print(f'TELD-04 跨区域: ' + ('✅ 跨区域被处置' if results[4].get('state')!=bl.get('state') else '⚠️ 跨区域未被处置(返回不同城市结果正常)'))

import json as j
print('\n--- JSON 结果 ---')
print(j.dumps({'testId':'TELD-03-04-supplement','executedAt':time.strftime('%Y-%m-%dT%H:%M:%S+08:00'),'executionNode':'172.28.170.239','outboundIP':'36.28.192.239','requestBudget':5,'actualRequests':5,'results':results,'stopReason':'验证完成'},ensure_ascii=False,indent=2))
