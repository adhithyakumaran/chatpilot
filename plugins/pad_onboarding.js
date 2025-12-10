const moment = require("moment");
const Groq = require("groq-sdk");

const PAD_CLIENT_UID = "O4HNozcfDZRtj1K9d4LmvWLAx5d2";

// Initialize Groq with Round-Robin API Keys
const GROQ_API_KEYS = process.env.GROQ_API_KEYS.split(',');
let currentKeyIndex = 0;

function getNextGroqClient() {
    const apiKey = GROQ_API_KEYS[currentKeyIndex];
    const keyNumber = currentKeyIndex + 1;
    currentKeyIndex = (currentKeyIndex + 1) % GROQ_API_KEYS.length;
    console.log(`🔄 Period AI using Groq Key #${keyNumber}/${GROQ_API_KEYS.length}`);
    return new Groq({ apiKey });
}

async function handlePadOnboarding(sock, msg, text, uid, db) {
    // 🔒 SAFETY LOCK: Only run for the Pad Company
    console.log(`🔍 Plugin Check: Incoming UID [${uid}] vs Target [${PAD_CLIENT_UID}]`);

    // 🛑 1. STOP INFINITE LOOPS: Ignore messages sent by ME (the bot)
    if (msg.key.fromMe) {
        return false;
    }

    if (uid !== PAD_CLIENT_UID && uid !== "THE_REAL_UID_FROM_FIRESTORE") {
        console.log("❌ Plugin Skipped: UID Mismatch");
        return false;
    }

    // 🛑 2. CHECK GLOBALLY ENABLED FLAG (Toggle)
    const companyDoc = await db.collection('companies').doc(uid).get();
    const periodPluginEnabled = companyDoc.exists ? companyDoc.data().periodPluginEnabled : false;

    if (!periodPluginEnabled) {
        console.log("⏸️ Period AI is DISABLED (Toggle OFF). Letting Generic AI handle it.");
        return false;
    }

    const userPhone = msg.key.remoteJid.split('@')[0];
    const userRef = db.collection("companies").doc(uid).collection("period_tracker_users").doc(userPhone);

    // ---------------------------------------------------------
    // 1. CHECK IF USER IS ALREADY A PERIOD TRACKER CUSTOMER
    // --------------------------------------------------------
    const doc = await userRef.get();

    if (doc.exists) {
        const userData = doc.data();
        console.log(`🌸 Period AI handling message from ${userData.name}`);

        try {
            const prompt = `You are a kind, empathetic, and sisterly women's health assistant for a Period Care Brand.
            
**User Profile:**
- Name: ${userData.name}
- Last Period: ${moment(userData.last_period.toDate()).format('YYYY-MM-DD')}
- Next Period Prediction: ${moment(userData.next_period.toDate()).format('YYYY-MM-DD')}
- Reported Issues: ${userData.health_issue}
- Tag: ${userData.tag || "Customer"}

**User's Message:** "${text}"

**Instructions:**
1. If they ask about their dates, provide the info clearly.
2. If they mention pain, cramps, or mood swings, offer a brief, non-medical home remedy or comforting words.
3. Keep it short (under 3 sentences) and warm.
4. Do not act like a generic bot. Be a supportive friend.`;

            const groq = getNextGroqClient(); // Round-robin key selection
            const chatCompletion = await groq.chat.completions.create({
                messages: [{ role: "user", content: prompt }],
                model: "llama-3.3-70b-versatile",
                temperature: 0.7,
                max_tokens: 256
            });

            const response = chatCompletion.choices[0]?.message?.content || "I'm here for you! ❤️";
            await sock.sendMessage(msg.key.remoteJid, { text: response });

        } catch (e) {
            console.error("Period AI Logic Error:", e.message);
            await sock.sendMessage(msg.key.remoteJid, { text: "I'm here for you! ❤️ Check your app for cycle details or ask me again." });
        }

        return true; // 🛑 RETURN TRUE TO STOP GENERIC AI
    }

    // ---------------------------------------------------------
    // 2. NEW USER: ONBOARDING TRIGGER (QR SCAN)
    // ---------------------------------------------------------
    const cleanText = text.toLowerCase();

    if (cleanText.includes("scanned the qr") || cleanText.includes("scan") || cleanText.includes("qr code")) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "Welcome to the family! 🌸\n\nTo activate your warranty and get your discount, please reply with your details in this format:\n\n*Name, Last Period Date (YYYY-MM-DD), Any Issues*\n\nExample:\n*Avni, 2024-12-01, severe cramps*"
        });
        return true;
    }

    // ---------------------------------------------------------
    // 3. NEW USER: PROCESSING REGISTRATION FORM
    // ---------------------------------------------------------
    const dateRegex = /(\d{4}-\d{2}-\d{2})/;
    const dateMatch = text.match(dateRegex);

    if (dateMatch) {
        const parts = text.split(',');
        let name = parts[0] ? parts[0].trim() : "Friend";
        const dateStr = dateMatch[0];
        const issue = parts.length > 2 ? parts.slice(2).join(',').trim() : "general wellbeing";

        if (name.includes(dateStr) || name.match(/\d{4}-\d{2}-\d{2}/)) {
            name = "Friend";
        }

        const lastDate = moment(dateStr);
        if (!lastDate.isValid()) {
            await sock.sendMessage(msg.key.remoteJid, { text: "Oops! Date format should be YYYY-MM-DD. Please try again." });
            return true;
        }

        const nextPeriod = lastDate.clone().add(28, 'days');
        const reminderDate = nextPeriod.clone().subtract(3, 'days');

        await userRef.set({
            name: name,
            phone: userPhone,
            last_period: lastDate.toDate(),
            next_period: nextPeriod.toDate(),
            reminder_date: reminderDate.toDate(),
            health_issue: issue,
            joined_at: new Date(),
            source: "qr_scan",
            tag: "Customer"
        });

        let advice = "Stay hydrated and rest well.";
        try {
            const groq = getNextGroqClient(); // Round-robin key selection
            const chatCompletion = await groq.chat.completions.create({
                messages: [{ role: "user", content: `User has "${issue}". Give 1 sentence of warm, non-medical home remedy advice.` }],
                model: "llama-3.3-70b-versatile",
                temperature: 0.7,
                max_tokens: 128
            });
            advice = chatCompletion.choices[0]?.message?.content || advice;
        } catch (e) { }

        const finalMessage = `All set, ${name}! You are registered as a *Customer* ✅\n\n` +
            `📅 *Next Cycle:* ~${nextPeriod.format("DD MMM")}\n` +
            `🔔 I'll remind you 3 days before.\n\n` +
            `💡 *Tip:* ${advice}\n\n` +
            `🎁 Use code *PADS20* for 20% off!`;

        await sock.sendMessage(msg.key.remoteJid, { text: finalMessage });
        return true;
    }

    return false;
}

module.exports = { handlePadOnboarding };