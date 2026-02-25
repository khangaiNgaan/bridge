// bridge.js
require('dotenv').config();

const { spawn } = require('child_process');
const readline = require('readline');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Rcon } = require('rcon-client');

// logging setup
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

function formatDate(dateObj) {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getLogFile() {
    const now = new Date();
    const dateStr = formatDate(now); // YYYY-MM-DD
    return path.join(LOG_DIR, `${dateStr}.log`);
}

function writeToLogFile(args) {
    const now = new Date();
    const timestamp = now.toTimeString().split(' ')[0]; // HH:mm:ss
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    const logLine = `[${timestamp}] ${message}\n`;
    
    try {
        fs.appendFileSync(getLogFile(), logLine);
    } catch (err) {
        process.stderr.write(`无法写入日志文件: ${err.message}\n`);
    }
}

// override console.log and console.error
const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
    originalLog(...args);
    writeToLogFile(args);
};

console.error = (...args) => {
    originalError(...args);
    writeToLogFile(args);
};

// configs

const CONFIG = {
    // configs for mc to chatroom bridge
	WS_URL: process.env.WS_URL,
	LOG_FILE: process.env.LOG_FILE,
	COOKIE: process.env.COOKIE,
    // configs for chatroom to mc bridge
    PORT: process.env.PORT,
    BRIDGE_TOKEN: process.env.BRIDGE_TOKEN,
    RCON_HOST: process.env.RCON_HOST,
    RCON_PORT: parseInt(process.env.RCON_PORT, 10),
    RCON_PASSWORD: process.env.RCON_PASSWORD,
    API_URL: process.env.API_URL
};

if (!CONFIG.WS_URL || !CONFIG.LOG_FILE || !CONFIG.COOKIE) {
    console.error("[BRIDGE] ERROR: 请配置 .env 文件");
    process.exit(1);
}

console.log(`[BRIDGE] 正在启动...`);
console.log(`[BRIDGE] 监控日志: ${CONFIG.LOG_FILE}`);
console.log(`[BRIDGE] 目标地址: ${CONFIG.WS_URL}`);

// I. HTTP Server for receiving RCON commands 
// (get req from cloudflare tunnel for streaming chatroom msg to mc server)

const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/') {
        const authHeader = req.headers['authorization'];
        if (CONFIG.BRIDGE_TOKEN && authHeader !== `Bearer ${CONFIG.BRIDGE_TOKEN}`) {
            res.writeHead(401);
            res.end('Unauthorized');
            return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (data.command) {
                    console.log(`[HTTP] 收到 RCON 指令: ${data.command}`);
                    await sendRconCommand(data.command);
                    res.writeHead(200);
                    res.end('OK');
                } else {
                    res.writeHead(400);
                    res.end('Missing command');
                }
            } catch (e) {
                console.error(`[HTTP] Error: ${e.message}`);
                res.writeHead(500);
                res.end('Internal Error');
            }
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

httpServer.listen(CONFIG.PORT, '127.0.0.1', () => {
    console.log(`[HTTP] Server listening on 127.0.0.1:${CONFIG.PORT}`);
});

async function sendRconCommand(command) {
    if (!CONFIG.RCON_PASSWORD) {
        console.error('[RCON] 未配置 RCON_PASSWORD, 无法发送指令');
        return;
    }
    try {
        const rcon = await Rcon.connect({
            host: CONFIG.RCON_HOST,
            port: CONFIG.RCON_PORT,
            password: CONFIG.RCON_PASSWORD
        });
        const response = await rcon.send(command);
        console.log(`[RCON] Response: ${response}`);
        await rcon.end();
    } catch (error) {
        console.error(`[RCON] Failed to send command: ${error.message}`);
    }
}

// II. WebSocket & Log Tailing 
// (stream chat and info to chatroom)

let ws;
let msgQueue = [];
let idleTimer = null;

