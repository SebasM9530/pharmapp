import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import axios from "axios";
import { createRequire } from "module";

// ── Fix definitivo pdf-parse con ES Modules ──
// pdf-parse@1.1.1 exporta la función directamente, hay que importarla así:
const require = createRequire(import.meta.url);
const pdfParseRaw = require("pdf-parse");
const pdfParse = pdfParseRaw.default ?? pdfParseRaw;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

// ── MODELO: llama-4-scout (más tokens/día, más rápido) ──
const GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

// ── STORAGE RAG ──
let globalChunks = [];

// ── MULTER ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ── HELPERS ──
function chunkText(text, size = 800) {
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += size)
    chunks.push(words.slice(i, i + size).join(" "));
  return chunks;
}

function findRelevantChunks(query, chunks, max = 4) {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 3);
  if (!terms.length || !chunks.length) return [];
  return chunks
    .map(c => ({
      c,
      s: terms.reduce((acc, t) => acc + (c.toLowerCase().match(new RegExp(t, "g")) || []).length, 0)
    }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map(x => x.c);
}

// ── GROQ ──
async function callGroq(system, user, temperature = 0.4) {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user }
      ],
      temperature,
      max_tokens: 4096
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 60000
    }
  );
  return res.data.choices[0].message.content;
}

// ═══════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════

app.get("/api/health", (req, res) => res.json({ ok: true, model: GROQ_MODEL }));

// ── Subir PDF ──
app.post("/api/upload", upload.single("file"), async (req, res) => {
  console.log("📥 /api/upload →", req.file?.originalname ?? "sin archivo");
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió archivo." });
    }

    const filePath = req.file.path;
    const buffer   = fs.readFileSync(filePath);
    fs.unlinkSync(filePath);

    // ── Extraer texto con pdf-parse ──
    let text = "";
    try {
      const parsed = await pdfParse(buffer);
      text = parsed.text ?? "";
      console.log(`   ✅ pdf-parse OK: ${text.length} chars, ${parsed.numpages} páginas`);
    } catch (parseErr) {
      console.error("   ❌ pdf-parse falló:", parseErr.message);
      return res.status(400).json({
        error: "No se pudo leer el PDF. Si es un PDF escaneado (imagen), súbelo como foto JPG/PNG directamente."
      });
    }

    if (!text || text.trim().length < 50) {
      return res.status(400).json({
        error: "El PDF no contiene texto seleccionable (puede ser escaneado). Prueba subiéndolo como imagen JPG/PNG."
      });
    }

    // Guardar chunks para RAG
    const newChunks = chunkText(text, 800);
    globalChunks.push(...newChunks);
    console.log(`   Chunks nuevos: ${newChunks.length} | Total: ${globalChunks.length}`);

    // Analizar con Groq
    console.log(`   Enviando a Groq (${GROQ_MODEL})...`);
    const resumen = await callGroq(
      "Eres experto en farmacología clínica y química farmacéutica. Analizas apuntes universitarios de medicina. Respondes siempre en español.",
      `Analiza estos apuntes de farmacología universitaria y genera un resumen estructurado.
Usa ÚNICAMENTE estas etiquetas HTML: <h4>, <strong>, <ul>, <li>, <p>

APUNTES:
${text.slice(0, 6000)}

Responde con esta estructura exacta:
<h4>💊 Medicamentos mencionados</h4>
<ul>
  <li><strong>NombreFármaco</strong>: indicación o contexto en que aparece</li>
</ul>

<h4>🔬 Conceptos farmacológicos clave</h4>
<ul>
  <li><strong>Concepto</strong>: descripción encontrada en los apuntes</li>
</ul>

<h4>📌 Puntos importantes para el examen</h4>
<ul>
  <li>punto clave específico extraído de los apuntes</li>
</ul>

<p><strong>Páginas procesadas:</strong> todo el documento. <strong>Consejo:</strong> usa estos conceptos en el buscador de Flashcards.</p>

S� específico con lo que encuentras en los apuntes. Responde en español.`
    );
    console.log("   ✅ Groq respondió OK");

    res.json({
      message: "PDF procesado correctamente",
      charCount: text.length,
      pages: text.split("\f").length,
      totalChunks: globalChunks.length,
      resumen
    });

  } catch (err) {
    console.error("❌ /api/upload:", err.message);
    res.status(500).json({ error: "Error: " + err.message });
  }
});

