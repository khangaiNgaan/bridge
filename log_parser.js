const fs = require('fs');
const path = require('path');


const LOG_DIR = './carton';
const OUTPUT_FILE = './backfill.txt';

// Core REGEXP patterns
const PATTERNS = [
    {
        // Chat
        regex: /[\[]\d{2}:\d{2}:\d{2}\] \[Async Chat Thread - #\d+\/INFO\]: (?:[^\]]+\] )?<([^>]+)> (.+)/,
        formatter: (match) => `[CHAT] <${match[1]}> ${match[2]}`
    },
    {
        // Join
        regex: /[\[]\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) joined the game/,
        formatter: (match) => `[INFO] ${match[1]} joined the game`
    },
    {
        // Leave
        regex: /[\[]\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) left the game/,
        formatter: (match) => `[INFO] ${match[1]} left the game`
    },
    {
        // Welcome
        regex: /[\[]\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: Hey (\w+), sunshine! Just wanted to send a little virtual hug your way\. Hope your day is as awesome as you are! Have a fantastic time here on Salmonized Workspace!/,
        formatter: (match) => `[INFO] Hey ${match[1]}, sunshine! Just wanted to send a little virtual hug your way. Hope your day is as awesome as you are! Have a fantastic time here on Salmonized Workspace!`
    },
    {
        // Advancement/Goal/Challenge
        regex: /[\[]\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) (has made the advancement|has reached the goal|has completed the challenge) \[(.+)\]/,
        formatter: (match) => `[INFO] ${match[1]} ${match[2]} [${match[3]}]`
    },
    {
        // Death
        regex: /[\[]\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (\w+) ((?:was|walked|drowned|died|experienced|blew|hit|fell|went|burned|tried|discovered|froze|starved|suffocated|left|withered|didn't).*)/,
        formatter: (match) => `[INFO] ${match[1]} ${match[2]}`
    }
];

let lastBaseTime = 0;
let currentOffset = 100;

function processLogs() {
    if (!fs.existsSync(LOG_DIR)) {
        console.error(`目录 ${LOG_DIR} 不存在`);
        return;
    }

    // read log files
    const files = fs.readdirSync(LOG_DIR)
        .filter(file => file.endsWith('.log'))
        .sort(); // sort by name (date)

    let outputLines = [];

    files.forEach(file => {
        // extract date from filename
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) {
            console.log(`跳过文件 (文件名不含日期): ${file}`);
            return;
        }
        const dateStr = dateMatch[1];
        const filePath = path.join(LOG_DIR, file);
        
        console.log(`正在处理: ${file}`);
        
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        lines.forEach(line => {
            handleLine(line, dateStr, outputLines);
        });
    });

    // write to output file
    fs.writeFileSync(OUTPUT_FILE, outputLines.join('\n'));
    console.log(`\n完成! 已生成 ${outputLines.length} 条记录到 ${OUTPUT_FILE}`);
}

function handleLine(line, dateStr, outputLines) {
    // return if not include '/INFO]'
    if (!line.includes('/INFO]')) return;
    
    const timeMatch = line.match(/^[\[](\d{2}:\d{2}:\d{2})[\]]/);
    if (!timeMatch) return;
    
    const timeStr = timeMatch[1];

    // match patterns
    for (const pattern of PATTERNS) {
        const match = line.match(pattern.regex);
        if (match) {
            const content = pattern.formatter(match);
            const timestamp = generateTimestamp(dateStr, timeStr);
            outputLines.push(`/insert ${timestamp} ${content}`);
            break; // first match only
        }
    }
}

function generateTimestamp(dateStr, timeStr) { 
    // construct ISO string
    const isoString = `${dateStr}T${timeStr}+08:00`;
    const baseTime = new Date(isoString).getTime();

    if (isNaN(baseTime)) {
        console.error(`时间解析错误: ${isoString}`);
        return 0;
    }

    // ensure unique timestamp
    if (baseTime === lastBaseTime) {
        // same second
        if (currentOffset < 900) {
            currentOffset += 100;
        } else {
            // exceed limit, increment by 1 ms
            currentOffset += 1;
        }
    } else {
        // new second reset the offset
        lastBaseTime = baseTime;
        currentOffset = 100;
    }

    return baseTime + currentOffset;
}

// start processing
processLogs();