// WebSocket
function connect() {
    // if already connected or is connecting
    if ( ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

	ws = new WebSocket(CONFIG.WS_URL, {
		headers: {
			'Cookie': CONFIG.COOKIE,
			'User-Agent': 'MC-BRIDGE/1.0'
		}
	});

	ws.on('open', () => {
		console.log('[WS] 已连接');
        flushMsgQueue();
	});

	ws.on('close', (code, reason) => {
		console.log(`[WS] 连接中断 (代码: ${code})`);
		setTimeout(() => {
            if (msgQueue.length > 0) connect();
        }, 5000);
	});

	ws.on('error', (err) => {
		console.log('[WS] ERROR: ', err.message);
		ws.close();
	});
}

// deal with msg queue
function flushMsgQueue() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (msgQueue.length > 0) {
        const msg = msgQueue.shift();
        const now = Date.now();
        const latency = (now - msg.time) / 1000;
        let finalText = msg.text;
        // note the latency
        if (latency > 5) {
            finalText += ` (delayed ${latency.toFixed(0)}s)`;
        }

        ws.send(finalText);
        console.log(`[Flush] ${finalText}`);
    }
    resetIdleTimer();
}

// send msg to chatroom
function sendToChatroom(text) {
    msgQueue.push({
        text: text,
        time: Date.now()
    });
	if (ws && ws.readyState === WebSocket.OPEN) {
        flushMsgQueue();
    } else {
        console.log(`[Queue] 未连接, 消息已存入队列 (当前积压: ${msgQueue.length})`);
        connect();
    }
}

// idle timer
function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log("[Idle] 已空闲 10min, 已中断 WebSocket 连线");
            ws.close();
        }
    }, 10 * 60 * 1000);
}

// get msg 
function startTailing() {
    console.log('[Tail] 正在运行...');
    
    // using Follow ('-F') mode
    // only get msg sent after bridge has started ('-n', '0')
    const tailProc = spawn('tail', ['-F', '-n', '0', CONFIG.LOG_FILE]);

    tailProc.stderr.on('data', (data) => {
        console.error(`[Tail] ERROR: ${data}`);
    });

    // using readline
    const rl = readline.createInterface({
        input: tailProc.stdout,
        terminal: false
    });

    rl.on('line', (line) => {
        handleLogLine(line);
    });

    tailProc.on('close', (code) => {
        console.log(`[Tail] 进程退出 (代码 ${code}), 尝试重启...`);
        setTimeout(startTailing, 2000);
    });
}

// Core REGEXPs
function handleLogLine(line) {
    // return if not include '/INFO]'
    if (!line.includes('/INFO]')) return;

    // async chat
    const chatMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Async Chat Thread - #\d+\/INFO\]: (?:\[[^\]]+\] )?<([^>]+)> (.+)/);
    if (chatMatch) {
        const player = chatMatch[1];
        const msg = chatMatch[2];
        sendToChatroom(`[CHAT] <${player}> ${msg}`);
        return;
    }

    // player joined the game
    const joinMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) joined the game/);
    if (joinMatch) {
        const player = joinMatch[1];
        sendToChatroom(`[INFO] ${player} joined the game`);
        return;
    }

    // player left game
    const leaveMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) left the game/);
    if (leaveMatch) {
        const player = leaveMatch[1];
        sendToChatroom(`[INFO] ${player} left the game`);
        return;
    }

    // auto welcome message
    const welcomeMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: Hey (\w+), sunshine! Just wanted to send a little virtual hug your way\. Hope your day is as awesome as you are! Have a fantastic time here on Salmonized Workspace!/);
    if (welcomeMatch) {
        const player = welcomeMatch[1];
        sendToChatroom(`[INFO] Hey ${player}, sunshine! Just wanted to send a little virtual hug your way. Hope your day is as awesome as you are! Have a fantastic time here on Salmonized Workspace!`);
        return;
    }

    // advancement / goal / challenge
    const advMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) (has made the advancement|has reached the goal|has completed the challenge) \[(.+)\]/);
    if (advMatch) {
        const player = advMatch[1];
        const action = advMatch[2];
        const advName = advMatch[3];
        sendToChatroom(`[INFO] ${player} ${action} [${advName}]`);
        return;
    }

    // death message
    const deathMatch = line.match(/\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) ((?:was|walked|drowned|died|experienced|blew|hit|fell|went|burned|tried|discovered|froze|starved|suffocated|left|withered|didn't).*)/);
    if (deathMatch) {
        const player = deathMatch[1];
        const msg = deathMatch[2];
        sendToChatroom(`[INFO] ${player} ${msg}`);
        return;
    }
}

// III. Cookie Auto-Renewal
// (check JWT exp in cookie, if less than 10 days, perform renewal flow)

function parseJwt(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) {
        return null;
    }
}

