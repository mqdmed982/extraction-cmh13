const express = require('express');
const session = require('express-session');
const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(session({
    secret: 'cmh9_secret_key_session_secure_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, 'public')));

function getImapHost(email) {
    const cleanEmail = (email || '').toLowerCase().trim();
    if (cleanEmail.includes('gmail')) return 'imap.gmail.com';
    if (cleanEmail.includes('sapo.pt') || cleanEmail.includes('sapo')) return 'imap.sapo.pt';
    throw new Error('Khedam ghir b @gmail.com wla @sapo.pt safi!');
}

async function getImapConnection(email, password) {
    const host = getImapHost(email);
    const cleanPassword = (password || '').trim().replace(/\s+/g, '');
    const config = {
        imap: {
            user: email.trim(),
            password: cleanPassword,
            host: host,
            port: 993,
            tls: true,
            tlsOptions: { rejectUnauthorized: false },
            authTimeout: 15000
        }
    };
    return await imaps.connect(config);
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/connect', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and Password are required.' });
    }

    let connection;
    try {
        connection = await getImapConnection(email, password);
        const boxes = await connection.getBoxes();

        req.session.email = email;
        req.session.password = password;

        const folders = [];
        function parseBoxes(boxList, prefix = '') {
            for (const name in boxList) {
                const box = boxList[name];
                const fullName = prefix ? `${prefix}${box.delimiter}${name}` : name;
                folders.push({ name: fullName });
                if (box.children) parseBoxes(box.children, fullName);
            }
        }
        parseBoxes(boxes);

        let inboxCount = 0;
        try {
            const boxStatus = await connection.openBox('INBOX');
            inboxCount = boxStatus.messages.total || 0;
        } catch (e) {
            inboxCount = 0;
        }

        connection.end();

        return res.json({
            success: true,
            email: email,
            folders: folders,
            defaultInboxCount: inboxCount
        });

    } catch (err) {
        if (connection) { try { connection.end(); } catch (e) {} }
        return res.status(401).json({ success: false, error: err.message || 'IMAP Connection failed.' });
    }
});

