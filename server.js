const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { Pool } = require('pg');
const Busboy = require('busboy');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Blizz now uses PostgreSQL for persistent data.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function headers(){return {'Access-Control-Allow-Origin':process.env.ALLOWED_ORIGIN||'*','Access-Control-Allow-Headers':'Content-Type, Authorization, X-Founder-Key','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};}
function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers()});res.end(JSON.stringify(obj));}
function body(req){return new Promise((resolve,reject)=>{let d='';req.on('data',c=>{d+=c;if(d.length>2e6){req.destroy();reject(new Error('Request too large'));}});req.on('end',()=>{try{resolve(d?JSON.parse(d):{});}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);});}
function hashPassword(password,salt){return crypto.scryptSync(password,salt,64).toString('hex');}
function publicUser(u){return {id:u.id,username:u.username,displayName:u.display_name??u.displayName,email:u.email||'',phone:u.phone||'',gender:u.gender,bio:u.bio||'',createdAt:u.created_at??u.createdAt,role:u.role||'user'};}
function normalizeIdentifier(x){return String(x||'').trim().toLowerCase();}
function normalizePhone(x){let p=String(x||'').replace(/[^0-9+]/g,'');if(p.startsWith('+'))p=p.slice(1);if(p.startsWith('0')&&p.length===11)p='234'+p.slice(1);return p;}
function validEmail(x){return typeof x==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);}
function aiSanitize(x){return String(x||'').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,4000);}
function safePath(urlPath){const pathname=decodeURIComponent(urlPath);const relative=pathname==='/'?'index.html':pathname.replace(/^\/+/, '');const full=path.resolve(ROOT,relative);return full.startsWith(ROOT+path.sep)||full===ROOT?full:null;}
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon'};
function staticFile(req,res){const u=new URL(req.url,'http://localhost');const file=safePath(u.pathname);if(!file)return json(res,403,{error:'Forbidden'});fs.stat(file,(e,st)=>{if(e||!st.isFile())return json(res,404,{error:'Not found'});res.writeHead(200,{'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache'});fs.createReadStream(file).pipe(res);});}