async function renewCookieIfNeeded() {
    console.log('[Auto-Renew] 检查 Cookie 有效期...');
    
    // Cookie format: session=eyJ...; ...
    // Extract the JWT part
    const sessionTokenMatch = CONFIG.COOKIE.match(/session=([^;]+)/);
    // If not found, maybe the whole string is the token (unlikely based on header format, but possible in env)
    const sessionToken = sessionTokenMatch ? sessionTokenMatch[1] : CONFIG.COOKIE;

    const payload = parseJwt(sessionToken);
    if (!payload || !payload.exp) {
        console.error('[Auto-Renew] JWT 解析失败, 跳过续签检查');
        return;
    }

    const now = Math.floor(Date.now() / 1000);
    const timeLeft = payload.exp - now;
    const daysLeft = timeLeft / (60 * 60 * 24);

    console.log(`[Auto-Renew] Cookie 剩余有效期: ${daysLeft.toFixed(2)} 天`);

    if (daysLeft < 10) {
        console.log('[Auto-Renew] Cookie 剩余有效期不足 10 天, 开始续签流程...');
        await performRenewal();
    }
}

async function performRenewal() {
    try {
        // 1. Get Access Token
        console.log('[Auto-Renew] 1. 正在取得 Access Token...');
        const tokenRes = await fetch(`${CONFIG.API_URL}/api/tokens`, {
            method: 'POST',
            headers: {
                'Cookie': CONFIG.COOKIE,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ label: `Bridge-AutoRenew-${Date.now()}` })
        });

        if (!tokenRes.ok) throw new Error(`获取 AT 失败: ${tokenRes.status}`);
        const tokenData = await tokenRes.json();
        if (!tokenData.success || !tokenData.token) throw new Error('AT 响应无效');
        
        const accessToken = tokenData.token;
        console.log('[Auto-Renew] Access Token 获取成功');

        // 2. Login with Access Token to get new Cookie
        console.log('[Auto-Renew] 2. 使用 Access Token 换取新 Cookie...');
        const loginRes = await fetch(`${CONFIG.API_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                username: 'console',
                access_token: accessToken 
            })
        });

        if (!loginRes.ok) throw new Error(`登录失败: ${loginRes.status}`);
        
        // Extract set-cookie
        const setCookieHeader = loginRes.headers.get('set-cookie');
        if (!setCookieHeader) throw new Error('登录响应未包含 Set-Cookie 头');

        // Simple parsing to get the session part
        // Set-Cookie: session=...; Max-Age=...
        const newSessionPart = setCookieHeader.split(';')[0]; 
        
        console.log('[Auto-Renew] 新 Cookie 获取成功!');
        
        // 3. Update State
        CONFIG.COOKIE = newSessionPart; // Update in memory
        
        // Update .env file
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, 'utf8');
            // Replace existing COOKIE line
            if (envContent.includes('COOKIE=')) {
                envContent = envContent.replace(/COOKIE=.*/, `COOKIE=${newSessionPart}`);
            } else {
                envContent += `\nCOOKIE=${newSessionPart}`;
            }
            fs.writeFileSync(envPath, envContent);
            console.log('[Auto-Renew] .env 文件已更新');
        } else {
             console.log('[Auto-Renew] .env 文件不存在, 仅更新内存状态');
        }

    } catch (err) {
        console.error(`[Auto-Renew] 续签失败: ${err.message}`);
    }
}

setInterval(renewCookieIfNeeded, 24 * 60 * 60 * 1000);
renewCookieIfNeeded();

// start
connect();
startTailing();