app.post('/extract', async (req, res) => {
    const email = req.body.email || req.session.email;
    const password = req.body.password || req.session.password;
    const label = req.body.label || 'INBOX';
    const start = Math.max(1, parseInt(req.body.start, 10) || 1);
    const limit = Math.max(1, parseInt(req.body.limit, 10) || 10);
    const mode = req.body.mode || 'headersonly';

    if (!email || !password) {
        return res.status(400).send('❌ Please connect your email first.');
    }

    let connection;
    try {
        connection = await getImapConnection(email, password);
        const box = await connection.openBox(label);

        if ((box.messages.total || 0) === 0) {
            connection.end();
            return res.send('❌ The selected folder is empty.');
        }

        const results = await connection.search(['ALL'], { bodies: ['HEADER', ''], markSeen: false });
        if (!results || results.length === 0) {
            connection.end();
            return res.send('❌ No messages found.');
        }

        results.reverse();
        const selected = results.slice(start - 1, start - 1 + limit);
        if (selected.length === 0) {
            connection.end();
            return res.send('❌ No messages found in the requested range.');
        }

        const extracted = [];

        for (const msg of selected) {
            const allPart = msg.parts.find(p => p.which === '');
            const rawEmail = allPart ? allPart.body : '';
            const parsed = await simpleParser(rawEmail);
            const headersPart = msg.parts.find(p => p.which === 'HEADER');
            let rawHeaders = headersPart ? headersPart.body : '';

            let headerStr = typeof rawHeaders === 'string' ? rawHeaders : (rawHeaders ? rawHeaders.toString('utf-8') : '');
            if (!headerStr && rawEmail) {
                const rawEmailStr = typeof rawEmail === 'string' ? rawEmail : rawEmail.toString('utf-8');
                const splitIdx = rawEmailStr.indexOf('\r\n\r\n');
                headerStr = splitIdx !== -1 ? rawEmailStr.substring(0, splitIdx) : rawEmailStr.split('\n\n')[0];
            }

            let item = '';

            switch (mode) {
                case 'justtext':
                    item = (parsed.text || '').trim();
                    break;
                case 'bodyonly':
                    item = (parsed.html || parsed.text || '').trim();
                    break;
                case 'original':
                    item = (typeof rawEmail === 'string' ? rawEmail : rawEmail.toString('utf-8')).trim();
                    break;
                case 'receivedonly':
                    item = headerStr
                        .split(/\r?\n/)
                        .filter(l => l.toLowerCase().startsWith('received:'))
                        .join('\n') || 'No Received headers found';
                    break;

                case 'headersonly': {
                    // Modification dyal les Headers dial Newsletter
                    const p_frname = req.body.P_FRNAME || '[P_FRNAME]';
                    const lan6 = req.body.LAN6 || '[6LAN]';
                    const p_rpath = req.body.P_RPATH || '[P_RPATH]';
                    const subjectVal = req.body.SUBJECT_VAL || '[S]';
                    const boundary = req.body.BOUNDARY || '[BND]';
                    const addSender1 = req.body.addSender1 === 'on' || req.body.addSender1 === true;

                    const lines = headerStr.split(/\r?\n/);
                    const newLines = [];
                    let hasReturnPath = false;
                    let hasContentLanguage = false;

                    for (let j = 0; j < lines.length; j++) {
                        let line = lines[j];
                        const lower = line.toLowerCase();

                        if (lower.startsWith('from:')) {
                            const emailMatch = line.match(/<([^>]+)>/);
                            if (emailMatch) {
                                line = `From: "${p_frname}" <${emailMatch[1]}>`;
                            } else {
                                line = `From: "${p_frname}" <${email}>`;
                            }
                        } else if (lower.startsWith('return-path:')) {
                            line = `Return-Path: <${p_rpath}>`;
                            hasReturnPath = true;
                        } else if (lower.startsWith('subject:')) {
                            line = `Subject: ${subjectVal}`;
                        } else if (lower.includes('boundary=')) {
                            line = line.replace(/boundary=["']?[^"';\r\n]+["']?/i, `boundary="${boundary}"`);
                        } else if (lower.startsWith('content-language:')) {
                            line = `Content-Language: ${lan6}`;
                            hasContentLanguage = true;
                        }
                        newLines.push(line);
                    }

                    if (!hasReturnPath) newLines.unshift(`Return-Path: <${p_rpath}>`);
                    if (!hasContentLanguage) newLines.push(`Content-Language: ${lan6}`);
                    if (addSender1) {
                        const senderIdx = newLines.findIndex(l => l.toLowerCase().startsWith('sender:'));
                        if (senderIdx !== -1) {
                            newLines[senderIdx] = `Sender: <${p_rpath}>`;
                        } else {
                            newLines.unshift(`Sender: <${p_rpath}>`);
                        }
                    }

                    item = newLines.join('\r\n');
                    break;
                }

                case 'clean':
                default: {
                    const domainRep = req.body.domain || '[RP]';
                    const eidTag = req.body.eid || '[EID]';
                    const lines = headerStr.split(/\r?\n/);
                    const cleanH = [];

                    for (let line of lines) {
                        const lower = line.toLowerCase();
                        if (!req.body.keepReceived && lower.startsWith('received:')) continue;
                        if (!req.body.keepReplyTo && lower.startsWith('reply-to:')) continue;
                        if (req.body.replaceDate && lower.startsWith('date:')) line = 'Date: [DATE]';
                        if (req.body.replaceTo && lower.startsWith('to:')) line = `To: ${domainRep}`;
                        if (lower.startsWith('message-id:')) line = `Message-ID: <${eidTag}>`;
                        cleanH.push(line);
                    }
                    if (req.body.addSender) cleanH.unshift(`Sender: ${email}`);
                    if (req.body.addCc) cleanH.push(`Cc: ${domainRep}`);

                    item = `${cleanH.join('\r\n')}\r\n\r\n${(parsed.html || parsed.text || '').trim()}`;
                    break;
                }
            }
            extracted.push(item);
        }

        connection.end();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(extracted.join('\n\n__SEP__\n\n'));

    } catch (err) {
        if (connection) { try { connection.end(); } catch (e) {} }
        return res.status(500).send('❌ Extraction error: ' + err.message);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
module.exports = app;
