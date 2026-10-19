const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const qrcode = require('qrcode-terminal');
const https = require('https');
const http = require('http');
const axios = require('axios');

const mediaDir = path.join(__dirname, 'recovered_media');
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir);

const dpDir = path.join(__dirname, 'saved_dps');
if (!fs.existsSync(dpDir)) fs.mkdirSync(dpDir);

const messageStore = new Map();

function downloadImage(url, filepath) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode === 200) {
                const fileStream = fs.createWriteStream(filepath);
                res.pipe(fileStream);
                fileStream.on('finish', () => { fileStream.close(); resolve(true); });
            } else { reject(`Server responded with ${res.statusCode}`); }
        }).on('error', (err) => { reject(err.message); });
    });
}

function getSimilarity(s1, s2) {
    let longer = s1, shorter = s2;
    if (s1.length < s2.length) { longer = s2; shorter = s1; }
    let longerLength = longer.length;
    if (longerLength === 0) return 1.0;
    return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
    s1 = s1.toLowerCase(); s2 = s2.toLowerCase();
    let costs = new Array();
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) costs[j] = j;
            else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    costs[j - 1] = lastValue; lastValue = newValue;
                }
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}

async function findParticipantByName(sock, groupJid, queryName) {
    try {
        const metadata = await sock.groupMetadata(groupJid).catch(() => null);
        if (!metadata || !metadata.participants) return null;

        const cleanQuery = queryName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
        let bestMatch = null, highestScore = 0;

        for (const p of metadata.participants) {
            const pushName = p.notify || "";
            const cleanPushName = pushName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
            const phonePart = p.id.split('@')[0];

            if (cleanPushName.includes(cleanQuery) || cleanQuery.includes(cleanPushName) || phonePart.includes(cleanQuery)) {
                return p.id;
            }

            let score = getSimilarity(cleanQuery, cleanPushName);
            if (score > highestScore) {
                highestScore = score;
                bestMatch = p.id;
            }
        }
        if (highestScore >= 0.70) return bestMatch;
        return null;
    } catch (e) { return null; }
}