async function q(text, params=[]){return pool.query(text,params);}
async function initDb(){
  await q(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    phone TEXT, gender TEXT, dob TEXT, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS wallets (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, coins BIGINT NOT NULL DEFAULT 0, reserved BIGINT NOT NULL DEFAULT 0)`);
  await q(`CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY, user_id TEXT, type TEXT NOT NULL, amount BIGINT, reason TEXT, ref TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS ledger_payment_ref_idx ON ledger(ref) WHERE type='payment_coin_purchase' AND ref IS NOT NULL`);
  await q(`CREATE TABLE IF NOT EXISTS creator_earnings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, available_minor BIGINT NOT NULL DEFAULT 0, paid_minor BIGINT NOT NULL DEFAULT 0
  )`);
  await q(`CREATE TABLE IF NOT EXISTS creator_periods (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, period TEXT NOT NULL, eligible_views BIGINT NOT NULL, net_ad_revenue_minor BIGINT NOT NULL,
    creator_share_minor BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'finalized', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,period)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS support_tickets (id TEXT PRIMARY KEY, user_id TEXT, issue TEXT NOT NULL, diagnosis TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS ai_events (id TEXT PRIMARY KEY, event TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media BYTEA NOT NULL, media_type TEXT NOT NULL, original_name TEXT,
    sound BYTEA, sound_type TEXT, sound_name TEXT, caption TEXT NOT NULL DEFAULT '',
    hashtags JSONB NOT NULL DEFAULT '[]'::jsonb, mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
    visibility TEXT NOT NULL DEFAULT 'public', edit_config JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS edit_config JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await q(`CREATE INDEX IF NOT EXISTS posts_created_idx ON posts(created_at DESC)`);
  await q(`CREATE TABLE IF NOT EXISTS follows (
    follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(follower_id,following_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS password_resets (
    reset_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, otp_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL, attempts INT NOT NULL DEFAULT 0,
    verified BOOLEAN NOT NULL DEFAULT FALSE, reset_token TEXT UNIQUE
  )`);
}

async function migrateLegacyFiles(){
  const usersFile=path.join(DATA,'users.json');
  if(!fs.existsSync(usersFile)) return;
  const count=await q('SELECT COUNT(*)::int AS n FROM users');
  if(count.rows[0].n!==0) return;
  try{
    const users=JSON.parse(fs.readFileSync(usersFile,'utf8'));
    if(!Array.isArray(users)) return;
    for(const u of users){
      await q(`INSERT INTO users(id,username,display_name,email,phone,gender,dob,password_salt,password_hash,bio,role,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [u.id,u.username,u.displayName,u.email,u.phone||'',u.gender||'',u.dob||'',u.passwordSalt,u.passwordHash,u.bio||'',u.role||'user',u.createdAt||new Date().toISOString()]);
    }
    console.log(`Imported ${users.length} legacy users into PostgreSQL.`);
  }catch(e){console.error('Legacy user import skipped:',e.message);}
}

async function auth(req){const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return null;const token=h.slice(7);const r=await q(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1`,[token]);return r.rows[0]||null;}
async function founder(req){const u=await auth(req);if(!u)return null;const key=req.headers['x-founder-key'];if(process.env.FOUNDER_ADMIN_KEY && key===process.env.FOUNDER_ADMIN_KEY)return u;if(u.role==='founder')return u;return null;}

function aiDiagnose(message){const m=aiSanitize(message).toLowerCase();const rules=[
  [['wrong password','incorrect password','password is wrong','forgot password','forgot my password'],'PASSWORD','Password problem','If the password is incorrect, use Forgot password to verify the account and create a new one. I will never ask for your password.'],
  [['account not found','unknown account','no account'],'ACCOUNT_NOT_FOUND','Account not found','The account could not be found with that identifier. Check the username or email, or create a new Blizz account.'],
  [['session expired','session has expired','can\'t log in','cannot log in','login','log in'],'AUTH_SESSION','Login/session problem','I can help with a login or session problem. If the account exists, we can safely clear a stale session and return to login.'],
  [['profile','edit profile','bio','display name'],'PROFILE','Profile problem','It looks like a profile update problem. Check that the session is active, then try saving again.'],
  [['settings','privacy','notification','accessibility'],'SETTINGS','Settings problem','It looks like a settings/navigation problem. I can record the issue for support and help you retry it.'],
  [['upload','video','photo','post'],'MEDIA','Media/post problem','It looks like a media or posting problem. Check the file and connection; I can record the failure without exposing private data.'],
  [['game','trivia','matchup'],'GAMES','Games/matchup problem','It looks like a games or matchup problem. I can diagnose the flow or create a support ticket.'],
  [['message','chat','inbox'],'MESSAGING','Messaging problem','It looks like a messaging problem. I can record the issue without exposing private message contents.'],
  [['coin','wallet','gift','payment','transfer','payout','earning'],'FINANCE','Wallet/payment problem','I can help inspect a Blizz wallet, gift, payment or creator-earnings issue. The financial ledger is server-authoritative.']
];for(const [keys,code,title,answer] of rules)if(keys.some(k=>m.includes(k)))return {code,title,answer,safeFix:code==='AUTH_SESSION'};return {code:'GENERAL',title:'General Blizz support',answer:'Tell me what happened and what you expected Blizz to do. I can diagnose common problems or create a support ticket.',safeFix:false};}
async function aiEvent(event,details){try{await q('INSERT INTO ai_events(id,event,details) VALUES($1,$2,$3)',[crypto.randomUUID(),event,JSON.stringify(details||{})]);}catch(e){console.error('AI event log failed:',e.message);}}
async function createTicket(message,diagnosis,userId){const id='BLZ-'+Date.now().toString(36).toUpperCase();await q('INSERT INTO support_tickets(id,user_id,issue,diagnosis) VALUES($1,$2,$3,$4)',[id,userId||null,aiSanitize(message),diagnosis.code]);await aiEvent('support_ticket',{id,code:diagnosis.code,userId:userId||null});return id;}

async function getWallet(userId){const r=await q('SELECT coins,reserved FROM wallets WHERE user_id=$1',[userId]);if(!r.rows[0]){await q('INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);return {coins:0,reserved:0};}return {coins:Number(r.rows[0].coins),reserved:Number(r.rows[0].reserved)};}
async function ledgerFor(userId){const r=await q(`SELECT id,type,amount,reason,ref,metadata,created_at AS time FROM ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,[userId]);return r.rows.map(x=>({...x,amount:x.amount===null?null:Number(x.amount)}));}
async function creatorEarnings(userId){const e=await q('SELECT available_minor,paid_minor FROM creator_earnings WHERE user_id=$1',[userId]);const p=await q('SELECT period,eligible_views,net_ad_revenue_minor,creator_share_minor,status,created_at FROM creator_periods WHERE user_id=$1 ORDER BY created_at DESC',[userId]);return {availableMinor:Number(e.rows[0]?.available_minor||0),paidMinor:Number(e.rows[0]?.paid_minor||0),periods:Object.fromEntries(p.rows.map(x=>[x.period,{period:x.period,eligibleViews:Number(x.eligible_views),netAdRevenueMinor:Number(x.net_ad_revenue_minor),creatorShareMinor:Number(x.creator_share_minor),status:x.status,createdAt:x.created_at}]))};}

async function sendResetSMS(to,otp){const key=process.env.TERMII_API_KEY,base=String(process.env.TERMII_BASE_URL||'').replace(/\/$/,'');if(!key||!base)throw Error('SMS_PROVIDER_NOT_CONFIGURED');const payload=JSON.stringify({api_key:key,to:normalizePhone(to),from:process.env.TERMII_SENDER_ID||'Blizz',sms:`Your Blizz verification code is ${otp}. It expires in 10 minutes.`,type:'plain',channel:'dnd'});const u=new URL(base+'/api/sms/send');return new Promise((resolve,reject)=>{const req=https.request({hostname:u.hostname,path:u.pathname,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>r.statusCode>=200&&r.statusCode<300?resolve(true):reject(Error('SMS delivery failed')))});req.on('error',reject);req.write(payload);req.end();});}
async function sendResetEmail(to,otp){const key=process.env.RESEND_API_KEY;if(!key)throw Error('EMAIL_PROVIDER_NOT_CONFIGURED');const payload=JSON.stringify({from:process.env.RESET_FROM_EMAIL||'Blizz Support <onboarding@resend.dev>',to:[to],subject:'Blizz password reset code',html:`<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto"><h2>Blizz password reset</h2><p>Your Blizz verification code is:</p><div style="font-size:32px;font-weight:800;letter-spacing:8px;padding:16px;background:#f4f1ff;border-radius:12px;text-align:center">${otp}</div><p>This code expires in 10 minutes.</p></div>`});return new Promise((resolve,reject)=>{const req=https.request({hostname:'api.resend.com',path:'/emails',method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>r.statusCode>=200&&r.statusCode<300?resolve(true):reject(Error('Email delivery failed')))});req.on('error',reject);req.write(payload);req.end();});}
function multipart(req,maxBytes=250*1024*1024){return new Promise((resolve,reject)=>{let bb;try{bb=Busboy({headers:req.headers,limits:{fileSize:maxBytes,files:2,fields:20}})}catch(e){return reject(e)}const out={fields:{},files:{}};bb.on('field',(name,val)=>out.fields[name]=val);bb.on('file',(name,file,info)=>{const chunks=[];file.on('data',c=>chunks.push(c));file.on('limit',()=>reject(new Error('Uploaded file is too large (250 MB max).')));file.on('end',()=>{out.files[name]={buffer:Buffer.concat(chunks),filename:info.filename,mime:info.mimeType}})});bb.on('error',reject);bb.on('finish',()=>resolve(out));req.pipe(bb)})}
function randomOtp(){return String(crypto.randomInt(100000,1000000));}
function hashOtp(code){return crypto.createHash('sha256').update(String(code)).digest('hex');}
function maskEmail(email){const [name,domain]=String(email||'').split('@');return (name?name.slice(0,2):'**')+'***@'+domain;}
function maskPhone(phone){const p=normalizePhone(phone);return p.length>4?'+'+p.slice(0,3)+'***'+p.slice(-3):'your phone';}

function openaiChat(messages){return new Promise((resolve,reject)=>{const key=process.env.OPENAI_API_KEY;if(!key)return reject(Error('AI_NOT_CONFIGURED'));const model=process.env.OPENAI_MODEL||'gpt-5.6-luna';const input=messages.slice(-20).map(m=>({role:m.role==='assistant'?'assistant':'user',content:[{type:'input_text',text:aiSanitize(m.content)}]}));const payload=JSON.stringify({model,instructions:`You are Blizz AI, the official Blizz customer-care and product-support assistant. Be natural, helpful, concise, warm and accurate. Handle accounts, login, password recovery, safety, privacy, creator tools, games, wallet/coins, gifts, payments and creator earnings. Never invent balances, transactions, payouts, security results or account status. Financial truth comes only from Blizz server data. Never ask for passwords, NIN, BVN, card numbers or private keys. You do not own Blizz and cannot change Founder authority. Use only approved support actions. If you cannot verify something, say so and escalate.` ,input});const req=https.request({hostname:'api.openai.com',path:'/v1/responses',method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const o=JSON.parse(d);if(r.statusCode<200||r.statusCode>=300)return reject(Error(o.error?.message||'OpenAI request failed'));let text=o.output_text;if(!text&&Array.isArray(o.output))text=o.output.flatMap(x=>x.content||[]).map(x=>x.text||'').filter(Boolean).join('\n');resolve(text||'I received the request but could not produce a response.');}catch(e){reject(e);}})});req.on('error',reject);req.write(payload);req.end();});}


function runFFmpeg(args){return new Promise((resolve,reject)=>{const cp=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});let err='';cp.stderr.on('data',d=>err+=d.toString());cp.on('error',reject);cp.on('close',code=>code===0?resolve():reject(Error(err.slice(-5000)||'Media processing failed')));});}
async function processUploadedVideo(media,soundBuffer,edit){
  if(!media || !/^video\//.test(media.mime)) return media;
  const tmp=await fs.promises.mkdtemp(path.join(os.tmpdir(),'blizz-media-'));
  const input=path.join(tmp,'input.bin'), output=path.join(tmp,'output.mp4');
  await fs.promises.writeFile(input,media.buffer);
  if(soundBuffer) await fs.promises.writeFile(path.join(tmp,'sound.bin'),soundBuffer);
  try{
    const e=edit||{};
    const duration=await new Promise((resolve,reject)=>{const cp=spawn(ffmpegPath,['-i',input],{stdio:['ignore','ignore','pipe']});let text='';cp.stderr.on('data',d=>text+=d.toString());cp.on('error',reject);cp.on('close',()=>{const m=text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);resolve(m?(+m[1]*3600+ +m[2]*60+ +m[3]):0);});});
    if(!duration) throw Error('Could not read video duration.');
    const startPct=Math.max(0,Math.min(99,Number(e.start??0))), endPct=Math.max(startPct+1,Math.min(100,Number(e.end??100)));
    const start=duration*startPct/100, clipDuration=Math.max(.05,duration*(endPct-startPct)/100);
    const speed=Math.max(.25,Math.min(4,Number(e.speed||1)));
    const origVol=Math.max(0,Math.min(1,Number(e.originalVolume??1))), musicVol=Math.max(0,Math.min(1,Number(e.musicVolume??.8)));
    const vf=[];
    const styles={Vivid:'eq=saturation=1.35:contrast=1.08',Warm:'colorbalance=rs=.08:gs=.03:bs=-.04',Cool:'colorbalance=rs=-.04:gs=.02:bs=.08',Fade:'eq=brightness=.04:contrast=.92','B&W':'hue=s=0',Glow:'eq=brightness=.08:saturation=1.15:gamma=1.04',Dream:'gblur=sigma=0.45'};
    const style=styles[String(e.filter||'')]||styles[String(Array.isArray(e.effects)?e.effects[0]:'')]; if(style)vf.push(style);
    if(e.overlayText) vf.push(`drawtext=text='${String(e.overlayText).replace(/([\\':])/g,'\\$1').replace(/%/g,'\\%').replace(/\n/g,' ')}':fontcolor=white:fontsize=42:borderw=3:bordercolor=black@0.65:x=(w-text_w)/2:y=h*0.78`);
    if(speed!==1) vf.push(`setpts=${(1/speed).toFixed(5)}*PTS`);
    const args=['-y','-ss',String(start),'-t',String(clipDuration),'-i',input];
    if(soundBuffer){
      args.push('-i',path.join(tmp,'sound.bin'));
      const vchain=vf.length?vf.join(','):'null';
      const atempo=[]; let remain=speed; while(remain>2){atempo.push('atempo=2');remain/=2;} while(remain<.5){atempo.push('atempo=0.5');remain/=.5;} if(Math.abs(remain-1)>0.001)atempo.push(`atempo=${remain.toFixed(5)}`);
      const orig=`[0:a]volume=${origVol}`+(atempo.length?`,${atempo.join(',')}`:'')+'[orig]';
      const music='[1:a]volume='+musicVol+'[music]';
      args.push('-filter_complex',`[0:v]${vchain}[v];${orig};${music};[orig][music]amix=inputs=2:duration=first:dropout_transition=2[a]`,'-map','[v]','-map','[a]');
    }else{
      if(vf.length)args.push('-vf',vf.join(','));
      args.push('-map','0:v:0','-map','0:a?');
      const af=[]; if(origVol!==1)af.push(`volume=${origVol}`); if(speed!==1){let remain=speed;while(remain>2){af.push('atempo=2');remain/=2;}while(remain<.5){af.push('atempo=0.5');remain/=0.5;}if(Math.abs(remain-1)>0.001)af.push(`atempo=${remain.toFixed(5)}`);} if(af.length)args.push('-af',af.join(','));
    }
    args.push('-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart','-shortest',output);
    await runFFmpeg(args);
    const buffer=await fs.promises.readFile(output);
    return {...media,buffer,mime:'video/mp4',filename:(media.filename||'blizz-video').replace(/\.[^.]+$/,'')+'.mp4'};
  } finally {await fs.promises.rm(tmp,{recursive:true,force:true}).catch(()=>{});}
}

async function main(){
  await initDb();
  await migrateLegacyFiles();
  const server=http.createServer(async(req,res)=>{
    if(req.method==='OPTIONS'){res.writeHead(204,headers());return res.end();}
    try{
      if(req.url==='/api/health'&&req.method==='GET'){
        await q('SELECT 1');
        return json(res,200,{ok:true,service:'Blizz API',database:'postgresql',aiConfigured:!!process.env.OPENAI_API_KEY,ledger:'server-authoritative'});
      }
      if(req.url==='/api/signup'&&req.method==='POST'){
        const b=await body(req);const username=normalizeIdentifier(b.username),displayName=String(b.displayName||'').trim(),email=normalizeIdentifier(b.email),phone=normalizePhone(b.phone||''),password=String(b.password||''),gender=String(b.gender||'').trim(),dob=String(b.dob||'').trim();
        if(username.length<3||username.length>20||!/^[a-z0-9_.]+$/.test(username))return json(res,400,{error:'Username must be 3–20 characters using letters, numbers, _ or .'});
        if(!displayName)return json(res,400,{error:'Display name is required'});if(!validEmail(email))return json(res,400,{error:'Enter a valid email'});if(password.length<8)return json(res,400,{error:'Password must be at least 8 characters'});if(!gender)return json(res,400,{error:'Select a gender'});if(!dob)return json(res,400,{error:'Date of birth is required'});
        const exists=await q('SELECT username,email FROM users WHERE username=$1 OR email=$2',[username,email]);if(exists.rows.length)return json(res,409,{error:exists.rows[0].username===username?'Username already exists':'Email already exists'});
        const id=crypto.randomUUID(),salt=crypto.randomBytes(16).toString('hex'),ph=hashPassword(password,salt);const client=await pool.connect();let token;
        try{await client.query('BEGIN');await client.query(`INSERT INTO users(id,username,display_name,email,phone,gender,dob,password_salt,password_hash,bio,role) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'','user')`,[id,username,displayName,email,phone,gender,dob,salt,ph]);await client.query('INSERT INTO wallets(user_id) VALUES($1)',[id]);token=crypto.randomBytes(32).toString('hex');await client.query('INSERT INTO sessions(token,user_id) VALUES($1,$2)',[token,id]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
        const u=(await q('SELECT * FROM users WHERE id=$1',[id])).rows[0];return json(res,201,{user:publicUser(u),token});
      }
      if(req.url==='/api/login'&&req.method==='POST'){
        const b=await body(req),login=normalizeIdentifier(b.login),password=String(b.password||'');const r=await q('SELECT * FROM users WHERE username=$1 OR email=$1',[login]);const u=r.rows[0];
        if(!u)return json(res,401,{code:'ACCOUNT_NOT_FOUND',error:'Account not found. Check your username or email.'});
        const check=hashPassword(password,u.password_salt),a=Buffer.from(check,'hex'),c=Buffer.from(u.password_hash,'hex');if(a.length!==c.length||!crypto.timingSafeEqual(a,c))return json(res,401,{code:'WRONG_PASSWORD',error:'Wrong password. Please try again or use Forgot password.'});
        const token=crypto.randomBytes(32).toString('hex');await q('INSERT INTO sessions(token,user_id) VALUES($1,$2)',[token,u.id]);return json(res,200,{user:publicUser(u),token});
      }
      if(req.url==='/api/password/request'&&req.method==='POST'){
        const b=await body(req),identifier=String(b.identifier||'').trim(),id=normalizeIdentifier(identifier),phone=normalizePhone(identifier);if(!identifier)return json(res,400,{error:'Enter your email, username, or phone number.'});
        const r=await q('SELECT * FROM users WHERE email=$1 OR username=$1 OR phone=$2',[id,phone]);const u=r.rows[0];if(!u)return json(res,200,{ok:true,message:'If that account can be recovered, a verification code will be sent to the recovery contact.'});
        const otp=randomOtp(),resetId=crypto.randomBytes(24).toString('hex');await q(`DELETE FROM password_resets WHERE user_id=$1 OR expires_at<NOW()`,[u.id]);await q(`INSERT INTO password_resets(reset_id,user_id,otp_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')`,[resetId,u.id,hashOtp(otp)]);
        let delivery='';try{if(u.phone && phone===normalizePhone(u.phone) && process.env.TERMII_API_KEY && process.env.TERMII_BASE_URL){await sendResetSMS(u.phone,otp);delivery='sms';}else{await sendResetEmail(u.email,otp);delivery='email';}}catch(e){if(process.env.NODE_ENV!=='production'&&process.env.SHOW_RESET_OTP==='true')return json(res,200,{ok:true,resetId,delivery:'test',otp,message:'Verification code generated for testing.'});return json(res,503,{error:'We could not send the verification code right now. Please try again later.'});}
        await aiEvent('password_reset_requested',{userId:u.id,delivery});return json(res,200,{ok:true,resetId,delivery,destination:delivery==='sms'?maskPhone(u.phone):maskEmail(u.email),message:`Verification code sent by ${delivery==='sms'?'SMS':'email'}.`});
      }
      if(req.url==='/api/password/verify'&&req.method==='POST'){
        const b=await body(req),resetId=String(b.resetId||''),otp=String(b.otp||'').trim();const r=await q('SELECT * FROM password_resets WHERE reset_id=$1',[resetId]);const x=r.rows[0];if(!x||new Date(x.expires_at).getTime()<Date.now())return json(res,400,{error:'That verification code has expired. Request a new one.'});if(x.attempts>=5)return json(res,429,{error:'Too many attempts. Request a new code.'});await q('UPDATE password_resets SET attempts=attempts+1 WHERE reset_id=$1',[resetId]);if(hashOtp(otp)!==x.otp_hash)return json(res,400,{error:'Incorrect verification code.'});const resetToken=crypto.randomBytes(32).toString('hex');await q('UPDATE password_resets SET verified=true,reset_token=$1,expires_at=NOW()+INTERVAL \'10 minutes\' WHERE reset_id=$2',[resetToken,resetId]);return json(res,200,{ok:true,resetToken,message:'Code verified. You can now create a new password.'});
      }
      if(req.url==='/api/password/reset'&&req.method==='POST'){
        const b=await body(req),resetToken=String(b.resetToken||''),newPassword=String(b.newPassword||'');if(newPassword.length<8)return json(res,400,{error:'New password must be at least 8 characters.'});const r=await q(`SELECT * FROM password_resets WHERE reset_token=$1 AND verified=true AND expires_at>NOW()`,[resetToken]);const x=r.rows[0];if(!x)return json(res,400,{error:'Your verification has expired. Start password recovery again.'});const salt=crypto.randomBytes(16).toString('hex'),ph=hashPassword(newPassword,salt);const client=await pool.connect();try{await client.query('BEGIN');await client.query('UPDATE users SET password_salt=$1,password_hash=$2 WHERE id=$3',[salt,ph,x.user_id]);await client.query('DELETE FROM sessions WHERE user_id=$1',[x.user_id]);await client.query('DELETE FROM password_resets WHERE reset_id=$1',[x.reset_id]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}await aiEvent('password_reset_completed',{userId:x.user_id});return json(res,200,{ok:true,message:'Password changed successfully. Please log in with your new password.'});
      }
      if(req.url==='/api/me'&&req.method==='GET'){const u=await auth(req);if(!u)return json(res,401,{error:'Not signed in'});return json(res,200,{user:publicUser(u)});}
      if(req.url==='/api/profile'&&req.method==='POST'){const u=await auth(req);if(!u)return json(res,401,{error:'Not signed in'});const b=await body(req);const display=b.displayName!==undefined?String(b.displayName).trim().slice(0,60):u.display_name;const bio=b.bio!==undefined?String(b.bio).slice(0,160):u.bio;const r=await q('UPDATE users SET display_name=$1,bio=$2 WHERE id=$3 RETURNING *',[display,bio,u.id]);return json(res,200,{user:publicUser(r.rows[0])});}
      if(req.url==='/api/logout'&&req.method==='POST'){const h=req.headers.authorization||'',token=h.startsWith('Bearer ')?h.slice(7):null;if(token)await q('DELETE FROM sessions WHERE token=$1',[token]);return json(res,200,{ok:true});}
      if(req.url==='/api/wallet'&&req.method==='GET'){const u=await auth(req);if(!u)return json(res,401,{error:'Login required'});return json(res,200,{...(await getWallet(u.id)),transactions:await ledgerFor(u.id)});}
      if(req.url==='/api/coins/test-credit'&&req.method==='POST'){const u=await auth(req);if(!u)return json(res,401,{error:'Login required'});if(process.env.NODE_ENV==='production'&&process.env.ENABLE_TEST_MONEY!=='true')return json(res,403,{error:'Test coin credit is disabled in production'});const b=await body(req),amount=Math.floor(Number(b.amount));if(!Number.isSafeInteger(amount)||amount<=0||amount>1000000)return json(res,400,{error:'Invalid test amount'});const client=await pool.connect();try{await client.query('BEGIN');await client.query('INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT DO NOTHING',[u.id]);const w=await client.query('UPDATE wallets SET coins=coins+$1 WHERE user_id=$2 RETURNING coins,reserved',[amount,u.id]);const id='TX-'+crypto.randomUUID();await client.query('INSERT INTO ledger(id,user_id,type,amount,reason,ref) VALUES($1,$2,\'coin_credit\',$3,\'test_credit\',$4)',[id,u.id,amount,'TEST-'+crypto.randomUUID()]);await client.query('COMMIT');return json(res,200,{ok:true,coins:Number(w.rows[0].coins),warning:'Test-only credit.'});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
      if(req.url==='/api/gifts/send'&&req.method==='POST'){const u=await auth(req);if(!u)return json(res,401,{error:'Login required'});const b=await body(req),recipient=normalizeIdentifier(b.recipientUsername),amount=Math.floor(Number(b.amount));if(!recipient||!Number.isSafeInteger(amount)||amount<=0)return json(res,400,{error:'Recipient and positive coin amount are required'});const toR=await q('SELECT * FROM users WHERE username=$1',[recipient]);const to=toR.rows[0];if(!to)return json(res,404,{error:'Recipient not found'});if(to.id===u.id)return json(res,400,{error:'You cannot gift yourself'});const ref='GIFT-'+crypto.randomUUID(),client=await pool.connect();try{await client.query('BEGIN');await client.query('INSERT INTO wallets(user_id) VALUES($1),($2) ON CONFLICT DO NOTHING',[u.id,to.id]);const from=await client.query('UPDATE wallets SET coins=coins-$1 WHERE user_id=$2 AND coins>=$1 RETURNING coins',[amount,u.id]);if(!from.rows[0]){await client.query('ROLLBACK');return json(res,400,{error:'Insufficient Blizz Coins'});}const rec=await client.query('UPDATE wallets SET coins=coins+$1 WHERE user_id=$2 RETURNING coins',[amount,to.id]);await client.query('INSERT INTO ledger(id,user_id,type,amount,reason,ref,metadata) VALUES($1,$2,\'coin_debit\',$3,\'gift_sent\',$4,$5),($6,$7,\'coin_credit\',$8,\'gift_received\',$4,$9)',[ref,u.id,amount,ref,JSON.stringify({recipient:to.username}),crypto.randomUUID(),to.id,amount,JSON.stringify({sender:u.username})]);await client.query('COMMIT');return json(res,200,{ok:true,transactionId:ref,fromCoins:Number(from.rows[0].coins),recipient:to.username,recipientCoins:Number(rec.rows[0].coins)});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
      if(req.url==='/api/posts'&&req.method==='POST'){
        const u=await auth(req); if(!u)return json(res,401,{error:'Login required'});
        const m=await multipart(req), media=m.files.media;
        if(!media || (!/^video\//.test(media.mime)&&!/^image\//.test(media.mime))) return json(res,400,{error:'Choose a video or image.'});
        const caption=String(m.fields.caption||'').slice(0,2200);
        const visibility=['public','followers','friends','private'].includes(m.fields.visibility)?m.fields.visibility:'public';
        const hashtags=(caption.match(/#[A-Za-z0-9_]+/g)||[]).slice(0,30), mentions=(caption.match(/@[A-Za-z0-9_]+/g)||[]).slice(0,30);
        let sound=null,soundType=null,soundName='';
        if(m.files.sound){sound=m.files.sound.buffer;soundType=m.files.sound.mime;soundName=String(m.fields.soundName||m.files.sound.filename||'Sound').slice(0,120)}
        let editConfig={};try{editConfig=JSON.parse(String(m.fields.editConfig||'{}'));}catch(_){editConfig={};}
        const processed=await processUploadedVideo(media,sound,editConfig);
        const id='POST-'+crypto.randomUUID();
        await q(`INSERT INTO posts(id,user_id,media,media_type,original_name,sound,sound_type,sound_name,caption,hashtags,mentions,visibility,edit_config) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,u.id,processed.buffer,processed.mime,processed.filename,sound,soundType,soundName,caption,JSON.stringify(hashtags),JSON.stringify(mentions),visibility,JSON.stringify(editConfig)]);
        return json(res,201,{ok:true,post:{id,caption,hashtags,mentions,visibility,mediaUrl:'/api/media/'+id,soundUrl:sound?'/api/media/'+id+'/sound':null,soundName}});
      }
      if(req.url.startsWith('/api/media/')&&req.method==='GET'){
        const parts=req.url.split('/'),id=parts[3],isSound=parts[4]==='sound';
        const r=await q(`SELECT media,media_type,sound,sound_type FROM posts WHERE id=$1`,[id]); if(!r.rows[0])return json(res,404,{error:'Media not found'});
        const x=r.rows[0],data=isSound?x.sound:x.media;if(!data)return json(res,404,{error:'Sound not found'});
        res.writeHead(200,{'Content-Type':isSound?x.sound_type:x.media_type,'Cache-Control':'public,max-age=31536000',...headers()});return res.end(data);
      }
      if(new URL(req.url,'http://localhost').pathname==='/api/posts'&&req.method==='GET'){
        const u=await auth(req);if(!u)return json(res,401,{error:'Login required'});
        const mode=new URL(req.url,'http://localhost').searchParams.get('mode')||'foryou';
        let where=`p.visibility='public' OR p.user_id=$1`,params=[u.id];
        if(mode==='following'){where=`p.user_id IN (SELECT following_id FROM follows WHERE follower_id=$1) OR p.user_id=$1`;}
        if(mode==='friends'){where=`p.user_id IN (SELECT f1.following_id FROM follows f1 JOIN follows f2 ON f2.follower_id=f1.following_id WHERE f1.follower_id=$1 AND f2.following_id=$1) OR p.user_id=$1`;}
        const r=await q(`SELECT p.id,p.user_id,u.username,u.display_name,p.media_type,p.caption,p.hashtags,p.mentions,p.visibility,p.sound_name,p.sound IS NOT NULL AS has_sound,p.edit_config,p.created_at FROM posts p JOIN users u ON u.id=p.user_id WHERE ${where} ORDER BY p.created_at DESC LIMIT 50`,params);
        return json(res,200,{ok:true,posts:r.rows.map(x=>({id:x.id,userId:x.user_id,username:x.username,displayName:x.display_name,mediaType:x.media_type,caption:x.caption,hashtags:x.hashtags,mentions:x.mentions,visibility:x.visibility,editConfig:x.edit_config||{},soundName:x.sound_name||'',hasSound:x.has_sound,mediaUrl:'/api/media/'+x.id,soundUrl:x.has_sound?'/api/media/'+x.id+'/sound':null,createdAt:x.created_at}))});
      }
      if(req.url.startsWith('/api/follow/')&&req.method==='POST'){
        const u=await auth(req);if(!u)return json(res,401,{error:'Login required'});const target=decodeURIComponent(req.url.slice('/api/follow/'.length));const r=await q('SELECT id FROM users WHERE username=$1',[target]);if(!r.rows[0])return json(res,404,{error:'User not found'});if(r.rows[0].id===u.id)return json(res,400,{error:'You cannot follow yourself'});await q('INSERT INTO follows(follower_id,following_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[u.id,r.rows[0].id]);return json(res,200,{ok:true,following:true});
      }
      if(req.url.startsWith('/api/unfollow/')&&req.method==='POST'){
        const u=await auth(req);if(!u)return json(res,401,{error:'Login required'});const target=decodeURIComponent(req.url.slice('/api/unfollow/'.length));await q('DELETE FROM follows f USING users x WHERE f.following_id=x.id AND f.follower_id=$1 AND x.username=$2',[u.id,target]);return json(res,200,{ok:true,following:false});
      }
      if(req.url==='/api/payments/webhook'&&req.method==='POST'){const raw=await body(req),secret=process.env.PAYMENT_WEBHOOK_SECRET;if(!secret)return json(res,503,{error:'Payment webhook secret is not configured'});const supplied=String(req.headers['x-payment-signature']||'');const canonical=JSON.stringify(raw),expected=crypto.createHmac('sha256',secret).update(canonical).digest('hex');if(!supplied||supplied.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return json(res,401,{error:'Invalid payment signature'});if(raw.event!=='coin_purchase')return json(res,200,{ok:true,ignored:true});const ref=String(raw.reference||''),userId=String(raw.userId||''),coins=Math.floor(Number(raw.coins));if(!ref||!userId||!Number.isSafeInteger(coins)||coins<=0)return json(res,400,{error:'Invalid coin purchase payload'});const client=await pool.connect();try{await client.query('BEGIN');const existing=await client.query("SELECT id FROM ledger WHERE type='payment_coin_purchase' AND ref=$1 FOR UPDATE",[ref]);if(existing.rows[0]){await client.query('COMMIT');return json(res,200,{ok:true,duplicate:true,transactionId:existing.rows[0].id});}await client.query('INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);const w=await client.query('UPDATE wallets SET coins=coins+$1 WHERE user_id=$2 RETURNING coins',[coins,userId]);if(!w.rows[0]){await client.query('ROLLBACK');return json(res,404,{error:'User not found'});}const id='TX-'+crypto.randomUUID();await client.query('INSERT INTO ledger(id,user_id,type,amount,reason,ref,metadata) VALUES($1,$2,\'payment_coin_purchase\',$3,\'payment\',$4,$5)',[id,userId,coins,ref,JSON.stringify({provider:process.env.PAYMENT_PROVIDER||'external'})]);await client.query('COMMIT');return json(res,200,{ok:true,coins:Number(w.rows[0].coins),reference:ref});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
      if(req.url==='/api/creator/earnings'&&req.method==='GET'){const u=await auth(req);if(!u)return json(res,401,{error:'Login required'});return json(res,200,await creatorEarnings(u.id));}
      if(req.url==='/api/creator/calculate'&&req.method==='POST'){const u=await founder(req);if(!u)return json(res,403,{error:'Founder authorization required'});const b=await body(req),target=String(b.userId||''),period=String(b.period||'').trim(),views=Math.floor(Number(b.eligibleViews)||0),revenue=Math.floor(Number(b.netAdRevenueMinor)||0);if(!target||!period||views<0||revenue<0)return json(res,400,{error:'userId, period, eligibleViews and netAdRevenueMinor are required'});const creatorMinor=Math.floor(revenue*60/100),client=await pool.connect();try{await client.query('BEGIN');const exists=await client.query('SELECT * FROM creator_periods WHERE user_id=$1 AND period=$2 FOR UPDATE',[target,period]);if(exists.rows[0]){await client.query('COMMIT');const x=exists.rows[0];return json(res,200,{ok:true,rule:'60% creator / 40% Blizz',period:{period:x.period,eligibleViews:Number(x.eligible_views),netAdRevenueMinor:Number(x.net_ad_revenue_minor),creatorShareMinor:Number(x.creator_share_minor),status:x.status,createdAt:x.created_at}});}await client.query('INSERT INTO creator_periods(user_id,period,eligible_views,net_ad_revenue_minor,creator_share_minor) VALUES($1,$2,$3,$4,$5)',[target,period,views,revenue,creatorMinor]);await client.query('INSERT INTO creator_earnings(user_id,available_minor,paid_minor) VALUES($1,$2,0) ON CONFLICT(user_id) DO UPDATE SET available_minor=creator_earnings.available_minor+$2',[target,creatorMinor]);await client.query('INSERT INTO ledger(id,user_id,type,amount,reason,metadata) VALUES($1,$2,\'creator_earnings\',$3,\'period_finalized\',$4)',['TX-'+crypto.randomUUID(),target,creatorMinor,JSON.stringify({period,eligibleViews:views,netAdRevenueMinor:revenue})]);await client.query('COMMIT');return json(res,200,{ok:true,rule:'60% creator / 40% Blizz',period:{period,eligibleViews:views,netAdRevenueMinor:revenue,creatorShareMinor:creatorMinor,status:'finalized'}});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
      if(req.url==='/api/creator/payout'&&req.method==='POST'){const u=await founder(req);if(!u)return json(res,403,{error:'Founder authorization required'});const b=await body(req),target=String(b.userId||''),amount=Math.floor(Number(b.amountMinor));if(!target||!Number.isSafeInteger(amount)||amount<=0)return json(res,400,{error:'Valid userId and amountMinor required'});const client=await pool.connect();try{await client.query('BEGIN');const r=await client.query('UPDATE creator_earnings SET available_minor=available_minor-$1,paid_minor=paid_minor+$1 WHERE user_id=$2 AND available_minor>=$1 RETURNING available_minor,paid_minor',[amount,target]);if(!r.rows[0]){await client.query('ROLLBACK');return json(res,400,{error:'Insufficient available creator earnings'});}await client.query('INSERT INTO ledger(id,user_id,type,amount,reason,metadata) VALUES($1,$2,\'creator_payout_approved\',$3,\'payout_approved\',$4)',['TX-'+crypto.randomUUID(),target,amount,JSON.stringify({approvedBy:u.id})]);await client.query('COMMIT');return json(res,200,{ok:true,amountMinor:amount,status:'approved_for_payment'});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
      if(req.url==='/api/ai/chat'&&req.method==='POST'){const u=await auth(req),b=await body(req);let messages=Array.isArray(b.messages)?b.messages.slice(-20):[{role:'user',content:String(b.message||'')}];const lower=String(messages.at(-1)?.content||'').toLowerCase();if(u&&(lower.includes('balance')||lower.includes('coin')||lower.includes('wallet'))){const w=await getWallet(u.id);messages=[{role:'system',content:`Verified Blizz wallet snapshot: ${w.coins} coins available, ${w.reserved} reserved. Treat these numbers as authoritative for this response only; do not invent balances.`},...messages];}if(u&&(lower.includes('earning')||lower.includes('payout')||lower.includes('creator'))){const e=await creatorEarnings(u.id);messages=[{role:'system',content:`Verified creator earnings snapshot: availableMinor=${e.availableMinor}, paidMinor=${e.paidMinor}. Explain only what is present; do not invent payout status.`},...messages];}try{const answer=await openaiChat(messages);await aiEvent('gpt_chat',{userId:u?.id||null});return json(res,200,{ok:true,answer,model:process.env.OPENAI_MODEL||'gpt-5.6-luna'});}catch(e){const fallback=aiDiagnose(messages.at(-1)?.content||'');if(e.message==='AI_NOT_CONFIGURED')return json(res,503,{ok:false,error:'AI is not configured yet. Add OPENAI_API_KEY to Render environment variables.',fallback});return json(res,502,{ok:false,error:'AI service temporarily unavailable',fallback});}}
      if(req.url==='/api/ai/health'&&req.method==='GET'){await q('SELECT 1');return json(res,200,{ok:true,status:'operational',database:'postgresql',mode:process.env.OPENAI_API_KEY?'gpt-live-with-safe-tools':'safe-diagnostics'});}
      if(req.url==='/api/ai/support'&&req.method==='POST'){const b=await body(req),diagnosis=aiDiagnose(b.message||'');await aiEvent('support_diagnosis',{code:diagnosis.code});return json(res,200,{ok:true,diagnosis});}
      if(req.url==='/api/ai/ticket'&&req.method==='POST'){const u=await auth(req),b=await body(req),diagnosis=aiDiagnose(b.message||''),ticketId=await createTicket(b.message||'',diagnosis,u?.id);return json(res,200,{ok:true,ticketId,status:'open'});}
      if(req.url==='/api/ai/autofix'&&req.method==='POST'){const u=await auth(req);if(!u)return json(res,401,{error:'Login required'});const b=await body(req),diagnosis=aiDiagnose(b.message||b.code||'');if(diagnosis.code!=='AUTH_SESSION')return json(res,200,{ok:false,action:'MANUAL_REVIEW',message:'No automatic repair is enabled for this problem yet. I recorded the issue for support.'});const token=(req.headers.authorization||'').slice(7);await q('DELETE FROM sessions WHERE token=$1',[token]);await aiEvent('safe_autofix',{code:diagnosis.code,userId:u.id,action:'clear_session'});return json(res,200,{ok:true,action:'SESSION_CLEARED',message:'Your old session was safely cleared. Please log in again.'});}
      if(req.method==='GET'&&!req.url.startsWith('/api/'))return staticFile(req,res);return json(res,404,{error:'Not found'});
    }catch(e){console.error(e);return json(res,500,{error:'Server error',detail:process.env.NODE_ENV==='production'?undefined:e.message});}
  });
  server.listen(PORT,'0.0.0.0',()=>console.log(`Blizz listening on port ${PORT}`));
  const shutdown=async()=>{try{await pool.end();}finally{process.exit(0);}};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
main().catch(e=>{console.error('Blizz database startup failed:',e);process.exit(1);});