// ── TXT ──
app.post("/api/analyze-text", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "Texto vacío" });

    globalChunks.push(...chunkText(text, 800));
    const resumen = await callGroq(
      "Eres experto en farmacología. Respondes en español con HTML limpio.",
      `Analiza estos apuntes. Usa <h4>, <strong>, <ul>, <li>, <p>:\n\n${text.slice(0, 6000)}\n\nIncluye: medicamentos, conceptos clave, puntos de examen.`
    );
    res.json({ resumen, charCount: text.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Limpiar ──
app.post("/api/clear-notes", (req, res) => {
  globalChunks = [];
  res.json({ ok: true });
});

// ── Flashcards ──
app.post("/api/flashcards", async (req, res) => {
  try {
    const { drug } = req.body;
    if (!drug) return res.status(400).json({ error: "Fármaco requerido" });

    const chunks = findRelevantChunks(drug, globalChunks, 4);
    const ctx = chunks.length
      ? `\n\nINFO DE LOS APUNTES DE LA ESTUDIANTE sobre ${drug}:\n${chunks.join("\n---\n")}`
      : "";

    const raw = await callGroq(
      "Eres farmacólogo clínico experto. Respondes SIEMPRE en español con JSON puro válido, sin markdown, sin texto antes ni después.",
      `Genera información farmacológica completa sobre: ${drug}${ctx}

Responde ÚNICAMENTE con este JSON, sin texto adicional, sin \`\`\`:
{"nombre":"nombre oficial","familia":"grupo farmacológico","cards":[
{"titulo":"Mecanismo de Acción","icono":"⚙️","color":"teal","contenido":"mecanismo molecular, receptor o enzima diana","enApuntes":false,"notaApuntes":""},
{"titulo":"Espectro / Clasificación","icono":"🔭","color":"purple","contenido":"clasificación y espectro","enApuntes":false,"notaApuntes":""},
{"titulo":"Indicaciones Clínicas","icono":"✅","color":"gold","contenido":"usos aprobados con contexto clínico","enApuntes":false,"notaApuntes":""},
{"titulo":"Contraindicaciones","icono":"🚫","color":"red","contenido":"absolutas y relativas más importantes","enApuntes":false,"notaApuntes":""},
{"titulo":"Interacciones Farmacológicas","icono":"⚡","color":"purple","contenido":"interacciones clínicamente relevantes","enApuntes":false,"notaApuntes":""},
{"titulo":"Reacciones Adversas (RAM)","icono":"⚠️","color":"gold","contenido":"efectos adversos por frecuencia e importancia","enApuntes":false,"notaApuntes":""},
{"titulo":"Farmacocinética (ADME)","icono":"📊","color":"teal","contenido":"absorción, distribución, metabolismo (CYP si aplica), excreción, vida media","enApuntes":false,"notaApuntes":""},
{"titulo":"Dosis y Presentaciones","icono":"💊","color":"gold","contenido":"dosis adultos habituales, vías, presentaciones","enApuntes":false,"notaApuntes":""}
]}
Si algo coincide con apuntes: enApuntes=true y notaApuntes=qué dice la estudiante exactamente.`,
      0.3
    );

    const clean = raw.replace(/```json|```/g, "").trim();
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Respuesta no válida de la IA. Intenta de nuevo.");
    res.json(JSON.parse(m[0]));

  } catch (err) {
    console.error("❌ /api/flashcards:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ── Quiz ──
app.post("/api/quiz", async (req, res) => {
  try {
    const { drugs, count = 10, difficulty = "intermedia", type = "mixto" } = req.body;
    if (!drugs) return res.status(400).json({ error: "Medicamentos requeridos" });

    const chunks = findRelevantChunks(drugs, globalChunks, 3);
    const ctx = chunks.length
      ? `\nApuntes de la estudiante:\n${chunks.join("\n---\n").slice(0, 1500)}`
      : "";

    const diffMap = {
      basica:     "básico: definiciones y conceptos directos",
      intermedia: "intermedio: aplicación clínica y mecanismos",
      avanzada:   "avanzado estilo MIR/USMLE: casos clínicos complejos con razonamiento diagnóstico-terapéutico"
    };
    const typeMap = {
      mixto:         "variadas (mecanismo, indicaciones, RAM, interacciones, farmacocinética)",
      mecanismo:     "mecanismos de acción y targets moleculares",
      clinico:       "casos clínicos con presentación completa del paciente",
      interacciones: "interacciones farmacológicas, RAM y toxicología"
    };

    const raw = await callGroq(
      "Docente experto en farmacología. Preguntas estilo MIR/USMLE. Responde ÚNICAMENTE con JSON válido sin markdown.",
      `Genera exactamente ${count} preguntas sobre: ${drugs}
Dificultad: ${diffMap[difficulty]}. Tipo: ${typeMap[type]}.${ctx}

Responde ÚNICAMENTE con JSON array, sin texto extra, sin \`\`\`:
[{"pregunta":"enunciado con contexto clínico completo","fuente":"Goodman & Gilman 14ª Ed. / Katzung 15ª Ed. / Rang & Dale 9ª Ed. / NEJM / Lancet","opciones":["A completa","B completa","C completa","D completa"],"respuesta":0,"explicacion":"por qué es correcta y por qué las otras no, con mecanismo"}]
Exactamente 4 opciones, 1 correcta (0-3), español técnico.`,
      0.5
    );

    const clean = raw.replace(/```json|```/g, "").trim();
    const m = clean.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("La IA no devolvió preguntas válidas. Intenta de nuevo.");
    const questions = JSON.parse(m[0]);
    if (!Array.isArray(questions) || !questions.length) throw new Error("No se generaron preguntas.");
    res.json(questions);

  } catch (err) {
    console.error("❌ /api/quiz:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 PharmaChem → http://localhost:${PORT}`);
  console.log(`🤖 Modelo: ${GROQ_MODEL}`);
  console.log(`🔑 Groq: ${process.env.GROQ_API_KEY ? "✅ OK" : "❌ Falta GROQ_API_KEY en .env"}\n`);
});