async function translateText(text, targetLang = 'si') {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.data && res.data[0]) return res.data[0].map(item => item[0]).join('');
        return null;
    } catch (e) { return null; }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["JARVIS", "Chrome", "1.0"]
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if(qr) qrcode.generate(qr, {small: true});
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(() => connectToWhatsApp(), 3000);
        } else if (connection === 'open') {
            console.log('🤖 J.A.R.V.I.S. Fully Fixed & Operational!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msgs = m.messages;
        for (const msg of msgs) {
            if (!msg.message) continue;

            const sender = msg.key.remoteJid;
            const keyStr = `${sender}_${msg.key.id}`;
            messageStore.set(keyStr, msg);

            const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
            const rawText = messageContent.trim();
            const command = rawText.toUpperCase();
            const isGroup = sender.endsWith('@g.us');

            // 1. #JEX - Kick
            if (command === "#JEX" || command.startsWith("#JEX ")) {
                if (!isGroup) return await sock.sendMessage(sender, { text: "❌ මෙම විධානය ගෲප් වලට පමණි." });
                try {
                    const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
                    let targetJid = quotedParticipant;
                    if (!targetJid) {
                        const queryName = rawText.replace(/^#JEX\s*/i, "").trim();
                        if (queryName) targetJid = await findParticipantByName(sock, sender, queryName);
                    }
                    if (targetJid) {
                        const res = await sock.groupParticipantsUpdate(sender, [targetJid], "remove");
                        if (res && res[0] && res[0].status === "200") await sock.sendMessage(sender, { text: "✅ අදාළ සාමාජිකයා ගෲප් එකෙන් ඉවත් කරන ලදී." });
                        else await sock.sendMessage(sender, { text: "❌ සාමාජිකයා ඉවත් කිරීමට නොහැකි විය." });
                    } else await sock.sendMessage(sender, { text: "❌ අදාළ තැනැත්තා සොයාගත නොහැක." });
                } catch (err) { await sock.sendMessage(sender, { text: "❌ දෝෂයක් සිදු විය." }); }
            }

            // 2. #JGA - Promote
            else if (command === "#JGA" || command.startsWith("#JGA ")) {
                if (!isGroup) return await sock.sendMessage(sender, { text: "❌ මෙම විධානය ගෲප් වලට පමණි." });
                try {
                    const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
                    let targetJid = quotedParticipant;
                    if (!targetJid) {
                        const queryName = rawText.replace(/^#JGA\s*/i, "").trim();
                        if (queryName) targetJid = await findParticipantByName(sock, sender, queryName);
                    }
                    if (targetJid) {
                        const res = await sock.groupParticipantsUpdate(sender, [targetJid], "promote");
                        if (res && res[0] && res[0].status === "200") await sock.sendMessage(sender, { text: "✅ අදාළ සාමාජිකයා ගෲප් ඇඩ්මින් කෙනෙක් ලෙස පත් කරන ලදී!" });
                        else await sock.sendMessage(sender, { text: "❌ ඇඩ්මින් කිරීමට නොහැකි විය." });
                    } else await sock.sendMessage(sender, { text: "❌ අදාළ තැනැත්තා සොයාගත නොහැක." });
                } catch (err) { await sock.sendMessage(sender, { text: "❌ දෝෂයක් සිදු විය." }); }
            }

            // 3. #JGAE - Demote
            else if (command === "#JGAE" || command.startsWith("#JGAE ")) {
                if (!isGroup) return await sock.sendMessage(sender, { text: "❌ මෙම විධානය ගෲප් වලට පමණි." });
                try {
                    const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
                    let targetJid = quotedParticipant;
                    if (!targetJid) {
                        const queryName = rawText.replace(/^#JGAE\s*/i, "").trim();
                        if (queryName) targetJid = await findParticipantByName(sock, sender, queryName);
                    }
                    if (targetJid) {
                        const res = await sock.groupParticipantsUpdate(sender, [targetJid], "demote");
                        if (res && res[0] && res[0].status === "200") await sock.sendMessage(sender, { text: "✅ අදාළ සාමාජිකයා ඇඩ්මින් කමින් ඉවත් කරන ලදී." });
                        else await sock.sendMessage(sender, { text: "❌ ඇඩ්මින් කමින් ඉවත් කිරීමට නොහැකි විය." });
                    } else await sock.sendMessage(sender, { text: "❌ අදාළ තැනැත්තා සොයාගත නොහැක." });
                } catch (err) { await sock.sendMessage(sender, { text: "❌ දෝෂයක් සිදු විය." }); }
            }

            // 4. #JGIN - Add
            else if (command.startsWith("#JGIN")) {
                if (!isGroup) return await sock.sendMessage(sender, { text: "❌ මෙම විධානය ගෲප් වලට පමණි." });
                const queryName = rawText.replace(/^#JGIN\s*/i, "").trim();
                if (!queryName) return await sock.sendMessage(sender, { text: "❌ අංකයක් හෝ නමක් ලබා දෙන්න." });
                try {
                    let cleanNum = queryName.replace(/[^0-9]/g, '');
                    let targetJid = cleanNum ? `${cleanNum}@s.whatsapp.net` : null;
                    if (targetJid) {
                        const res = await sock.groupParticipantsUpdate(sender, [targetJid], "add");
                        if (res && res[0] && (res[0].status === "200" || res[0].status === "207")) {
                            await sock.sendMessage(sender, { text: `✅ අදාළ සාමාජිකයා ගෲප් එකට එකතු කරන ලදී.` });
                        } else {
                            await sock.sendMessage(sender, { text: "❌ සාමාජිකයා ඇඩ් කිරීමට නොහැකි විය." });
                        }
                    }
                } catch (err) { await sock.sendMessage(sender, { text: "❌ සාමාජිකයා ඇඩ් කිරීමට නොහැකි විය." }); }
            }

            // 5. #JK - Translator
            else if (command.startsWith("#JK")) {
                const quotedText = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
                                   msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text;
                if (!quotedText) return await sock.sendMessage(sender, { text: "❌ පරිවර්තනය කිරීමට මැසේජ් එකකට Reply කරන්න." });
                
                let targetLang = 'si';
                if (rawText.toLowerCase().includes('english') || rawText.toLowerCase().includes('en')) targetLang = 'en';

                const translated = await translateText(quotedText, targetLang);
                if (translated) await sock.sendMessage(sender, { text: `🔤 *පරිවර්තනය:* ${translated}` });
                else await sock.sendMessage(sender, { text: "❌ පරිවර්තනය කිරීමට නොහැකි විය." });
            }

            // 6. #JSH - Share Contact Card
            else if (command.startsWith("#JSH")) {
                try {
                    const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
                    let targetJid = quotedParticipant;
                    const queryName = rawText.replace(/^#JSH\s*/i, "").trim();
                    
                    if (!targetJid && queryName && isGroup) {
                        targetJid = await findParticipantByName(sock, sender, queryName);
                    }

                    if (targetJid) {
                        const num = targetJid.split('@')[0];
                        const nameToDisplay = queryName || num;
                        const vcard = 'BEGIN:VCARD\n' + 'VERSION:3.0\n' + `FN:${nameToDisplay}\n` + `TEL;type=CELL;type=VOICE;waid=${num}:+${num}\n` + 'END:VCARD';
                        await sock.sendMessage(sender, { contacts: { displayName: nameToDisplay, contacts: [{ vcard }] } });
                    } else {
                        await sock.sendMessage(sender, { text: "❌ අදාළ තැනැත්තා සොයාගත නොහැක." });
                    }
                } catch (err) { await sock.sendMessage(sender, { text: "❌ Contact එක යැවීමට නොහැකි විය." }); }
            }

            // 7. #JD - Delete Message (Fixed)
            else if (command === "#JD") {
                try {
                    const quoted = msg.message.extendedTextMessage?.contextInfo;
                    if (quoted && quoted.stanzaId) {
                        const targetMsgKey = {
                            remoteJid: sender,
                            id: quoted.stanzaId,
                            participant: quoted.participant
                        };
                        await sock.sendMessage(sender, { delete: targetMsgKey });
                    } else {
                        await sock.sendMessage(sender, { text: "❌ Delete කිරීමට මැසේජ් එකකට Reply කරන්න." });
                    }
                } catch (err) { await sock.sendMessage(sender, { text: "❌ මැසේජ් එක ඩිලීට් කිරීමට නොහැකි විය." }); }
            }

            // 8. #JGMT / #JGUM
            else if (command === "#JGMT") {
                if (!isGroup) return;
                await sock.groupSettingUpdate(sender, 'announcement');
                await sock.sendMessage(sender, { text: "🔒 ගෲප් එක මියුට් කරන ලදී." });
            }
            else if (command === "#JGUM") {
                if (!isGroup) return;
                await sock.groupSettingUpdate(sender, 'not_announcement');
                await sock.sendMessage(sender, { text: "🔓 ගෲප් එක අන්මියුට් කරන ලදී." });
            }

            // 9. #JCHK
            else if (command === "#JCHK") {
                try { await sock.chatModify({ delete: true, lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] }, sender); } catch (err) {}
            }

            // 10. #JIN - Songs
            else if (command.startsWith("#JIN")) {
                let songQuery = rawText.replace(/^#JIN\s*/i, "").trim();
                if (songQuery.toLowerCase().endsWith(" d")) songQuery = songQuery.slice(0, -2).trim();
                if (!songQuery) return await sock.sendMessage(sender, { text: "🎵 සින්දුවේ නම ලබා දෙන්න." });
                const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(songQuery + " mp3 song download")}`;
                await sock.sendMessage(sender, { text: `🎶 *Song Search*\n\n🔗 *Google Search:* ${googleSearchUrl}` });
            }

            // 11. #J - AI Assistant
            else if (command.startsWith("#J ") || command === "#J") {
                const promptText = rawText.replace(/^#J\s*/i, "").trim();
                if (!promptText) return await sock.sendMessage(sender, { text: "🤖 ප්‍රශ්නයක් ලියන්න." });
                await sock.sendMessage(sender, { text: "⏳ සිතමින් පවතී..." });

                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
                const aiResponse = await axios.post(apiUrl, { contents: [{ parts: [{ text: promptText }] }] });
                if (aiResponse.data?.candidates?.[0]) {
                    await sock.sendMessage(sender, { text: `🤖 *J.A.R.V.I.S.:*\n\n${aiResponse.data.candidates[0].content.parts[0].text}` });
                }
            }

            // 12. #J1
            else if (command === "#J1") {
                let ppUrl = await sock.profilePictureUrl(sender, 'image').catch(() => null);
                if (ppUrl) await sock.sendMessage(sender, { image: { url: ppUrl }, caption: "🖼️ DP එක!" });
            }

            // 13. #JS - Sticker
            else if (command === "#JS") {
                const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
                const direct = msg.message.imageMessage;
                if (!quoted && !direct) return;
                const tempIn = path.join(__dirname, `temp_stk_${Date.now()}.jpg`);
                const tempOut = path.join(__dirname, `temp_stk_${Date.now()}.webp`);
                try {
                    const buffer = await downloadMediaMessage(quoted ? { message: { imageMessage: quoted } } : msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                    fs.writeFileSync(tempIn, buffer);
                    exec(`ffmpeg -i "${tempIn}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(512-iw)/2:(512-ih)/2:color=0x00000000" -c:v libwebp "${tempOut}"`, async (err) => {
                        if (!err && fs.existsSync(tempOut)) await sock.sendMessage(sender, { sticker: fs.readFileSync(tempOut) });
                        try { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); } catch(e){}
                        try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch(e){}
                    });
                } catch (e) {}
            }

            // 14. #JSS - Status Saver
            else if (command === "#JSS") {
                const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quoted) return;
                const imgMsg = quoted.imageMessage || quoted.viewOnceMessageV2?.message?.imageMessage;
                const vidMsg = quoted.videoMessage || quoted.viewOnceMessageV2?.message?.videoMessage;
                if (imgMsg) {
                    const buffer = await downloadMediaMessage({ message: { imageMessage: imgMsg } }, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                    const savePath = path.join(mediaDir, `status_${Date.now()}.jpg`);
                    fs.writeFileSync(savePath, buffer);
                    await sock.sendMessage(sender, { image: { url: savePath }, caption: "📥 ස්ටේටස් ෆොටෝ එක සේව් විය!" });
                } else if (vidMsg) {
                    const buffer = await downloadMediaMessage({ message: { videoMessage: vidMsg } }, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
                    const savePath = path.join(mediaDir, `status_${Date.now()}.mp4`);
                    fs.writeFileSync(savePath, buffer);
                    await sock.sendMessage(sender, { video: { url: savePath }, caption: "📥 ස්ටේටස් වීඩියෝව සේව් විය!" });
                }
            }
        }
    });

    // Anti-delete (#JR mechanism)
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update?.message === null) {
                const keyStr = `${update.key.remoteJid}_${update.key.id}`;
                const original = messageStore.get(keyStr);
                if (original && !original.key.fromMe) {
                    const txt = original.message.conversation || original.message.extendedTextMessage?.text;
                    if (txt) await sock.sendMessage(update.key.remoteJid, { text: `🚨 *Anti-Delete (මකා දැමූ පණිවිඩය):*\n${txt}` });
                }
            }
        }
    });
}
connectToWhatsApp();

