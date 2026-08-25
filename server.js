import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const modelName = process.env.GEMINI_MODEL || "gemini-1.5-flash";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const sessions = new Map();

// Canonical structural schemas matching public Quran/Hadith APIs
const cachedGeminiTools = [{
  functionDeclarations: [
    {
      name: "get_quran_verse",
      description: "Get a specific Quran verse with Arabic text and English translation.",
      parameters: {
        type: "object",
        properties: {
          surah: { type: "number", description: "Surah number (1-114)" },
          ayah:  { type: "number", description: "Ayah number within the surah" }
        },
        required: ["surah", "ayah"]
      }
    },
    {
      name: "search_quran",
      description: "Search the Quran by keyword or phrase to find relevant verses.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword or phrase to search for" }
        },
        required: ["query"]
      }
    },
    {
      name: "get_tafsir",
      description: "Get tafsir Ibn Kathir commentary for a specific Quran verse.",
      parameters: {
        type: "object",
        properties: {
          surah: { type: "number", description: "Surah number (1-114)" },
          ayah:  { type: "number", description: "Ayah number within the surah" }
        },
        required: ["surah", "ayah"]
      }
    },
    {
      name: "get_hadith",
      description: "Get a specific Hadith from Sahih Bukhari or Sahih Muslim.",
      parameters: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Collection: bukhari or muslim" },
          hadith_number: { type: "number", description: "Hadith number" }
        },
        required: ["collection", "hadith_number"]
      }
    }
  ]
}];

// Fetch with automatic retries — external APIs (alquran.cloud) fail randomly
async function fetchWithRetry(url, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status} from ${url}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
  }
  throw lastError;
}

// Direct API implementations — calls public APIs, no remote MCP server needed
async function executeTool(toolName, toolArgs) {
  switch (toolName) {

    case "get_quran_verse": {
      const { surah, ayah } = toolArgs;
      const [arabicRes, translationRes] = await Promise.all([
        fetchWithRetry(`https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/ar.alafasy`),
        fetchWithRetry(`https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/en.sahih`)
      ]);
      const arabic = await arabicRes.json();
      const translation = await translationRes.json();
      return `Surah ${surah}:${ayah}\nArabic: ${arabic.data.text}\nTranslation: ${translation.data.text}`;
    }

    case "search_quran": {
      const { query } = toolArgs;
      const res = await fetchWithRetry(`https://api.alquran.cloud/v1/search/${encodeURIComponent(query)}/all/en.sahih`);
      const data = await res.json();
      const matches = (data.data?.matches || []).slice(0, 5);
      if (!matches.length) return "No verses found for that query.";
      return matches.map(m => `${m.surah.englishName} ${m.surah.number}:${m.numberInSurah} — ${m.text}`).join("\n\n");
    }

    case "get_tafsir": {
      const { surah, ayah } = toolArgs;
      const res = await fetchWithRetry(`https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/en-tafisr-ibn-kathir/${surah}/${ayah}.json`);
      const data = await res.json();
      return `Tafsir Ibn Kathir — ${surah}:${ayah}\n${data.text || "No tafsir available."}`;
    }

    case "get_hadith": {
      const { collection, hadith_number } = toolArgs;
      const col = collection.toLowerCase() === "muslim" ? "muslim" : "bukhari";
      const res = await fetchWithRetry(`https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/eng-${col}/${hadith_number}.json`);
      const data = await res.json();
      const hadith = data.hadiths?.[0];
      return hadith ? `${collection} #${hadith_number}: ${hadith.text}` : "Hadith not found.";
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// Rejects after ms milliseconds — used with Promise.race to hard-cancel hung awaits
function hardTimeout(ms, msg) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(msg)), ms)
  );
}

// Keep only valid parts (text, functionCall, functionResponse) and preserve
// thoughtSignature. Drops empty "thought" parts whose uninitialized `data`
// field otherwise corrupts every later Gemini request.
function sanitizeParts(parts) {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter(p => p && (p.text != null || p.functionCall || p.functionResponse))
    .map(p => {
      if (p.functionCall) {
        const out = { functionCall: p.functionCall };
        if (p.thoughtSignature) out.thoughtSignature = p.thoughtSignature;
        return out;
      }
      if (p.functionResponse) return { functionResponse: p.functionResponse };
      return { text: p.text };
    });
}

