require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- SETUP EXPRESS & HTTP SERVER ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL; // HTTPS Web App ke liye zaroori hai

// --- SETUP TELEGRAM BOT ---
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error("FATAL: BOT_TOKEN environment variable me nahi hai.");
    process.exit(1);
}
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// --- SESSION MANAGEMENT ---
const sessions = new Map(); // token -> { chatId, browser, page, timer, clients, lastActivity }
const userToToken = new Map(); // chatId -> token
const botState = new Map(); // User ka current step track karne ke liye

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const FIXED_DISTRICT = 'Shahjahanpur';
const BHULEKH_URL = 'https://upbhulekh.gov.in/';

function resetInactivityTimer(token) {
    const session = sessions.get(token);
    if (!session) return;
    
    session.lastActivity = Date.now();
    if (session.timer) clearTimeout(session.timer);
    
    session.timer = setTimeout(() => {
        closeSession(token, '⏱ Session inactivity ki wajah se expire ho gaya. /start se dobara shuru karein.');
    }, TIMEOUT_MS);
}

async function closeSession(token, notifyMessage = null) {
    const session = sessions.get(token);
    if (!session) return;

    if (notifyMessage) {
        bot.sendMessage(session.chatId, notifyMessage).catch(() => {});
    }

    try {
        if (session.page && !session.page.isClosed()) await session.page.close();
        if (session.browser) await session.browser.close();
    } catch (e) {
        console.error("Cleanup error:", e);
    }

    session.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'closed' }));
            client.close();
        }
    });
    
    clearInterval(session.streamInterval);
    if (session.timer) clearTimeout(session.timer);
    userToToken.delete(session.chatId);
    sessions.delete(token);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- PUPPETEER BROWSER SETUP ---
async function getBrowser() {
    return await puppeteer.launch({
        headless: "new",
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, // Termux Chrome path
        defaultViewport: { width: 1280, height: 800 },
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--start-maximized'
        ]
    });
}

async function countActiveInputs(page) {
    return await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input'))
            .filter(el => el.offsetParent !== null && !el.disabled).length;
    });
}

async function clickByText(page, texts, label, timeout = 30000) {
    const wanted = texts.map(t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase());
    await page.waitForFunction((needles) => {
        const norm = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return Array.from(document.querySelectorAll('button, a, div, span, td, li'))
            .some(el => {
                const r = el.getBoundingClientRect();
                return el.offsetParent !== null && r.width > 0 && r.height > 0 &&
                    needles.some(n => norm(el.textContent).includes(n));
            });
    }, { timeout }, wanted);

    const handle = await page.evaluateHandle((needles) => {
        const norm = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const matches = Array.from(document.querySelectorAll('button, a, div, span, td, li'))
            .filter(el => el.offsetParent !== null && needles.some(n => norm(el.textContent).includes(n)));
        matches.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);
        return matches[0] || null;
    }, wanted);

    const el = handle.asElement();
    if (!el) throw new Error(`${label} nahi mila`);
    await page.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center' }), el);
    await sleep(200);
    await el.click({ delay: 80 });
    await handle.dispose().catch(() => {});
    await sleep(800);
}

async function fullyAutoSelect(page, value, stepName) {
    const maxAttempts = 4;
    await page.waitForFunction(() => {
        return Array.from(document.querySelectorAll('input'))
            .some(el => el.offsetParent !== null && !el.disabled);
    }, { timeout: 30000 });

    const beforeCount = await countActiveInputs(page);
    const beforeUrl = page.url();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const inputHandle = await page.evaluateHandle(() => {
            const inputs = Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent !== null && !el.disabled);
            return inputs[inputs.length - 1] || null;
        });
        const input = inputHandle.asElement();
        if (!input) throw new Error(`${stepName} input nahi mila`);

        await input.click({ clickCount: 3, delay: 60 });
        await input.press('Backspace');
        await input.type(value, { delay: 120 });
        await sleep(3000);

        const optionHandle = await page.evaluateHandle((val) => {
            const norm = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const target = norm(val);
            const options = Array.from(document.querySelectorAll('li, div, span, a, td, p'))
                .filter(el => el.offsetParent !== null && norm(el.textContent).includes(target));
            options.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);
            return options[0] || null;
        }, value);

        const option = optionHandle.asElement();
        if (option) {
            await page.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center' }), option);
            await sleep(200);
            await option.click({ delay: 100 });
            await sleep(3500);
            await optionHandle.dispose().catch(() => {});
            await inputHandle.dispose().catch(() => {});
            return;
        }

        await optionHandle.dispose().catch(() => {});
        await inputHandle.dispose().catch(() => {});
        await sleep(1000);
    }
    throw new Error(`${stepName} select nahi hua: ${value}`);
}

async function generateAndSendPdf(chatId, token) {
    const session = sessions.get(token);
    if (!session || !session.page) return;
    const page = session.page;

    try {
        bot.sendMessage(chatId, '📄 PDF generate ki ja rahi hai...');
        
        const isQuotationOpen = await page.evaluate(() => {
            return document.body.innerText.includes('खातेदार का नाम') && document.body.innerText.includes('उद्धरण');
        });

        if (!isQuotationOpen) {
            const hasQuoteBtn = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a'));
                return btns.some(b => b.innerText.includes('उद्धरण देखें') || b.innerText.includes('view quotation'));
            });

            if (hasQuoteBtn) {
                await clickByText(page, ['उद्धरण देखें', 'उद्धरण', 'view quotation', 'view'], 'Quotation Button');
                await sleep(5000);
            }
        }

        const pdfPath = path.join(__dirname, `khatauni_${chatId}_${Date.now()}.pdf`);
        await page.emulateMediaType('screen').catch(() => {});
        await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' } });
        
        await bot.sendDocument(chatId, pdfPath, { caption: "✅ Ye rahi aapki PDF!" }, { filename: path.basename(pdfPath), contentType: 'application/pdf' });
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
        
        await closeSession(token, '✅ Session successfully close kar diya gaya hai.');
    } catch (e) {
        bot.sendMessage(chatId, `❌ Error in PDF generation: ${e.message}`);
    }
}