app.post("/api/chat", async (req, res) => {
  let history;
  const historyLengthBefore = { value: 0 };
  try {
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    const activeSessionId = sessionId || "default-session";
    if (!sessions.has(activeSessionId)) sessions.set(activeSessionId, []);
    history = sessions.get(activeSessionId);
    historyLengthBefore.value = history.length;
    history.push({ role: "user", parts: [{ text: message }] });

    // Step 1: Gemini call (timeout disabled for testing)
    let response = await ai.models.generateContent({
      model: modelName,
      contents: history,
      config: {
        tools: cachedGeminiTools,
        systemInstruction: process.env.SYSTEM_INSTRUCTION,
        toolConfig: { functionCallingConfig: { mode: "AUTO" } }
      }
    });

    // TOOL LOOP: handles combined questions needing multiple tools.
    // Each round may contain one or several parallel functionCalls.
    const MAX_TOOL_ROUNDS = 5;
    let rounds = 0;

    while (response.functionCalls && response.functionCalls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const calls = response.functionCalls;
      console.log(`[TOOL ROUND ${rounds}] Executing ${calls.length} tool(s): ${calls.map(c => c.name).join(", ")}`);

      // Preserve original model parts (includes thought_signature required by Gemini)
      history.push({
        role: "model",
        parts: sanitizeParts(response.candidates[0].content.parts)
      });

      // Execute ALL requested tools; failures become error strings so the
      // model can still compose a partial answer instead of crashing.
      const responseParts = [];
      for (const call of calls) {
        let resultText;
        try {
          resultText = await executeTool(call.name, call.args);
        } catch (toolErr) {
          console.error(`[TOOL ERROR] ${call.name}:`, toolErr.message);
          resultText = `Error: could not retrieve data for ${call.name} (${toolErr.message}).`;
        }
        if (typeof resultText !== "string" || !resultText.trim()) {
          resultText = `No data returned by ${call.name}.`;
        }
        responseParts.push({
          functionResponse: { name: call.name, response: { result: resultText } }
        });
      }
      history.push({ role: "user", parts: responseParts });

      // Ask Gemini again — AUTO lets it chain more tools for combined questions,
      // final round forces NONE so we always end with text.
      const isLastRound = rounds >= MAX_TOOL_ROUNDS;
      response = await ai.models.generateContent({
        model: modelName,
        contents: history,
        config: {
          tools: cachedGeminiTools,
          systemInstruction: process.env.SYSTEM_INSTRUCTION,
          toolConfig: { functionCallingConfig: { mode: isLastRound ? "NONE" : "AUTO" } }
        }
      });
    }

    // GUARANTEED TEXT EXTRACTION: response.text can be undefined if parts are
    // mixed — concatenate all text parts manually as fallback.
    let finalText = response.text;
    if (!finalText || !finalText.trim()) {
      const parts = response.candidates?.[0]?.content?.parts || [];
      finalText = parts.filter(p => p.text).map(p => p.text).join("\n").trim();
    }
    if (!finalText) {
      finalText = rounds > 0
        ? "I retrieved the data but couldn't compose a reply. Please retry."
        : "I can only process Quranic text queries.";
    }

    history.push({ role: "model", parts: [{ text: finalText }] });
    res.json({ reply: finalText, sessionId: activeSessionId });

  } catch (error) {
    // Roll back any partial history from this failed request so the next request isn't corrupted
    if (history) history.length = historyLengthBefore.value;
    console.error("[CRASH FILTER INTERCEPTED]", error.message);
    if (!res.headersSent) {
      res.status(504).json({ error: error.message || "Request failed. Please retry." });
    }
  }
});

app.listen(port, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Quran Finder Service Active on Port ${port}!`);
  console.log(`🌍 URL endpoint open: http://localhost:${port}`);
  console.log(`======================================================\n`);
});