// --- NEW REMOTE FLOW (Web App) ---
async function startRemoteFlow(chatId, tehsil, village) {
    let browser;
    try {
        if (!BASE_URL) throw new Error("BASE_URL .env me set nahi hai.");
        
        browser = await getBrowser();
        const page = await browser.newPage();
        await page.setDefaultTimeout(45000);
        await page.setDefaultNavigationTimeout(60000);

        await bot.sendMessage(chatId, '⚙️ Automation start ho raha hai, thoda wait karein...');
        await page.goto(BHULEKH_URL, { waitUntil: 'networkidle2' });

        await clickByText(page, ['खतौनी', 'खाताuni', 'रियल टाइम', 'rtk'], 'Khatauni Link', 45000).catch(async () => {
            await page.goto('https://upbhulekh.gov.in/#/khatauni_rtk', { waitUntil: 'networkidle2' });
        });

        await fullyAutoSelect(page, FIXED_DISTRICT, 'District');
        await fullyAutoSelect(page, tehsil, 'Tehsil');
        await fullyAutoSelect(page, village, 'Village');
        
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(500);

        const token = uuidv4();
        const session = { chatId, browser, page, clients: new Set(), lastActivity: Date.now() };
        
        sessions.set(token, session);
        userToToken.set(chatId, token);
        resetInactivityTimer(token);

        session.streamInterval = setInterval(async () => {
            if (session.clients.size === 0 || page.isClosed()) return;
            try {
                const screenshot = await page.screenshot({ type: 'jpeg', quality: 50, encoding: 'base64' });
                const message = JSON.stringify({ type: 'frame', image: screenshot });
                session.clients.forEach(c => {
                    if (c.readyState === WebSocket.OPEN) c.send(message);
                });
            } catch (err) {}
        }, 300);

        const remoteUrl = `${BASE_URL}/?token=${token}`;
        
        // TELEGRAM WEB APP BUTTON
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📱 Open Bhulekh in Telegram", web_app: { url: remoteUrl } }]
                ]
            }
        };
        
        await bot.sendMessage(chatId, `✅ Village select ho gaya.\n\nNeeche diye button par click karein aur Telegram ke andar hi apna Khata/Gata/Naam manually search karein.\n\nSearch complete hone ke baad /pdf bhejein.`, opts);

    } catch (err) {
        if (browser) await browser.close();
        bot.sendMessage(chatId, `❌ Error: ${err.message}`);
        userToToken.delete(chatId);
    }
}

// --- WEBSOCKET HANDLER (Live Stream & Touch) ---
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token || !sessions.has(token)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired session token.' }));
        return ws.close();
    }

    const session = sessions.get(token);
    session.clients.add(ws);
    resetInactivityTimer(token);

    ws.on('message', async (message) => {
        resetInactivityTimer(token);
        if (session.page.isClosed()) return;

        try {
            const data = JSON.parse(message);
            if (data.type === 'click') {
                await session.page.mouse.click(data.x, data.y);
            } else if (data.type === 'scroll') {
                await session.page.mouse.wheel({ deltaY: data.deltaY });
            } else if (data.type === 'refresh') {
                await session.page.reload({ waitUntil: 'networkidle2' });
            } else if (data.type === 'make_pdf') {
                await generateAndSendPdf(session.chatId, token);
            }
        } catch (e) {
            console.error('Action error:', e);
        }
    });

    ws.on('close', () => { session.clients.delete(ws); });
});

// --- TELEGRAM BOT ROUTING (Cleaned & Updated) ---

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (userToToken.has(chatId)) {
        await closeSession(userToToken.get(chatId));
    }
    botState.set(chatId, { step: 'TEHSIL' }); // Pehla step sirf Tehsil poochega
    bot.sendMessage(chatId, `District fixed hai: ${FIXED_DISTRICT}\nTehsil ka naam bhejiye.`);
});

bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    botState.delete(chatId);
    if (userToToken.has(chatId)) {
        await closeSession(userToToken.get(chatId), '❌ Session cancel ho gaya.');
    } else {
        bot.sendMessage(chatId, 'Koi active session nahi hai.');
    }
});

bot.onText(/\/pdf/, async (msg) => {
    const chatId = msg.chat.id;
    if (!userToToken.has(chatId)) {
        return bot.sendMessage(chatId, '❌ Bhulekh session available nahi hai. /start se dobara karein.');
    }
    const token = userToToken.get(chatId);
    await generateAndSendPdf(chatId, token);
    botState.delete(chatId);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = String(msg.text || '').trim();
    if (!text || text.startsWith('/')) return; // Ignore commands like /start

    const state = botState.get(chatId);
    if (!state) return;

    if (state.step === 'TEHSIL') {
        state.tehsil = text;
        state.step = 'VILLAGE';
        return bot.sendMessage(chatId, 'Village/Gaon ka naam bhejiye.');
    }

    if (state.step === 'VILLAGE') {
        state.village = text;
        botState.delete(chatId); // State clear, further process Web App handle karega
        await startRemoteFlow(chatId, state.tehsil, state.village);
    }
});

// START SERVER
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

